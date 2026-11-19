require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const { User } = require("@models/UserModel");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let stripeStatus;
let paid;
stub("@services/stripePayment", {
  createStripePayment: async () => ({ id: "pi_settlement", status: stripeStatus }),
  cancelStripePayment: async () => {},
});
stub("@services/stripeAccount", { getOrCreateCustomer: async () => ({ id: "cus_test" }) });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("../backend/app/services/instantPaymentService", { payProvider: async () => { paid++; } });
const { settleOutstandingDebt, getOutstandingDebt } = require("../backend/app/services/paymentService");
const originals = {
  findOne: Booking.findOne,
  find: Booking.find,
  paymentFind: Payment.findById,
  create: Payment.create,
  userFind: User.findById,
  userUpdate: User.findByIdAndUpdate,
};

const prepare = () => {
  paid = 0;
  const booking = {
    _id: "booking", user: "customer", business: "business", mode: "instant",
    paymentStatus: "payment_due", payment: "old",
    capture: { kind: "completion", amountCents: 10700, chargeId: "ch_old", stripeFeeCents: 99 },
    save: async function () { this.saved = true; },
  };
  User.findById = async () => ({ _id: "customer" });
  User.findByIdAndUpdate = async () => {};
  Booking.findOne = async () => booking;
  Booking.find = () => ({
    select: () => ({ sort: () => ({ lean: async () => [] }) }),
  });
  Payment.findById = async () => ({
    _id: "old", status: "authorized", stripePaymentId: "pi_old",
    paymentObject: { paymentMethod: "pm_test" }, save: async () => {},
  });
  Payment.create = async (data) => data;
  return booking;
};

test("processing settlement does not clear debt or trigger payout", async () => {
  const booking = prepare();
  stripeStatus = "processing";
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await settleOutstandingDebt({ user: { _id: "customer" }, bookingId: "booking" });
    assert.equal(result.error, "debt_settlement_failed");
    assert.equal(booking.paymentStatus, "payment_due");
    assert.equal(booking.saved, undefined);
    assert.equal(paid, 0);
  } finally { console.error = originalError; }
});

test("successful settlement clears old charge data before payout", async () => {
  const booking = prepare();
  stripeStatus = "succeeded";
  const result = await settleOutstandingDebt({ user: { _id: "customer" }, bookingId: "booking" });
  assert.ok(result.data);
  assert.equal(booking.paymentStatus, "captured");
  assert.equal(booking.capture.chargeId, undefined);
  assert.equal(booking.capture.stripeFeeCents, undefined);
  assert.equal(paid, 1);
});

test("safeguarded capture cannot be replaced by a concurrent debt charge", async () => {
  const booking = prepare();
  booking.capture.safeguarded = true;
  booking.capture.status = "retrying";
  stripeStatus = "succeeded";
  const result = await settleOutstandingDebt({ user: { _id: "customer" }, bookingId: "booking" });
  assert.equal(result.error, "instant_capture_recovery_pending");
  assert.equal(result.status, 409);
  assert.equal(booking.saved, undefined);
  assert.equal(paid, 0);
});

test("outstanding debt query includes payment_due", async () => {
  prepare();
  let filter;
  Booking.find = (value) => {
    filter = value;
    return { select: () => ({ sort: () => ({ lean: async () => [] }) }) };
  };
  await getOutstandingDebt("customer");
  assert.ok(filter.$or.some((row) => row.paymentStatus?.$in?.includes("payment_due")));
});

test.after(() => {
  Booking.findOne = originals.findOne;
  Booking.find = originals.find;
  Payment.findById = originals.paymentFind;
  Payment.create = originals.create;
  User.findById = originals.userFind;
  User.findByIdAndUpdate = originals.userUpdate;
});
