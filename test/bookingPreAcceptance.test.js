require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const signals = [];
const notifications = [];
const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub("@socketIo/instantOfferSocketEmitter", { emitOfferClosed: (value) => signals.push(value) });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: (value) => notifications.push(value) });
const { cancelBeforeAcceptance } = require("../backend/app/services/bookingPreAcceptance");
const now = new Date("2026-11-12T12:00:00Z");
const originals = {
  startSession: mongoose.startSession,
  findOne: Booking.findOne,
  transition: Booking.findOneAndUpdate,
  offer: BookingOffer.findOneAndUpdate,
  provider: BusinessProfile.findById,
};

const setup = ({ status = "requested", found = true, offerFound = true, updated = true } = {}) => {
  signals.length = 0;
  notifications.length = 0;
  const calls = {};
  const session = {
    withTransaction: async (fn) => { await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  };
  const booking = {
    _id: "booking", user: "customer", business: "business", status, paymentStatus: "pending",
    flow: { currentOffer: { offerId: "offer" } },
  };
  mongoose.startSession = async () => session;
  Booking.findOne = (filter) => {
    calls.filter = filter;
    return { session: () => ({ lean: async () => found ? booking : null }) };
  };
  BookingOffer.findOneAndUpdate = (filter, update, options) => {
    calls.offer = { filter, update, options };
    return { lean: async () => offerFound ? { _id: "offer", expiresAt: now } : null };
  };
  Booking.findOneAndUpdate = async (filter, update, options) => {
    calls.transition = { filter, update, options };
    return updated ? { ...booking, status: "canceled" } : null;
  };
  BusinessProfile.findById = () => ({ session: () => ({ lean: async () => ({ user: "provider" }) }) });
  return calls;
};

test("customer cancels an unheld pending request and closes the offer in one transaction", async () => {
  const calls = setup();
  const result = await cancelBeforeAcceptance({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.cancelReason, "client");
  assert.equal(calls.filter.user, "customer");
  assert.equal(calls.filter.payment, null);
  assert.equal(calls.filter["pricing.heldCents"], 0);
  assert.equal(calls.offer.update.$set.status, "closed");
  assert.equal(calls.offer.options.session, calls.transition.options.session);
  assert.equal(calls.transition.update.$set.status, "canceled");
  assert.equal(calls.transition.update.$push.statusHistory.by, "user");
  assert.equal(calls.committed, true);
  assert.equal(calls.ended, true);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.status === "closed" && signal.reason === "customer_canceled"));
  assert.ok(signals.every((signal) => signal.paymentStatus === "pending"));
  assert.equal(notifications[0].data.status, "closed");
  assert.equal(notifications[0].data.reason, "customer_canceled");
  assert.equal(notifications[0].recipientIds[0], "provider");
});

test("decision cancellation does not try to close an offer", async () => {
  const calls = setup({ status: "awaiting_customer_decision" });
  const result = await cancelBeforeAcceptance({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.status, "canceled");
  assert.equal(calls.offer, undefined);
  assert.equal(calls.transition.update.$set.awaitingDecisionDeadline, null);
  assert.equal(signals.length, 0);
});

test("payment, ownership, or status mismatch does not cancel", async () => {
  const calls = setup({ found: false });
  const result = await cancelBeforeAcceptance({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.error, "booking_cannot_cancel");
  assert.equal(calls.offer, undefined);
  assert.equal(calls.transition, undefined);
});

test("missing offer or failed CAS aborts instead of committing half a cancellation", async () => {
  for (const options of [{ offerFound: false }, { updated: false }]) {
    const calls = setup(options);
    await assert.rejects(cancelBeforeAcceptance({ bookingId: "booking", userId: "customer", now }));
    assert.equal(calls.committed, undefined);
    assert.equal(calls.ended, true);
    assert.equal(signals.length, 0);
  }
});

test.after(() => {
  mongoose.startSession = originals.startSession;
  Booking.findOne = originals.findOne;
  Booking.findOneAndUpdate = originals.transition;
  BookingOffer.findOneAndUpdate = originals.offer;
  BusinessProfile.findById = originals.provider;
});
