require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let cancelResult, cancelError, retrieveResult, updates, saves;
stub("@config/stripe", { paymentIntents: { retrieve: async () => retrieveResult } });
stub("@services/stripePayment", {
  createStripePayment: async () => {},
  cancelStripePayment: async () => { if (cancelError) throw cancelError; return cancelResult; },
});
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("../backend/commonModules/chatModule/services/conversationGateService", { openOrReopenConversationForBooking: async () => {} });
stub("../backend/app/services/paymentService", { applyDebtLock: async () => {}, syncDebtLock: async () => {} });
stub("../backend/app/services/penaltyService", { consumeDeductions: async () => {}, restoreDeductions: async () => {} });
stub("../backend/app/services/instantOfferService", { instantEvents: new EventEmitter() });
const { releaseHold } = require("../backend/app/services/instantPaymentService");
const original = { booking: Booking.findById, payment: Payment.findById, update: Booking.updateOne };
let payment;
const setup = () => {
  cancelResult = { status: "canceled" }; cancelError = null; retrieveResult = null; updates = []; saves = 0;
  payment = { _id: "payment", stripePaymentId: "pi_test", status: "authorized", save: async () => { saves++; } };
  Booking.findById = async () => ({ _id: "booking", payment: "payment" });
  Payment.findById = async () => payment;
  Booking.updateOne = async (filter, update) => { updates.push({ filter, update }); };
};

test("marks a hold released only after Stripe confirms cancellation", async () => {
  setup();
  await releaseHold("booking");
  assert.equal(payment.status, "released");
  assert.equal(saves, 1);
  assert.equal(updates[0].filter.payment, "payment");
  assert.equal(updates[0].update.$set.paymentStatus, "released");
});

test("cancel errors leave the authorization unchanged unless Stripe confirms it was already canceled", async () => {
  setup(); cancelError = new Error("network failure"); retrieveResult = { status: "requires_capture" };
  await assert.rejects(releaseHold("booking"), /network failure/);
  assert.equal(payment.status, "authorized");
  assert.equal(saves, 0);
  assert.equal(updates.length, 0);
  setup(); cancelError = new Error("already canceled"); retrieveResult = { status: "canceled" };
  await releaseHold("booking");
  assert.equal(payment.status, "released");
  assert.equal(updates.length, 1);
});

test("rejects a captured or missing payment and an unexpected cancellation result", async () => {
  setup(); payment.status = "captured";
  await assert.rejects(releaseHold("booking"), /Captured payment/);
  setup(); payment = null;
  await assert.rejects(releaseHold("booking"), /payment not found/);
  setup(); cancelResult = { status: "processing" };
  await assert.rejects(releaseHold("booking"), /not canceled/);
  assert.equal(updates.length, 0);
});

test.after(() => { Booking.findById = original.booking; Payment.findById = original.payment; Booking.updateOne = original.update; });
