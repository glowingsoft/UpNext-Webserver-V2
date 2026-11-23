require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let expireOffer;
stub("../backend/app/services/bookingOfferResponse", { closeOffer: (args) => expireOffer(args) });
const id = () => new mongoose.Types.ObjectId();
const customer = id(), bookingId = id(), oldProvider = id(), newProvider = id(), oldTarget = id(), newTarget = id();
const category = id(), subcategory = id(), providerUser = id();
const expires = new Date(Date.now() + 600000);
const original = { find: Booking.findOne, exists: Booking.exists, offers: BookingOffer.find, create: BookingOffer.create,
  profile: BusinessProfile.findById, startSession: mongoose.startSession };
let booking, offers, selected, calls, found, updated, firstProfile;
const body = { scope: "package", providerId: String(newProvider), targetId: String(newTarget),
  expectedTotalCents: 5700, agreedNonRefundable: true, agreementVersion: "instant-v1" };
const schedule = { date: new Date("2026-11-17"), slot: { open: "12:20", close: "13:00" },
  appointmentStart: new Date(Date.now() + 1200000), isAvailableNow: true };
class RequestConflict extends Error { constructor(key) { super(key); this.key = key; } }
stub("../backend/app/services/bookingRequestValidation", {
  validateBookingRequest: async ({ body: request }) => {
    calls.request = request;
    return { data: selected };
  },
});
stub("../backend/app/services/bookingRequest", {
  RequestConflict,
  validateCandidateInTransaction: async () => { calls.checked = true; return schedule; },
});
stub("../backend/app/services/bookingStateMachine", {
  transitionBooking: async (args) => { calls.transition = args; return updated; },
});
stub("../backend/config/sockets/instantOfferSocketEmitter", { emitOfferReceived: (signal) => calls.signals.push(signal) });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: (signal) => calls.notifications.push(signal) });
const { sendNextOffer } = require("../backend/app/services/bookingSendNext");

const setup = () => {
  booking = { _id: bookingId, user: customer, business: oldProvider, scope: "service", updatedAt: new Date(),
    date: schedule.date, slot: schedule.slot, target: [{ _id: oldTarget }],
    stripePaymentMethodId: "pm_test", awaitingDecisionDeadline: expires,
    flow: { categoryId: category, subcategoryId: subcategory, attemptExpiresAt: expires, location: { coordinates: [1, 2] } } };
  selected = {
    entity: { _id: newTarget, business: newProvider, category, subcategory, name: "Package", price: 50 },
    profile: { _id: newProvider, user: providerUser },
    settings: { providerAcceptSec: 120, providerAcceptSecAdvance: 1800, maxProviders: 3 },
    pricing: { servicePriceCents: 5000, totalCents: 5700, heldCents: 0 },
    agreement: { text: "agreement", version: "instant-v1" },
    cancellationPolicySnapshot: { policy: "non_refundable", text: "policy", version: "instant-v1" },
    schedule,
  };
  offers = [{ _id: id(), business: oldProvider, status: "declined", sentAt: new Date() }];
  firstProfile = { categories: [], tags: [], skills: [] };
  found = true; updated = true; calls = { signals: [], notifications: [] };
  Booking.findOne = (filter) => {
    calls.filters = [...(calls.filters || []), filter];
    return { lean: async () => found ? booking : null, session: () => ({ lean: async () => found ? booking : null }) };
  };
  Booking.exists = async () => false;
  BookingOffer.find = () => ({ session: () => ({ lean: async () => offers }) });
  BookingOffer.create = async ([offer]) => { calls.offer = offer; };
  BusinessProfile.findById = () => ({ session() { return this; }, lean: async () => firstProfile });
  mongoose.startSession = async () => ({
    withTransaction: async (fn) => { await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  });
};

test("sends a different provider's package using fresh price and guarded transition", async () => {
  setup();
  const result = await sendNextOffer({ bookingId, userId: customer, body });
  assert.equal(result.data.status, "requested");
  assert.equal(calls.transition.to, "requested");
  assert.equal(calls.transition.set.target[0]._id, newTarget);
  assert.equal(calls.transition.set.business, newProvider);
  assert.equal(calls.transition.set.pricing.heldCents, 0);
  assert.equal(calls.transition.guard.user, customer);
  assert.equal(calls.offer.sendCount, 1);
  assert.equal(calls.signals.length, 1);
  assert.equal(calls.signals[0].paymentStatus, "pending");
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].data.status, "pending");
  assert.equal(calls.committed, true);
});

