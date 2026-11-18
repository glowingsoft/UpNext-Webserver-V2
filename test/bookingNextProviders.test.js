require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const Review = require("@models/Review");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const pricing = require("@utils/instantPricing");
const route = require("@utils/routeDistanceHelper");
const responsePath = require.resolve("../backend/app/services/bookingOfferResponse");
let expireOffer;
require.cache[responsePath] = {
  id: responsePath, filename: responsePath, loaded: true,
  exports: { closeOffer: (args) => expireOffer(args) },
};
const saved = {
  findOne: Booking.findOne, exists: Booking.exists, bookings: Booking.find,
  offers: BookingOffer.find, profiles: BusinessProfile.find, profileById: BusinessProfile.findById, ratings: Review.aggregate,
  users: User.find, serviceFind: Services.find, serviceId: Services.findById,
  packageFind: Packages.find, settings: pricing.getInstantSettings, durations: route.resolveDrivingDurations,
};
const now = new Date("2026-11-12T12:00:00Z");
const booking = {
  scope: "service", target: [{ _id: "original" }], date: new Date("2026-11-12T00:00:00Z"),
  slot: { open: "12:20", close: "13:00" }, awaitingDecisionDeadline: new Date(now.getTime() + 180000),
  flow: { attemptExpiresAt: new Date(now.getTime() + 600000), location: { coordinates: [1, 1] },
    categoryId: "category", subcategoryId: "subcategory", preferredServiceType: { badgeId: "badge", optionId: "option" } },
};
const original = { category: "category", subcategory: "subcategory", preferredServiceType: { badgeId: "badge", optionId: "option" } };
const entity = (id, business, extra = {}) => ({
  _id: id, business, name: id, price: 50, concurrentClients: 1,
  category: original.category, subcategory: original.subcategory,
  preferredServiceType: original.preferredServiceType,
  slots: [{ dayOfWeek: "Thu", isOpen: true, intervals: [{ open: "12:20", close: "13:00" }] }],
  ...extra,
});
const profile = (id, user) => ({
  _id: id, user, businessName: id, location: { coordinates: [id === "b1" ? 2 : 3, 2] },
  operatingHours: [{ dayOfWeek: "Thu", isOpen: true, startTime: "09:00", endTime: "17:00" }],
  matchStats: { offersReceived: 0, offersAccepted: 0 },
});
let serviceRows, packageRows, profileRows, ownerRows, offerRows, occupiedRows, durations, routeError, exists, captured, originalProfile, relatedRows;
const lean = (value) => ({ lean: async () => value });
const setup = () => {
  serviceRows = [entity("s1", "b1"), entity("s2", "b2")];
  packageRows = [entity("p1", "b1")];
  profileRows = [profile("b1", "u1"), profile("b2", "u2")];
  ownerRows = [{ _id: "u1", timezone: "UTC" }, { _id: "u2", timezone: "UTC" }];
  offerRows = [{ _id: "first", business: "excluded", status: "declined", sentAt: now }];
  originalProfile = { _id: "excluded", categories: [], tags: [], skills: [] };
  relatedRows = [];
  occupiedRows = [];
  durations = [900, 1900, 900];
  routeError = null;
  exists = true;
  captured = {};
  Booking.findOne = (query) => { captured.bookingQuery = query; return lean(booking); };
  Booking.exists = async (query) => {
    if (query.status === "requested") return false;
    captured.recheck = query; return exists;
  };
  Booking.find = (query) => { captured.occupied = query; return lean(occupiedRows); };
  BookingOffer.find = () => lean(offerRows);
  Services.findById = () => lean(original);
  Services.find = (query) => { captured.query = query; return lean(serviceRows); };
  Packages.find = () => lean(packageRows);
  BusinessProfile.findById = (id) => { captured.firstProvider = id; return lean(originalProfile); };
  BusinessProfile.find = (query) => {
    if (query._id.$nin) { captured.related = query; return lean(relatedRows); }
    captured.profiles = query;
    return lean(profileRows);
  };
  User.find = () => lean(ownerRows);
  Review.aggregate = async () => [{ _id: "b1", rating: 4 }];
  pricing.getInstantSettings = async () => ({ ...pricing.INSTANT_DEFAULTS });
  route.resolveDrivingDurations = async () => {
    if (routeError) throw routeError;
    return durations;
  };
};

setup();
const { getNextProviders } = require("../backend/app/services/bookingNextProviders");
test("ranks matching available providers, rejects journeys over 30 minutes and groups alternatives", async () => {
  setup();
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.providers.length, 1);
  assert.equal(result.data.providers[0].businessId, "b1");
  assert.equal(result.data.providers[0].alternatives[0].targetId, "p1");
  assert.deepEqual(captured.query.business.$nin, ["excluded"]);
  assert.equal(captured.query.$or[0].subcategory, "subcategory");
  assert.deepEqual(captured.occupied.status, { $in: ["confirmed", "ongoing"] });
  assert.equal(captured.bookingQuery.user, "customer");
  assert.ok(captured.recheck);
});

