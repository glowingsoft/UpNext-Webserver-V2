require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const Card = require("@models/Card");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let booking, intent, calls, confirmation, raceConfirmed;
const stripe = { paymentIntents: {
  create: async (params, options) => { calls.create = { params, options }; return intent; },
  retrieve: async () => intent,
  confirm: async (id, params, options) => { calls.confirm = { id, params, options }; return intent; },
  cancel: async () => { calls.cancel++; intent = { ...intent, status: "canceled" }; return intent; },
} };
stub("@config/stripe", stripe);
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: (data) => calls.notifications.push(data) });
stub("@socketIo/instantOfferSocketEmitter", { emitBookingPaymentUpdated: (data) => calls.signals.push(data) });
stub("../backend/app/services/bookingConfirmation", {
  confirmAuthorizedBooking: async () => {
    if (confirmation === "confirmed") booking.status = "confirmed";
    return { status: confirmation, booking };
  },
});
stub("../backend/app/services/bookingStateMachine", {
  transitionBooking: async ({ reason }) => {
    booking.status = "canceled"; booking.cancelReason = reason; booking.authorization.cleanupPending = true;
    return booking;
  },
});
const { resolveAuthorization, fixBookingPayment, cancelPaymentWindow } = require("../backend/app/services/bookingAuthorization");
const original = { find: Booking.findOne, update: Booking.updateOne, findUpdate: Booking.findOneAndUpdate,
  payment: Payment.updateOne, user: User.findById, profile: BusinessProfile.findById, card: Card.findOne };
const setup = () => {
  calls = { cancel: 0, notifications: [], signals: [], finds: 0, paymentUpdates: [] };
  confirmation = "confirmed"; raceConfirmed = false;
  booking = { _id: "booking", user: "customer", business: "business", status: "accepted_awaiting_payment",
    awaitingPaymentDeadline: new Date(Date.now() + 300000), pricing: { totalCents: 5700, heldCents: 0 },
    paymentStatus: "pending",
    authorization: { offerId: "offer", initialPaymentMethodId: "pm_test", paymentMethodId: "pm_test",
      confirmKey: "booking-auth-offer", confirmMode: "off_session", needsFix: false, cleanupPending: false } };
  intent = { id: "pi_test", status: "requires_capture", amount: 5700, amount_capturable: 5700,
    currency: "usd", customer: "cus_test", payment_method: "pm_test" };
  Booking.findOne = (filter) => ({ lean: async () => {
    calls.finds++;
    if (raceConfirmed && calls.finds === 2) { booking.status = "confirmed"; return null; }
    if (filter.status && booking.status !== filter.status) return null;
    if (filter["authorization.cleanupPending"] && !booking.authorization.cleanupPending) return null;
    if (filter.user && filter.user !== booking.user) return null;
    return booking;
  } });
  Booking.findOneAndUpdate = (filter, update) => ({ lean: async () => {
    if (booking.status !== filter.status) return null;
    for (const [key, value] of Object.entries(update.$set)) {
      if (key.startsWith("authorization.")) booking.authorization[key.slice(14)] = value;
      else if (key.startsWith("pricing.")) booking.pricing[key.slice(8)] = value;
      else booking[key] = value;
    }
    return booking;
  } });
  Booking.updateOne = async (filter, update) => {
    for (const [key, value] of Object.entries(update.$set || {})) {
      if (key.startsWith("authorization.")) booking.authorization[key.slice(14)] = value;
      else if (key.startsWith("pricing.")) booking.pricing[key.slice(8)] = value;
      else booking[key] = value;
    }
  };
  Payment.updateOne = async (filter, update, options) => calls.paymentUpdates.push({ filter, update, options });
  User.findById = () => ({ lean: async () => ({ stripe: { customerId: "cus_test" } }) });
  BusinessProfile.findById = () => ({ lean: async () => ({ user: "provider" }) });
  Card.findOne = () => ({ lean: async () => ({ expMonth: 12, expYear: 2999 }) });
};

