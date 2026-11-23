require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const pricing = require("@utils/instantPricing");

const original = { startSession: mongoose.startSession, find: Booking.findOne, bookingUpdate: Booking.findOneAndUpdate,
  offerUpdate: BookingOffer.findOneAndUpdate, profileUpdate: BusinessProfile.findOneAndUpdate, settings: pricing.getInstantSettings };
const signals = [];
const socketPath = require.resolve("../backend/config/sockets/instantOfferSocketEmitter");
require.cache[socketPath] = { id: socketPath, filename: socketPath, loaded: true,
  exports: { emitOfferClosed: (signal) => signals.push(signal) } };
pricing.getInstantSettings = async () => ({ paymentSec: 300 });
const { acceptBookingOffer } = require("../backend/app/services/bookingAcceptance");
const now = new Date("2026-11-17T12:00:00Z");
const expires = new Date(now.getTime() + 60000);
let calls, booking, offer, updated, provider;
const setup = () => {
  calls = {}; signals.length = 0;
  booking = { _id: "booking", user: "customer", business: "business", offerExpiresAt: expires, paymentStatus: "pending" };
  offer = { _id: "offer", sentAt: new Date(now.getTime() - 30000), expiresAt: expires };
  updated = { ...booking, status: "accepted_awaiting_payment" };
  provider = { user: "provider" };
  mongoose.startSession = async () => ({
    withTransaction: async (fn) => { await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  });
  Booking.findOne = (filter) => { calls.filter = filter; return { session: () => ({ lean: async () => booking }) }; };
  BookingOffer.findOneAndUpdate = (filter, update) => { calls.offer = { filter, update }; return { lean: async () => offer }; };
  Booking.findOneAndUpdate = async (filter, update) => { calls.booking = { filter, update }; return updated; };
  BusinessProfile.findOneAndUpdate = (filter, update) => { calls.profile = { filter, update }; return { lean: async () => provider }; };
};

test("accept atomically closes the live offer and starts a five-minute payment window", async () => {
  setup();
  const result = await acceptBookingOffer({ offerId: "offer", businessId: "business", now });
  assert.equal(result.data.status, "accepted_awaiting_payment");
  assert.equal(result.data.awaitingPaymentDeadline.getTime(), now.getTime() + 300000);
  assert.equal(calls.filter["flow.currentOffer.offerId"], "offer");
  assert.deepEqual(calls.filter.offerExpiresAt, { $gt: now });
  assert.equal(calls.offer.update.$set.status, "accepted");
  assert.equal(calls.booking.update.$push.statusHistory.by, "business");
  assert.equal(calls.profile.update.$inc["matchStats.offersAccepted"], 1);
  assert.equal(calls.profile.update.$inc["matchStats.responseSecTotal"], 30);
  assert.equal(calls.committed, true);
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.status), ["accepted", "accepted"]);
  assert.deepEqual(signals.map((signal) => signal.paymentStatus), ["pending", "pending"]);
});

test("expired, stale, and already closed offers cannot be accepted", async () => {
  setup(); booking = null;
  assert.equal((await acceptBookingOffer({ offerId: "offer", businessId: "business", now })).status, 409);
  assert.equal(calls.offer, undefined);
  assert.equal(signals.length, 0);
  setup(); offer = null;
  assert.equal((await acceptBookingOffer({ offerId: "offer", businessId: "business", now })).status, 409);
  assert.equal(calls.booking, undefined);
});

test("acceptance signals use the booking's persisted payment status", async () => {
  setup();
  updated.paymentStatus = "requires_payment_fix";
  await acceptBookingOffer({ offerId: "offer", businessId: "business", now });
  assert.ok(signals.every((signal) => signal.paymentStatus === "requires_payment_fix"));
});

test("a lost booking transition or missing provider aborts acceptance", async () => {
  setup(); updated = null;
  await assert.rejects(acceptBookingOffer({ offerId: "offer", businessId: "business", now }), /Booking changed/);
  assert.equal(calls.committed, undefined);
  assert.equal(signals.length, 0);
  setup(); provider = null;
  await assert.rejects(acceptBookingOffer({ offerId: "offer", businessId: "business", now }), /provider not found/);
  assert.equal(calls.committed, undefined);
});

test.after(() => {
  mongoose.startSession = original.startSession; Booking.findOne = original.find; Booking.findOneAndUpdate = original.bookingUpdate;
  BookingOffer.findOneAndUpdate = original.offerUpdate; BusinessProfile.findOneAndUpdate = original.profileUpdate;
  pricing.getInstantSettings = original.settings;
});
