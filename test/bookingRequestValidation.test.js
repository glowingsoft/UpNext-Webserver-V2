require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Card = require("@models/Card");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const pricing = require("@utils/instantPricing");
const route = require("@utils/routeDistanceHelper");
const saved = {
  card: Card.findOne, count: Booking.countDocuments, profile: BusinessProfile.findOne,
  user: User.findOne, service: Services.findById, package: Packages.findById,
  settings: pricing.getInstantSettings, route: route.resolveDrivingDurations,
};
const id = () => new mongoose.Types.ObjectId();
const customer = id(), provider = id(), owner = id(), target = id();
const now = new Date("2026-11-12T12:00:00Z");
const body = {
  scope: "service", targetId: String(target), providerId: String(provider),
  stripePaymentMethodId: "pm_test", date: "2026-11-12", slot: { open: "12:20", close: "13:00" },
  lat: 1, lng: 1, agreedNonRefundable: true, agreementVersion: "instant-v1",
};
const entity = {
  _id: target, business: provider, name: "Haircut", price: 50, status: "active", isAvailable: true,
  concurrentClients: 1, cancellationPolicy: "refundable_24h",
  slots: [{ dayOfWeek: "Thu", isOpen: true, intervals: [{ open: "12:20", close: "13:00" }] }],
};
const profile = {
  _id: provider, user: owner, location: { coordinates: [2, 2] },
  operatingHours: [{ dayOfWeek: "Thu", isOpen: true, startTime: "09:00", endTime: "17:00" }],
};
let cardValue, entityValue, profileValue, ownerValue, occupied, duration, filters;
const lean = (value) => ({ lean: async () => value });
const setup = () => {
  cardValue = { expMonth: 12, expYear: 2026 };
  entityValue = entity;
  profileValue = profile;
  ownerValue = { _id: owner, timezone: "UTC" };
  occupied = 0;
  duration = 900;
  filters = {};
  Card.findOne = (filter) => { filters.card = filter; return lean(cardValue); };
  Services.findById = () => lean(entityValue);
  Packages.findById = () => lean(entityValue);
  BusinessProfile.findOne = (filter) => { filters.profile = filter; return lean(profileValue); };
  User.findOne = (filter) => { filters.user = filter; return lean(ownerValue); };
  Booking.countDocuments = async (filter) => { filters.capacity = filter; return occupied; };
  pricing.getInstantSettings = async () => ({ ...pricing.INSTANT_DEFAULTS });
  route.resolveDrivingDurations = async () => [duration];
};
setup();
const { validateBookingRequest } = require("../backend/app/services/bookingRequestValidation");

test("valid request snapshots price and agreement without a hold", async () => {
  setup();
  const result = await validateBookingRequest({ userId: customer, body, now });
  assert.equal(result.data.pricing.totalCents, 5700);
  assert.equal(result.data.pricing.heldCents, 0);
  assert.equal(result.data.cancellationPolicySnapshot.policy, "refundable_24h");
  assert.equal(filters.card.user, customer);
  assert.equal(filters.card.paymentMethodId, "pm_test");
  assert.equal(filters.user["accountState.status"], "active");
  assert.deepEqual(filters.capacity.status, { $in: ["confirmed", "ongoing"] });
});

test("missing, expired, or unowned cards cannot create a request", async () => {
  for (const value of [null, { expMonth: 10, expYear: 2026 }]) {
    setup(); cardValue = value;
    const result = await validateBookingRequest({ userId: customer, body, now });
    assert.equal(result.error, "booking_saved_card_required");
    assert.equal(filters.profile, undefined);
  }
});

test("validates chosen provider, active account, price and capacity", async () => {
  setup(); entityValue = { ...entity, business: id() };
  assert.equal((await validateBookingRequest({ userId: customer, body, now })).error, "booking_entity_not_found");
  setup(); ownerValue = null;
  assert.equal((await validateBookingRequest({ userId: customer, body, now })).error, "instant_provider_unavailable");
  setup(); entityValue = { ...entity, price: 24 };
  assert.equal((await validateBookingRequest({ userId: customer, body, now })).error, "instant_price_too_low");
  setup(); occupied = 1;
  assert.equal((await validateBookingRequest({ userId: customer, body, now })).error, "booking_slot_full");
});

test("requires schedule, nearby route and explicit agreement", async () => {
  setup(); duration = 1801;
  assert.equal((await validateBookingRequest({ userId: customer, body, now })).error, "instant_provider_unavailable");
  setup();
  assert.equal((await validateBookingRequest({ userId: customer, body: { ...body, date: "2026-12-01" }, now })).error, "booking_slot_invalid");
  assert.equal((await validateBookingRequest({ userId: customer, body: { ...body, agreedNonRefundable: false }, now })).error, "instant_agreement_required");
});

test("packages use the same pricing and eligibility checks", async () => {
  setup();
  const result = await validateBookingRequest({ userId: customer, body: { ...body, scope: "package" }, now });
  assert.equal(result.data.pricing.totalCents, 5700);
  assert.equal(filters.capacity.scope, "package");
});

test.after(() => {
  Card.findOne = saved.card; Booking.countDocuments = saved.count; BusinessProfile.findOne = saved.profile;
  User.findOne = saved.user; Services.findById = saved.service; Packages.findById = saved.package;
  pricing.getInstantSettings = saved.settings; route.resolveDrivingDurations = saved.route;
});