test("authorizes on the platform and confirms only after verifying the full amount", async () => {
  setup();
  const result = await resolveAuthorization("booking");
  assert.equal(result.data.status, "confirmed");
  assert.equal(calls.create.params.capture_method, "manual");
  assert.equal(calls.create.params.confirm, undefined);
  assert.equal(calls.create.params.transfer_data, undefined);
  assert.equal(calls.create.params.application_fee_amount, undefined);
  assert.equal(calls.create.options.idempotencyKey, "booking-intent-offer");
  assert.equal(booking.pricing.heldCents, 5700);
  assert.equal(calls.paymentUpdates[0].options.upsert, true);
  assert.deepEqual(calls.signals.map(({ userId, bookingStatus, paymentStatus }) =>
    ({ userId, bookingStatus, paymentStatus })), [
    { userId: "customer", bookingStatus: "confirmed", paymentStatus: "authorized" },
    { userId: "provider", bookingStatus: "confirmed", paymentStatus: "authorized" },
  ]);
  assert.ok(calls.signals.every((signal) => signal.bookingId === "booking" && signal.offerId === "offer"));
});

test("off-session confirmation uses a stable idempotency key and notifies the customer when 3DS is needed", async () => {
  setup();
  intent = { ...intent, status: "requires_confirmation" };
  stripe.paymentIntents.confirm = async (id, params, options) => {
    calls.confirm = { id, params, options };
    return { ...intent, status: "requires_action" };
  };
  try {
    const result = await resolveAuthorization("booking");
    assert.equal(result.data.paymentStatus, "requires_payment_fix");
    assert.equal(calls.confirm.params.off_session, true);
    assert.equal(calls.confirm.options.idempotencyKey, "booking-auth-offer");
    assert.equal(calls.notifications.length, 1);
    assert.deepEqual(calls.signals.map((signal) => signal.paymentStatus), ["requires_payment_fix", "requires_payment_fix"]);
    assert.ok(calls.signals.every((signal) => signal.bookingStatus === "accepted_awaiting_payment"));
    assert.equal(result.data.clientSecret, undefined);
  } finally {
    stripe.paymentIntents.confirm = async (id, params, options) => { calls.confirm = { id, params, options }; return intent; };
  }
});

test("a declined card leaves the booking in the payment window", async () => {
  setup();
  intent = { ...intent, status: "requires_confirmation" };
  const confirm = stripe.paymentIntents.confirm;
  stripe.paymentIntents.confirm = async () => {
    intent = { ...intent, status: "requires_payment_method" };
    throw Object.assign(new Error("card declined"), { type: "StripeCardError" });
  };
  try {
    const result = await resolveAuthorization("booking");
    assert.equal(result.data.paymentStatus, "requires_payment_fix");
    assert.equal(booking.authorization.needsFix, true);
    assert.equal(booking.status, "accepted_awaiting_payment");
    assert.equal(calls.cancel, 0);
  } finally { stripe.paymentIntents.confirm = confirm; }
});

test("missing customer payment setup signals that payment needs fixing", async () => {
  setup();
  User.findById = () => ({ lean: async () => ({ stripe: {} }) });
  const result = await resolveAuthorization("booking");
  assert.equal(result.data.paymentStatus, "requires_payment_fix");
  assert.deepEqual(calls.signals.map((signal) => signal.userId), ["customer", "provider"]);
  assert.ok(calls.signals.every((signal) => signal.paymentStatus === "requires_payment_fix"));
});

test("provider lookup failure does not undo confirmation or hide the customer signal", async () => {
  setup();
  BusinessProfile.findById = () => ({ lean: async () => { throw new Error("database unavailable"); } });
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const result = await resolveAuthorization("booking");
    assert.equal(result.data.status, "confirmed");
    assert.deepEqual(calls.signals.map((signal) => signal.userId), ["customer"]);
    assert.match(errors[0][0], /provider lookup failed/);
  } finally { console.error = originalError; }
});

test("a replacement card can be confirmed after a decline", async () => {
  setup(); booking.authorization.needsFix = true; booking.authorization.intentId = "pi_test";
  booking.authorization.customerId = "cus_test";
  intent = { ...intent, status: "requires_payment_method" };
  const confirm = stripe.paymentIntents.confirm;
  stripe.paymentIntents.confirm = async (id, params, options) => {
    calls.confirm = { id, params, options };
    return { ...intent, status: "requires_capture", payment_method: params.payment_method };
  };
  try {
    const result = await fixBookingPayment({ bookingId: "booking", userId: "customer", paymentMethodId: "pm_new" });
    assert.equal(result.data.status, "confirmed");
    assert.equal(calls.confirm.params.payment_method, "pm_new");
    assert.equal(calls.confirm.params.off_session, false);
  } finally { stripe.paymentIntents.confirm = confirm; }
});