test("allows only one resend to the just-declined provider", async () => {
  setup();
  selected.entity = { ...selected.entity, _id: oldTarget, business: oldProvider };
  selected.profile = { _id: oldProvider, user: providerUser };
  const result = await sendNextOffer({ bookingId, userId: customer, body, resend: true });
  assert.equal(result.data.status, "requested");
  assert.equal(calls.request.targetId, String(oldTarget));
  assert.equal(calls.offer.sendCount, 2);
  setup();
  selected.entity = { ...selected.entity, _id: oldTarget, business: oldProvider };
  selected.profile = { _id: oldProvider, user: providerUser };
  offers.push({ business: oldProvider, status: "expired" });
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body, resend: true })).error, "instant_resend_unavailable");
  assert.equal(calls.checked, undefined);
  assert.equal(calls.committed, undefined);
});

test("send-next and send-again remain available after the old decision deadline", async () => {
  for (const resend of [false, true]) {
    setup();
    booking.awaitingDecisionDeadline = new Date(Date.now() - 1000);
    const findOne = Booking.findOne;
    Booking.findOne = (filter) => {
      if (filter.awaitingDecisionDeadline && booking.awaitingDecisionDeadline <= filter.awaitingDecisionDeadline.$gt) found = false;
      if (filter["flow.attemptExpiresAt"] && booking.flow.attemptExpiresAt <= filter["flow.attemptExpiresAt"].$gt) found = false;
      return findOne(filter);
    };
    if (resend) {
      selected.entity = { ...selected.entity, _id: oldTarget, business: oldProvider };
      selected.profile = { _id: oldProvider, user: providerUser };
    }
    const result = await sendNextOffer({ bookingId, userId: customer, body, resend });
    assert.equal(result.data.status, "requested");
    for (const filter of calls.filters) {
      assert.equal(filter.awaitingDecisionDeadline, undefined);
      assert.ok(filter["flow.attemptExpiresAt"].$gt);
    }
    assert.equal(calls.transition.guard.awaitingDecisionDeadline, undefined);
    assert.ok(calls.transition.guard["flow.attemptExpiresAt"].$gt);
  }
});

test("send-again processes an expired offer before the sweeper", async () => {
  setup();
  selected.entity = { ...selected.entity, _id: oldTarget, business: oldProvider };
  selected.profile = { _id: oldProvider, user: providerUser };
  offers[0].status = "expired";
  let first = true;
  let closed;
  const findOne = Booking.findOne;
  Booking.findOne = (filter) => {
    if (first) { first = false; return { lean: async () => null }; }
    return findOne(filter);
  };
  Booking.exists = async (filter) => filter.status === "requested";
  expireOffer = async (args) => { closed = args; return { data: {} }; };
  const result = await sendNextOffer({ bookingId, userId: customer, body, resend: true });
  assert.equal(result.data.status, "requested");
  assert.equal(closed.userId, customer);
  assert.equal(closed.expired, true);
});

test("send-next and send-again reject an expired attempt even before the sweeper runs", async () => {
  for (const resend of [false, true]) {
    setup();
    booking.flow.attemptExpiresAt = new Date(Date.now() - 1000);
    const findOne = Booking.findOne;
    Booking.findOne = (filter) => {
      if (filter["flow.attemptExpiresAt"] && booking.flow.attemptExpiresAt <= filter["flow.attemptExpiresAt"].$gt) found = false;
      return findOne(filter);
    };
    const result = await sendNextOffer({ bookingId, userId: customer, body, resend });
    assert.equal(result.error, "booking_offer_unavailable");
    assert.equal(calls.transition, undefined);
  }
});

test("rejects previously tried or excess providers and changed prices", async () => {
  setup(); offers.push({ business: newProvider, status: "expired" });
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body })).error, "instant_provider_already_tried");
  setup(); offers = [id(), id(), id()].map((business) => ({ business, status: "declined" }));
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body })).error, "instant_provider_limit");
  setup();
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body: { ...body, expectedTotalCents: 1 } })).error, "instant_price_changed");
  assert.equal(calls.checked, undefined);
});

test("allows a different listing category only when provider profiles match", async () => {
  setup();
  selected.entity.subcategory = id();
  firstProfile.skills = ["Hair Styling"];
  selected.profile.skills = [" hair styling "];
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body })).data.status, "requested");
  setup(); selected.entity.subcategory = id();
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body })).error, "instant_category_mismatch");
});

test("rejects expired attempts and a lost transition", async () => {
  setup(); found = false;
  assert.equal((await sendNextOffer({ bookingId, userId: customer, body })).status, 409);
  setup(); updated = false;
  await assert.rejects(sendNextOffer({ bookingId, userId: customer, body }), /Booking changed/);
  assert.equal(calls.offer, undefined);
  assert.equal(calls.committed, undefined);
});

test.after(() => {
  Booking.findOne = original.find; BookingOffer.find = original.offers; BookingOffer.create = original.create;
  Booking.exists = original.exists;
  BusinessProfile.findById = original.profile;
  mongoose.startSession = original.startSession;
});
