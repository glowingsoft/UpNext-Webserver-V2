require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const pricing = require("@utils/instantPricing");
const originalSettings = pricing.getInstantSettings;
pricing.getInstantSettings = async () => ({ customerDecisionSec: 180, timeoutStreakLimit: 3, maxProviders: 3 });

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

const { closeOffer, runBookingOfferExpiry } = require("../backend/app/services/bookingOfferResponse");
const now = new Date("2026-11-11T12:30:00Z");
const at = (seconds) => new Date(now.getTime() + seconds * 1000);

const setup = ({ expired = false, paused = false, bookingFound = true, offerFound = true, bookingUpdated = true } = {}) => {
  const saved = {
    startSession: mongoose.startSession,
    find: Booking.find,
    findOne: Booking.findOne,
    updateBooking: Booking.findOneAndUpdate,
    updateOffer: BookingOffer.findOneAndUpdate,
    findOffers: BookingOffer.find,
    updateProfile: BusinessProfile.findOneAndUpdate,
  };
  const calls = {};
  const offer = { _id: "offer", booking: "booking", business: "business", sentAt: at(-60), expiresAt: expired ? at(-10) : at(60) };
  const booking = {
    _id: "booking", user: "customer", business: "business", offerExpiresAt: offer.expiresAt, paymentStatus: "pending",
    flow: { attemptExpiresAt: at(600), currentOffer: { offerId: "offer", pauseAttempt: paused } },
  };
  const session = {
    withTransaction: async (fn) => { calls.transactionStarted = true; await fn(); calls.transactionCommitted = true; },
    endSession: async () => { calls.ended = true; },
  };
  mongoose.startSession = async () => session;
  Booking.findOne = (filter) => {
    calls.bookingFilter = filter;
    return { session: (value) => { assert.equal(value, session); return { lean: async () => bookingFound ? booking : null }; } };
  };
  BookingOffer.findOneAndUpdate = (filter, update, options) => {
    calls.offer = { filter, update, options };
    return { lean: async () => offerFound ? offer : null };
  };
  BookingOffer.find = () => ({ session: () => ({ lean: async () => [{ business: "business" }] }) });
  Booking.findOneAndUpdate = async (filter, update, options) => {
    calls.booking = { filter, update, options };
    return bookingUpdated ? { ...booking, status: "awaiting_customer_decision" } : null;
  };
  BusinessProfile.findOneAndUpdate = (filter, update, options) => {
    calls.profile = { filter, update, options };
    return { lean: async () => ({ user: "provider", matchStats: { consecutiveTimeouts: expired ? 3 : 0 } }) };
  };
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
      BookingOffer.find = saved.findOffers;
      BusinessProfile.findOneAndUpdate = saved.updateProfile;
    },
  };
};

test("decline commits offer and guarded booking transition with response stats", async () => {
  const context = setup();
  try {
    const result = await closeOffer({ bookingId: "booking", businessId: "business", now });
    assert.equal(result.data.status, "awaiting_customer_decision");
    assert.equal(context.calls.bookingFilter.business, "business");
    assert.deepEqual(context.calls.bookingFilter.offerExpiresAt, { $gt: now });
    assert.deepEqual(context.calls.bookingFilter.$or, [
      { "flow.currentOffer.pauseAttempt": true },
      { "flow.attemptExpiresAt": { $gt: now } },
    ]);
    assert.equal(context.calls.offer.update.$set.status, "declined");
    assert.equal(context.calls.booking.update.$set.awaitingDecisionDeadline.getTime(), at(600).getTime());
    assert.equal(Number(notifications[0].data.expiresAt), at(600).getTime());
    assert.equal(context.calls.booking.update.$push.statusHistory.by, "business");
    assert.equal(context.calls.profile.update.$inc["matchStats.responseSecTotal"], 60);
    assert.equal(context.calls.profile.update.$set["matchStats.consecutiveTimeouts"], 0);
    assert.equal(context.calls.transactionCommitted, true);
    assert.equal(context.calls.ended, true);
    assert.equal(signals.length, 2);
    assert.deepEqual(signals.map((signal) => signal.status), ["declined", "declined"]);
    assert.ok(signals.every((signal) => signal.paymentStatus === "pending"));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].data.status, "declined");
  } finally { context.restore(); }
});

test("offer-ID decline is restricted to that provider's current offer", async () => {
  const context = setup();
  try {
    const result = await closeOffer({ offerId: "offer", businessId: "business", now });
    assert.equal(result.data.status, "awaiting_customer_decision");
    assert.equal(context.calls.bookingFilter["flow.currentOffer.offerId"], "offer");
    assert.equal(context.calls.bookingFilter.business, "business");
    assert.equal(context.calls.offer.filter._id, "offer");
    assert.equal(context.calls.offer.filter.business, "business");
  } finally { context.restore(); }
});