test("a concurrent confirmation never cancels the confirmed booking's authorization", async () => {
  setup(); raceConfirmed = true;
  assert.equal((await resolveAuthorization("booking")).status, 409);
  assert.equal(calls.cancel, 0);
});

test("a payment inserted after timeout cleanup is marked released", async () => {
  setup();
  const findAndUpdate = Booking.findOneAndUpdate;
  Booking.findOneAndUpdate = (filter, update, options) => {
    if (update.$set.payment) {
      booking.status = "canceled";
      booking.paymentStatus = "released";
      booking.authorization.cleanupPending = false;
      return { lean: async () => null };
    }
    return findAndUpdate(filter, update, options);
  };
  const result = await resolveAuthorization("booking");
  assert.equal(result.status, 409);
  assert.equal(calls.paymentUpdates.length, 2);
  assert.equal(calls.paymentUpdates[1].update.$set.status, "released");
});

test("a full slot cancels the authorization and never reports confirmation", async () => {
  setup(); confirmation = "slot_taken";
  const result = await resolveAuthorization("booking");
  assert.equal(result.data.cancelReason, "slot_taken");
  assert.equal(calls.cancel, 1);
  assert.equal(calls.signals.length, 0);
  assert.equal(booking.authorization.cleanupPending, false);
  assert.equal(booking.paymentStatus, "released");
});

test("expired payment windows are canceled and release even a recovered intent", async () => {
  setup(); booking.awaitingPaymentDeadline = new Date(Date.now() - 1);
  booking.authorization.customerId = "cus_test";
  assert.equal((await resolveAuthorization("booking")).status, 409);
  assert.equal(booking.cancelReason, "payment_timeout");
  assert.equal(calls.cancel, 1);
  assert.equal(calls.create.options.idempotencyKey, "booking-intent-offer");
  assert.equal(calls.notifications[0].recipientIds[0], "provider");
});

test("payment-fix details are restricted to the booking customer", async () => {
  setup(); booking.authorization.needsFix = true;
  assert.equal((await fixBookingPayment({ bookingId: "booking", userId: "other" })).status, 409);
});

test("customer can cancel during the payment window and releases the hold", async () => {
  setup(); booking.authorization.intentId = "pi_test";
  const result = await cancelPaymentWindow({ bookingId: "booking", userId: "customer" });
  assert.equal(result.data.cancelReason, "client");
  assert.equal(calls.cancel, 1);
  assert.equal(booking.paymentStatus, "released");
  assert.equal(calls.notifications[0].recipientIds[0], "provider");
});

test("a failed release remains pending for recovery", async () => {
  setup(); booking.authorization.intentId = "pi_test";
  const cancel = stripe.paymentIntents.cancel;
  stripe.paymentIntents.cancel = async () => { throw new Error("network error"); };
  try {
    await assert.rejects(cancelPaymentWindow({ bookingId: "booking", userId: "customer" }), /network error/);
    assert.equal(booking.authorization.cleanupPending, true);
    assert.equal(booking.status, "canceled");
  } finally { stripe.paymentIntents.cancel = cancel; }
});

test("changing cards while a challenge is active does not return the old card's secret", async () => {
  setup(); booking.authorization.needsFix = true; booking.authorization.intentId = "pi_test";
  intent = { ...intent, status: "requires_action", client_secret: "secret" };
  const result = await fixBookingPayment({ bookingId: "booking", userId: "customer", paymentMethodId: "pm_new" });
  assert.equal(result.error, "instant_authentication_in_progress");
  assert.equal(booking.authorization.paymentMethodId, "pm_test");
  const same = await fixBookingPayment({ bookingId: "booking", userId: "customer", paymentMethodId: "pm_test" });
  assert.equal(same.data.clientSecret, "secret");
});

test.after(() => {
  Booking.findOne = original.find; Booking.updateOne = original.update; Booking.findOneAndUpdate = original.findUpdate;
  Payment.updateOne = original.payment; User.findById = original.user; BusinessProfile.findById = original.profile;
  Card.findOne = original.card;
});
