require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const Payment = require("@models/Payment");
const { User } = require("@models/UserModel");

const calls = { transfers: [], updates: [], deductions: 0, debtSyncs: 0 };
const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub("@config/stripe", {
  paymentIntents: {
    capture: async () => { throw new Error("capture failed"); },
    retrieve: async () => ({
      status: "succeeded", amount_received: 10700,
      latest_charge: { id: "ch_retrieved", balance_transaction: { fee: 351 } },
    }),
  },
  transfers: {
    list: async () => ({ data: [] }),
    create: async (params, options) => {
      calls.transfers.push({ params, options });
      return { id: "tr_test" };
    },
  },
});
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("../backend/commonModules/chatModule/services/conversationGateService", { openOrReopenConversationForBooking: async () => {} });
stub("../backend/app/services/paymentService", {
  applyDebtLock: async () => {},
  syncDebtLock: async () => { calls.debtSyncs++; },
});
stub("../backend/app/services/penaltyService", {
  consumeDeductions: async () => {
    calls.deductions++;
    return { totalCents: 0, applied: [] };
  },
  restoreDeductions: async () => {},
});
stub("../backend/app/services/instantOfferService", { instantEvents: new EventEmitter() });

const { payProvider, runCapture } = require("../backend/app/services/instantPaymentService");
const original = {
  findOneAndUpdate: Booking.findOneAndUpdate,
  updateOne: Booking.updateOne,
  profile: BusinessProfile.findById,
  user: User.findById,
  payment: Payment.findById,
  booking: Booking.findById,
};

const prepare = (capture) => {
  calls.transfers.length = 0;
  calls.updates.length = 0;
  calls.deductions = 0;
  calls.debtSyncs = 0;
  Booking.findOneAndUpdate = async (filter) => {
    calls.filter = filter;
    if (capture.kind === "cancellation") return null;
    return {
      _id: "booking", bookingId: "B1", business: "business",
      capture, pricing: { servicePriceCents: 10000, depositCents: 1500, chargeFeeCents: 700 },
      payout: { attempts: 1 },
    };
  };
  Booking.updateOne = async (filter, update) => { calls.updates.push({ filter, update }); };
  BusinessProfile.findById = () => ({ lean: async () => ({ user: "provider" }) });
  User.findById = () => ({ lean: async () => ({ stripe: { accountId: "acct_test" } }) });
  Payment.findById = () => ({ lean: async () => ({ stripePaymentId: "pi_test" }) });
};

test("payout requires successful capture, actual Stripe fee, and source charge", async () => {
  prepare({ kind: "completion", amountCents: 10700, status: "captured", chargeId: "ch_test" });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await payProvider("booking"), null);
    assert.deepEqual(calls.filter["capture.status"], { $in: ["captured", "fallback_charged"] });
    assert.equal(calls.transfers.length, 0);
    assert.equal(calls.deductions, 0);
    assert.equal(calls.updates[0].update.$set.payoutStatus, "failed");
  } finally { console.error = originalError; }
});

test("payout uses the actual fee and a booking-level idempotency key", async () => {
  prepare({ kind: "completion", amountCents: 10700, status: "captured", chargeId: "ch_test", stripeFeeCents: 351 });
  const result = await payProvider("booking");
  assert.equal(result.net, 9672);
  assert.equal(calls.transfers.length, 1);
  assert.equal(calls.transfers[0].params.source_transaction, "ch_test");
  assert.equal(calls.transfers[0].params.transfer_group, "booking_booking");
  assert.equal(calls.transfers[0].options.idempotencyKey, "payout_booking");
  assert.equal(calls.updates[0].update.$set.payoutStatus, "paid");
});

test("customer cancellation deposit is retained by the platform and not transferred", async () => {
  prepare({ kind: "cancellation", amountCents: 1500, status: "captured", chargeId: "ch_test", stripeFeeCents: 65 });
  assert.equal(await payProvider("booking"), null);
  assert.equal(calls.filter["capture.kind"].$ne, "cancellation");
  assert.equal(calls.transfers.length, 0);
  assert.equal(calls.deductions, 0);
  assert.equal(calls.updates[0].update.$set.payoutStatus, "skipped");
  assert.equal(calls.updates[0].update.$set["payout.netCents"], 0);
});

test("legacy cancellation captures also skip provider payout", async () => {
  prepare({ kind: "cancellation", amountCents: 2200, status: "captured", chargeId: "ch_test", stripeFeeCents: 94 });
  assert.equal(await payProvider("booking"), null);
  assert.equal(calls.transfers.length, 0);
  assert.equal(calls.deductions, 0);
  assert.equal(calls.updates[0].update.$set.payoutStatus, "skipped");
});

test("inconsistent cancellation capture cannot overpay the provider", async () => {
  prepare({ kind: "cancellation", amountCents: 2300, status: "captured", chargeId: "ch_test", stripeFeeCents: 94 });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await payProvider("booking"), null);
    assert.equal(calls.transfers.length, 0);
    assert.equal(calls.deductions, 0);
    assert.equal(calls.updates[0].update.$set.payoutStatus, "skipped");
  } finally { console.error = originalError; }
});

test("payout recovers charge and actual fee from the captured payment", async () => {
  prepare({ kind: "completion", amountCents: 10700, status: "fallback_charged" });
  const claim = Booking.findOneAndUpdate;
  Booking.findOneAndUpdate = async (filter) => ({ ...await claim(filter), payment: "payment" });
  const result = await payProvider("booking");
  assert.equal(result.net, 9672);
  assert.equal(calls.transfers[0].params.source_transaction, "ch_retrieved");
  assert.equal(calls.updates[0].update.$set["capture.stripeFeeCents"], 351);
});

test("failed capture marks payment due and does not pay the provider", async () => {
  prepare({});
  const stripe = require("@config/stripe");
  const originalRetrieve = stripe.paymentIntents.retrieve;
  stripe.paymentIntents.retrieve = async () => ({ status: "requires_capture" });
  Booking.findById = async () => ({
    _id: "booking", bookingId: "B1", user: "customer",
    capture: { status: "retrying", attempts: 0, kind: "completion", amountCents: 10700 },
  });
  Payment.findById = async () => ({ stripePaymentId: "pi_test" });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await runCapture("booking"), null);
    assert.equal(calls.updates[0].update.$set.paymentStatus, "payment_due");
    assert.equal(calls.debtSyncs, 1);
    assert.equal(calls.transfers.length, 0);
  } finally {
    console.error = originalError;
    stripe.paymentIntents.retrieve = originalRetrieve;
  }
});

test("a successful Stripe response for the wrong amount cannot trigger payout", async () => {
  prepare({});
  const stripe = require("@config/stripe");
  const originalCapture = stripe.paymentIntents.capture;
  stripe.paymentIntents.capture = async () => ({ status: "succeeded", amount_received: 10000 });
  Booking.findById = async () => ({
    _id: "booking", bookingId: "B1", user: "customer",
    capture: { status: "retrying", attempts: 0, kind: "completion", amountCents: 10700 },
  });
  Payment.findById = async () => ({ stripePaymentId: "pi_test" });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(runCapture("booking"), /amount or status does not match/);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.transfers.length, 0);
  } finally {
    console.error = originalError;
    stripe.paymentIntents.capture = originalCapture;
  }
});

test.after(() => {
  Booking.findOneAndUpdate = original.findOneAndUpdate;
  Booking.updateOne = original.updateOne;
  BusinessProfile.findById = original.profile;
  User.findById = original.user;
  Payment.findById = original.payment;
  Booking.findById = original.booking;
});