test("the last permitted resend after three providers ends the attempt without a charge", async () => {
  const context = setup();
  try {
    BookingOffer.find = () => ({ session: () => ({ lean: async () => [
      { business: "a" }, { business: "b" }, { business: "business" }, { business: "business" },
    ] }) });
    await closeOffer({ bookingId: "booking", businessId: "business", now });
    assert.equal(context.calls.booking.update.$set.status, "canceled");
    assert.equal(context.calls.booking.update.$set.cancelReason, "no_match");
    assert.equal(context.calls.booking.update.$set.awaitingDecisionDeadline, null);
    assert.equal(notifications[0].title, "No provider matched");
  } finally { context.restore(); }
});

test("stale offer-ID decline cannot close the current offer", async () => {
  const context = setup({ bookingFound: false });
  try {
    const result = await closeOffer({ offerId: "old-offer", businessId: "business", now });
    assert.equal(result.status, 409);
    assert.equal(context.calls.bookingFilter["flow.currentOffer.offerId"], "old-offer");
    assert.equal(context.calls.offer, undefined);
  } finally { context.restore(); }
});

test("timeout pauses advance attempt until expiry, not delayed sweeper time", async () => {
  const context = setup({ expired: true, paused: true });
  try {
    await closeOffer({ bookingId: "booking", expired: true, now });
    assert.deepEqual(context.calls.bookingFilter.offerExpiresAt, { $lte: now });
    assert.deepEqual(context.calls.bookingFilter.$or, [
      { "flow.currentOffer.pauseAttempt": true },
      { $expr: { $lte: ["$offerExpiresAt", "$flow.attemptExpiresAt"] } },
    ]);
    assert.equal(context.calls.booking.update.$set["flow.attemptExpiresAt"].getTime(), at(650).getTime());
    assert.equal(context.calls.booking.update.$set.awaitingDecisionDeadline.getTime(), at(650).getTime());
    assert.equal(context.calls.offer.update.$set.status, "expired");
    assert.deepEqual(signals.map((signal) => signal.status), ["expired", "expired"]);
    assert.ok(signals.every((signal) => signal.paymentStatus === "pending"));
    assert.equal(notifications[0].data.status, "expired");
    assert.equal(context.calls.profile.update[1].$set.isAvailable.$cond[0].$gte[1], 3);
    assert.equal(notifications.length, 2);
  } finally { context.restore(); }
});

test("customer-triggered expiry is restricted to that customer's booking", async () => {
  const context = setup({ expired: true, bookingFound: false });
  try {
    await closeOffer({ bookingId: "booking", userId: "customer", expired: true, now });
    assert.equal(context.calls.bookingFilter.user, "customer");
    assert.equal(context.calls.offer, undefined);
  } finally { context.restore(); }
});

test("missing provider identity and expired or closed offers return unavailable without side effects", async () => {
  const context = setup({ bookingFound: false });
  try {
    assert.equal((await closeOffer({ bookingId: "booking", now })).error, "booking_offer_unavailable");
    assert.equal(context.calls.transactionStarted, undefined);
    assert.equal((await closeOffer({ bookingId: "booking", businessId: "business", now })).status, 409);
    assert.equal(context.calls.offer, undefined);
    assert.equal(signals.length, 0);
  } finally { context.restore(); }
});

test("a failed booking CAS aborts instead of committing a closed offer", async () => {
  const context = setup({ bookingUpdated: false });
  try {
    await assert.rejects(closeOffer({ bookingId: "booking", businessId: "business", now }), /Booking changed/);
    assert.equal(context.calls.transactionCommitted, undefined);
    assert.equal(context.calls.ended, true);
    assert.equal(signals.length, 0);
  } finally { context.restore(); }
});

test("an already closed offer does not change the booking", async () => {
  const context = setup({ offerFound: false });
  try {
    const result = await closeOffer({ bookingId: "booking", businessId: "business", now });
    assert.equal(result.status, 409);
    assert.equal(context.calls.offer.filter.status, "pending");
    assert.equal(context.calls.booking, undefined);
    assert.equal(context.calls.profile, undefined);
    assert.equal(signals.length, 0);
  } finally { context.restore(); }
});

test("expiry sweeper selects only requested records with active offers and deadlines", async () => {
  const context = setup({ bookingFound: false });
  try {
    Booking.find = (filter) => {
      context.calls.sweepFilter = filter;
      return { sort: () => ({ limit: () => ({ lean: async () => [{ _id: "booking" }] }) }) };
    };
    await runBookingOfferExpiry(now);
    assert.equal(context.calls.sweepFilter.status, "requested");
    assert.deepEqual(context.calls.sweepFilter.offerExpiresAt, { $type: "date", $lte: now });
    assert.deepEqual(context.calls.sweepFilter.$or, [
      { "flow.currentOffer.pauseAttempt": true },
      { $expr: { $lte: ["$offerExpiresAt", "$flow.attemptExpiresAt"] } },
    ]);
    assert.deepEqual(context.calls.bookingFilter.offerExpiresAt, { $lte: now });
    assert.equal(context.calls.transactionCommitted, true);
  } finally { context.restore(); }
});

test.after(() => { pricing.getInstantSettings = originalSettings; });