test("matching keeps the original category snapshot after the selected target changes", async () => {
  setup();
  Services.findById = () => { throw new Error("should not reload the selected target"); };
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.providers.length, 1);
  assert.equal(captured.query.$or[0].category, "category");
  assert.equal(captured.query.$or[0].subcategory, "subcategory");
});

test("expands candidates from the first provider profile without excluding new providers", async () => {
  setup();
  offerRows.push({ _id: "later", business: "later-provider", status: "declined", sentAt: new Date(now.getTime() + 1) });
  offerRows.reverse();
  originalProfile = { categories: [{ _id: "category-a" }], tags: [{ _id: "tag-a" }], skills: ["  Hair  "] };
  relatedRows = [{ _id: "b1" }];
  serviceRows[0].category = "different-category";
  profileRows[0].categories = [{ _id: "category-a" }];
  profileRows[0].skills = ["hair"];
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(captured.firstProvider, "excluded");
  assert.deepEqual(captured.query.$or[1], { business: { $in: ["b1"] } });
  assert.equal(captured.related.isAvailable, true);
  assert.equal(result.data.providers[0].businessId, "b1");
  assert.equal(result.data.providers[0].matchStats.offersReceived, 0);
});

test("does not return a different-category listing after profile similarities change", async () => {
  setup();
  originalProfile = { categories: [{ _id: "category-a" }] };
  relatedRows = [{ _id: "b1" }];
  serviceRows = [entity("s1", "b1", { category: "different-category" })];
  packageRows = [];
  assert.deepEqual((await getNextProviders({ bookingId: "booking", userId: "customer", now })).data.providers, []);
});

test("full seats exclude a service and package", async () => {
  setup();
  occupiedRows = [{ target: [{ _id: "s1" }] }, { target: [{ _id: "p1" }] }];
  durations = [1900];
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.deepEqual(result.data.providers, []);
});

test("inactive provider owners and business breaks exclude candidates", async () => {
  setup();
  ownerRows = [{ _id: "u1", timezone: "UTC" }];
  profileRows[0].operatingHours[0].breaks = [{ start: "12:00", end: "12:30" }];
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.deepEqual(result.data.providers, []);
});

test("invalid provider coordinates do not prevent other candidates from being returned", async () => {
  setup();
  profileRows[1].location.coordinates = [0, 0];
  durations = [900, 900];
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.providers.length, 1);
});

test("attempt provider limit returns no new candidates", async () => {
  setup();
  offerRows = ["a", "b", "c"].map((business) => ({ business }));
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.providerLimitReached, true);
  assert.deepEqual(result.data.providers, []);
});

test("decision expiring during lookup returns unavailable", async () => {
  setup();
  exists = false;
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.error, "booking_offer_unavailable");
});

test("the remaining attempt deadline replaces the old customer decision deadline", async () => {
  setup();
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(captured.bookingQuery.awaitingDecisionDeadline, undefined);
  assert.equal(captured.recheck.awaitingDecisionDeadline, undefined);
  assert.equal(result.data.deadline.getTime(), booking.flow.attemptExpiresAt.getTime());
});

test("provider lookup processes an expired offer without waiting for the sweeper", async () => {
  setup();
  let queries = 0;
  let closed;
  Booking.findOne = (query) => { captured.bookingQuery = query; return lean(++queries === 1 ? null : booking); };
  Booking.exists = async (query) => query.status === "requested" ? true : exists;
  expireOffer = async (args) => { closed = args; return { data: {} }; };
  const result = await getNextProviders({ bookingId: "booking", userId: "customer", now });
  assert.equal(result.data.providers.length, 1);
  assert.equal(closed.userId, "customer");
  assert.equal(closed.expired, true);
});

test("provider lookup rejects an attempt that has expired", async () => {
  setup();
  Booking.findOne = (query) => {
    captured.bookingQuery = query;
    return lean(booking.flow.attemptExpiresAt > query["flow.attemptExpiresAt"].$gt ? booking : null);
  };
  const result = await getNextProviders({
    bookingId: "booking", userId: "customer", now: booking.flow.attemptExpiresAt,
  });
  assert.equal(result.error, "booking_offer_unavailable");
});

test("routing errors are surfaced, not silently reported as no providers", async () => {
  setup();
  routeError = new Error("routing unavailable");
  await assert.rejects(getNextProviders({ bookingId: "booking", userId: "customer", now }), /routing unavailable/);
});

test.after(() => {
  Booking.findOne = saved.findOne; Booking.exists = saved.exists; Booking.find = saved.bookings;
  BookingOffer.find = saved.offers; BusinessProfile.find = saved.profiles; Review.aggregate = saved.ratings;
  BusinessProfile.findById = saved.profileById;
  User.find = saved.users; Services.find = saved.serviceFind; Services.findById = saved.serviceId;
  Packages.find = saved.packageFind; pricing.getInstantSettings = saved.settings; route.resolveDrivingDurations = saved.durations;
});
