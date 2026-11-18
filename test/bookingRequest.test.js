require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const Card = require("@models/Card");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const entityId = new mongoose.Types.ObjectId();
const providerId = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const updatedAt = new Date();
const entity = { _id: entityId, business: providerId, name: "Service", price: 50, category: new mongoose.Types.ObjectId(),
  concurrentClients: 1, updatedAt, slots: [] };
const profile = { _id: providerId, user: ownerId, updatedAt, operatingHours: [] };
const pricing = { servicePriceCents: 5000, totalCents: 5700, feeCents: 700, chargeFeeCents: 700, depositCents: 750, heldCents: 0 };
const settings = { providerAcceptSec: 120, providerAcceptSecAdvance: 1800, maxAttemptMinutes: 15, maxAdvanceDays: 7 };
const schedule = { date: new Date("2026-11-17T00:00:00Z"), appointmentStart: new Date(Date.now() + 1200000),
  slot: { open: "12:20", close: "13:00" }, isAvailableNow: true };
let validation, currentEntity, currentProfile, card, owner, occupied, calls, transactionFailure;
const body = { scope: "service", stripePaymentMethodId: "pm_test", date: "2026-11-17", slot: schedule.slot };
stub("../backend/app/services/bookingRequestValidation", { validateBookingRequest: async () => validation });
stub("@utils/bookingEligibility", {
  savedCardIsValid: (value) => !!value,
  resolveScheduledSlot: () => schedule,
});
stub("../backend/config/sockets/instantOfferSocketEmitter", { emitOfferReceived: (signal) => calls.signals.push(signal) });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: (data) => calls.notifications.push(data) });
const { createBookingRequest } = require("../backend/app/services/bookingRequest");
const original = {
  startSession: mongoose.startSession, card: Card.findOne, entity: Services.findOne,
  profile: BusinessProfile.findOneAndUpdate, user: User.findOne, count: Booking.countDocuments,
  booking: Booking.create, offer: BookingOffer.create,
};
const setup = () => {
  validation = { data: { entity, profile, schedule, settings, pricing, origin: [1, 2],
    agreement: { text: "agreement", version: "instant-v1" },
    cancellationPolicySnapshot: { policy: "non_refundable", text: "policy", version: "instant-v1" } } };
  card = {}; currentEntity = entity; currentProfile = profile; owner = { timezone: "UTC" };
  occupied = 0; transactionFailure = null;
  calls = { signals: [], notifications: [] };
  const query = (value) => ({ session: () => ({ lean: async () => value }) });
  mongoose.startSession = async () => ({
    withTransaction: async (fn) => { if (transactionFailure) throw transactionFailure; await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  });
  Card.findOne = (filter) => { calls.cardFilter = filter; return query(card); };
  Services.findOne = () => query(currentEntity);
  BusinessProfile.findOneAndUpdate = (filter, update) => { calls.providerUpdate = { filter, update }; return { lean: async () => currentProfile }; };
  User.findOne = () => query(owner);
  Booking.countDocuments = (filter) => { calls.capacityFilter = filter; return { session: async () => occupied }; };
  Booking.create = async ([value]) => { calls.booking = value; };
  BookingOffer.create = async ([value]) => { calls.offer = value; };
};

test("creates a booking and offer in one transaction without authorizing the card", async () => {
  setup();
  const result = await createBookingRequest({ userId: customerId, body });
  assert.equal(result.data.status, "requested");
  assert.equal(calls.committed, true);
  assert.equal(calls.ended, true);
  assert.equal(calls.booking.pricing.heldCents, 0);
  assert.equal(calls.booking.payment, undefined);
  assert.equal(calls.booking.target[0]._id, entityId);
  assert.equal(calls.booking.flow.appointmentStart, schedule.appointmentStart);
  assert.equal(calls.booking.flow.isAvailableNow, true);
  assert.equal(new Booking(calls.booking).validateSync(), undefined);
  assert.equal(new BookingOffer(calls.offer).validateSync(), undefined);
  assert.equal(String(calls.booking.flow.currentOffer.offerId), String(calls.offer._id));
  assert.equal(calls.booking.offerExpiresAt, calls.offer.expiresAt);
  assert.equal(calls.offer.servicePriceCents, 5000);
  assert.deepEqual(calls.capacityFilter.status, { $in: ["confirmed", "ongoing"] });
  assert.equal(calls.providerUpdate.update.$inc["matchStats.offersReceived"], 1);
  assert.equal(calls.signals.length, 1);
  assert.equal(calls.booking.paymentStatus, "pending");
  assert.equal(calls.signals[0].paymentStatus, calls.booking.paymentStatus);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].data.status, "pending");
  assert.equal(calls.cardFilter.user, customerId);
});

test("rejects a full slot or changed provider without committing an offer", async () => {
  setup(); occupied = 1;
  assert.equal((await createBookingRequest({ userId: customerId, body })).error, "booking_slot_full");
  assert.equal(calls.committed, undefined);
  assert.equal(calls.booking, undefined);
  assert.equal(calls.signals.length, 0);
  setup(); currentProfile = null;
  assert.equal((await createBookingRequest({ userId: customerId, body })).error, "instant_provider_unavailable");
  assert.equal(calls.committed, undefined);
});

test("rejects a removed card and an existing active customer attempt", async () => {
  setup(); card = null;
  assert.equal((await createBookingRequest({ userId: customerId, body })).error, "booking_saved_card_required");
  assert.equal(calls.booking, undefined);
  setup(); transactionFailure = Object.assign(new Error("duplicate"), { code: 11000, keyPattern: { user: 1 } });
  assert.equal((await createBookingRequest({ userId: customerId, body })).error, "instant_booking_in_progress");
  assert.equal(calls.ended, true);
});

test.after(() => {
  mongoose.startSession = original.startSession; Card.findOne = original.card; Services.findOne = original.entity;
  BusinessProfile.findOneAndUpdate = original.profile; User.findOne = original.user; Booking.countDocuments = original.count;
  Booking.create = original.booking; BookingOffer.create = original.offer;
});
