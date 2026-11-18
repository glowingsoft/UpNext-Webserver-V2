require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const communicationPath = require.resolve("../backend/commonModules/controllers/communicationController");
const socketPath = require.resolve("../backend/config/sockets/instantOfferSocketEmitter");
const notifications = [];
const signals = [];
require.cache[communicationPath] = {
  id: communicationPath, filename: communicationPath, loaded: true,
  exports: { sendUserNotifications: (data) => notifications.push(data) },
};
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: { emitOfferClosed: (data) => signals.push(data) },
};

const { expirePendingAttempt, runAttemptSweeper } = require("../backend/app/services/bookingAttemptSweeper");
const now = new Date("2026-11-11T12:15:00Z");
const at = (seconds) => new Date(now.getTime() + seconds * 1000);

const setup = ({ bookingFound = true, offerFound = true, casSucceeds = true } = {}) => {
  const saved = {
    startSession: mongoose.startSession,
    find: Booking.find,
    findOne: Booking.findOne,
    updateBooking: Booking.findOneAndUpdate,
    updateOffer: BookingOffer.findOneAndUpdate,
    findProfile: BusinessProfile.findById,
  };
  const calls = {};
  const booking = {
    _id: "booking", user: "customer", business: "business", offerExpiresAt: at(60), paymentStatus: "pending",
    flow: { attemptExpiresAt: at(-5), currentOffer: { offerId: "offer", pauseAttempt: false } },
  };
  const session = {
    withTransaction: async (fn) => { await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  };
  mongoose.startSession = async () => session;
  Booking.findOne = (filter) => {
    calls.bookingFilter = filter;
    return { session: (value) => {
      assert.equal(value, session);
      return { lean: async () => bookingFound ? booking : null };
    } };
  };
  BookingOffer.findOneAndUpdate = (filter, update, options) => {
    calls.offer = { filter, update, options };
    return { lean: async () => offerFound ? { _id: "offer" } : null };
  };
  Booking.findOneAndUpdate = async (filter, update, options) => {
    calls.booking = { filter, update, options };
    return casSucceeds ? { ...booking, status: "canceled" } : null;
  };
  BusinessProfile.findById = () => ({ session: () => ({ lean: async () => ({ user: "provider" }) }) });
  notifications.length = 0;
  signals.length = 0;
  return {
    calls,
    restore() {
      mongoose.startSession = saved.startSession;
      Booking.find = saved.find;
      Booking.findOne = saved.findOne;
      Booking.findOneAndUpdate = saved.updateBooking;
      BookingOffer.findOneAndUpdate = saved.updateOffer;
      BusinessProfile.findById = saved.findProfile;
    },
  };
};

test("attempt expiry closes the pending offer in a transaction without penalizing provider", async () => {
  const context = setup();
  try {
    assert.equal(await expirePendingAttempt({ bookingId: "booking", now }), true);
    assert.deepEqual(context.calls.bookingFilter["flow.currentOffer.pauseAttempt"], { $ne: true });
    assert.deepEqual(context.calls.bookingFilter.$expr, { $lt: ["$flow.attemptExpiresAt", "$offerExpiresAt"] });
    assert.equal(context.calls.offer.update.$set.status, "closed");
    assert.equal(context.calls.booking.update.$set.cancelReason, "no_match");
    assert.deepEqual(context.calls.booking.update.$push.statusHistory.at, at(-5));
    assert.equal(context.calls.committed, true);
    assert.equal(context.calls.ended, true);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.status === "closed" && signal.reason === "attempt_expired"));
    assert.ok(signals.every((signal) => signal.paymentStatus === "pending"));
    assert.equal(notifications[0].data.reason, "attempt_expired");
    assert.equal(notifications.length, 1);
  } finally { context.restore(); }
});

test("a missing pending offer or lost booking CAS aborts the transaction", async () => {
  for (const options of [{ offerFound: false }, { casSucceeds: false }]) {
    const context = setup(options);
    try {
      await assert.rejects(expirePendingAttempt({ bookingId: "booking", now }), /Pending booking offer|Booking changed/);
      assert.equal(context.calls.committed, undefined);
      assert.equal(context.calls.ended, true);
      assert.equal(signals.length, 0);
    } finally { context.restore(); }
  }
});

test("a booking that no longer qualifies is left untouched", async () => {
  const context = setup({ bookingFound: false });
  try {
    assert.equal(await expirePendingAttempt({ bookingId: "booking", now }), false);
    assert.equal(context.calls.offer, undefined);
    assert.equal(signals.length, 0);
  } finally { context.restore(); }
});

test("sweeper selects only elapsed, unpaused attempts that expire before the offer", async () => {
  const context = setup({ bookingFound: false });
  try {
    let queries = 0;
    Booking.find = (filter) => {
      queries++;
      context.calls.sweepFilter = filter;
      return { sort: () => ({ limit: () => ({ lean: async () => [{ _id: "booking" }] }) }) };
    };
    await runAttemptSweeper(now);
    assert.deepEqual(context.calls.sweepFilter["flow.attemptExpiresAt"], { $type: "date", $lte: now });
    assert.deepEqual(context.calls.sweepFilter["flow.currentOffer.pauseAttempt"], { $ne: true });
    assert.deepEqual(context.calls.sweepFilter.$expr, { $lt: ["$flow.attemptExpiresAt", "$offerExpiresAt"] });
    assert.equal(queries, 1);
  } finally { context.restore(); }
});
