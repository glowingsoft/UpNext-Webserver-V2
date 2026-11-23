const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const Review = require("@models/Review");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { getInstantSettings, toCents } = require("@utils/instantPricing");
const { resolveScheduledSlot } = require("@utils/bookingEligibility");
const { resolveDrivingDurations } = require("@utils/routeDistanceHelper");
const { rankBookingCandidates } = require("@utils/bookingRanking");
const { findCustomerDecisionBooking } = require("./bookingCustomerDecision");
const { profileSimilarity, profileMatchConditions, firstProviderProfile } = require("./bookingProviderMatching");

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const validCoordinates = (coords) => Array.isArray(coords) && coords.length === 2 &&
  coords.every(Number.isFinite) && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90 &&
  (coords[0] !== 0 || coords[1] !== 0);
const unavailable = () => ({ error: "booking_offer_unavailable", status: 409 });

const getNextProviders = async ({ bookingId, userId, now = new Date() }) => {
  const booking = await findCustomerDecisionBooking({ bookingId, userId, now });
  if (!booking) return unavailable();
  const respond = async (providers, extra = {}) => {
    const serverNow = new Date();
    const stillOpen = await Booking.exists({
      _id: bookingId, user: userId, status: "awaiting_customer_decision",
      "flow.attemptExpiresAt": { $eq: booking.flow.attemptExpiresAt, $gt: serverNow },
    });
    if (!stillOpen) return unavailable();
    return {
      data: {
        providers,
        deadline: booking.flow.attemptExpiresAt,
        serverNow,
        ...extra,
      },
    };
  };
  if (!["service", "package"].includes(booking.scope) || !booking.flow?.categoryId ||
      !booking.flow?.location?.coordinates || !booking.date || !booking.slot) {
    throw new Error("Booking is missing data needed for provider matching");
  }
  const settings = await getInstantSettings();
  const offers = await BookingOffer.find({ booking: bookingId }, "business status sentAt").lean();
  const tried = [...new Set(offers.map((offer) => String(offer.business)))];
  if (tried.length >= settings.maxProviders) {
    return respond([], { providerLimitReached: true });
  }

  const originalProfile = await firstProviderProfile(offers);
  const conditions = profileMatchConditions(originalProfile);
  const relatedProfiles = conditions.length ? await BusinessProfile.find({
    status: "active", isAvailable: true,
    _id: { $nin: tried },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: conditions },
    ],
  }, "_id").lean() : [];
  const query = {
    $or: [
      { category: booking.flow.categoryId, subcategory: booking.flow.subcategoryId || null },
      ...(relatedProfiles.length ? [{ business: { $in: relatedProfiles.map((profile) => profile._id) } }] : []),
    ],
    status: "active",
    isAvailable: true,
    business: { $nin: tried },
    price: { $gte: settings.minInstantPriceCents / 100 },
  };
  const [services, packages] = await Promise.all([Services.find(query).lean(), Packages.find(query).lean()]);
  const entities = [
    ...services.map((entity) => ({ ...entity, scope: "service" })),
    ...packages.map((entity) => ({ ...entity, scope: "package" })),
  ];
  const businessIds = [...new Set(entities.map((entity) => String(entity.business)))];
  if (!businessIds.length) return respond([]);

  const profiles = await BusinessProfile.find({
    _id: { $in: businessIds },
    status: "active",
    isAvailable: true,
    $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
  }).lean();
  const [owners, ratings, occupied] = await Promise.all([
    User.find({ _id: { $in: profiles.map((profile) => profile.user) }, "accountState.status": "active" }, "timezone").lean(),
    Review.aggregate([
      { $match: { business: { $in: profiles.map((profile) => profile._id) }, status: "approved" } },
      { $group: { _id: "$business", rating: { $avg: "$rating" } } },
    ]),
    Booking.find({
      status: { $in: ["confirmed", "ongoing"] },
      "target._id": { $in: entities.map((entity) => entity._id) },
      date: booking.date,
      "slot.open": booking.slot.open,
      "slot.close": booking.slot.close,
    }, "target").lean(),
  ]);
  const ownersById = new Map(owners.map((owner) => [String(owner._id), owner]));
  const profilesById = new Map(profiles.map((profile) => [String(profile._id), profile]));
  const ratingsById = new Map(ratings.map((row) => [String(row._id), row.rating]));
  const counts = new Map();
  for (const row of occupied) {
    const key = String(row.target?.[0]?._id);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const date = new Date(booking.date).toISOString().slice(0, 10);
  const matches = [];
  for (const entity of entities) {
    const profile = profilesById.get(String(entity.business));
    const owner = profile && ownersById.get(String(profile.user));
    const sameSubcategory = (booking.flow.subcategoryId == null && entity.subcategory == null) ||
      sameId(booking.flow.subcategoryId, entity.subcategory);
    const originalCategory = sameId(booking.flow.categoryId, entity.category) && sameSubcategory;
    if (!profile || !owner || sameId(profile.user, userId) ||
        (!originalCategory && profileSimilarity(originalProfile, profile) === 0) ||
        !validCoordinates(profile.location?.coordinates) ||
        !Number.isInteger(entity.concurrentClients) || entity.concurrentClients < 1 ||
        (counts.get(String(entity._id)) || 0) >= entity.concurrentClients) continue;
    const scheduled = resolveScheduledSlot({
      date, slot: booking.slot, timezone: owner.timezone, slots: entity.slots,
      operatingHours: profile.operatingHours, now, maxAdvanceDays: settings.maxAdvanceDays,
    });
    if (!scheduled) continue;
    const badgeSimilarity = sameId(booking.flow.preferredServiceType?.badgeId, entity.preferredServiceType?.badgeId) &&
      sameId(booking.flow.preferredServiceType?.optionId, entity.preferredServiceType?.optionId) ? 1 : 0;
    const similarity = Math.max(badgeSimilarity, profileSimilarity(originalProfile, profile));
    matches.push({ entity, profile, scheduled, similarity });
  }
  if (!matches.length) return respond([]);
  const durations = await resolveDrivingDurations({
    origin: booking.flow.location.coordinates,
    destinations: matches.map(({ profile }) => profile.location.coordinates),
  });
  const candidates = matches.flatMap(({ entity, profile, scheduled, similarity }, index) => {
    const travelSeconds = durations[index];
    if (travelSeconds !== null && (!Number.isFinite(travelSeconds) || travelSeconds < 0)) {
      throw new Error("Invalid travel duration returned for provider");
    }
    if (travelSeconds === null || (scheduled.isAvailableNow && travelSeconds > 1800)) return [];
    return [{
      businessId: profile._id,
      businessName: profile.businessName,
      targetId: entity._id,
      targetName: entity.name,
      scope: entity.scope,
      priceCents: toCents(entity.price),
      travelSeconds,
      rating: ratingsById.get(String(profile._id)) || 0,
      matchStats: profile.matchStats,
      penaltyWeight: profile.matchStats?.penaltyWeight30d || 0,
      similarity,
    }];
  });
  const ranked = rankBookingCandidates(candidates, settings.scoringWeights);
  const grouped = new Map();
  for (const candidate of ranked) {
    const key = String(candidate.businessId);
    if (!grouped.has(key)) grouped.set(key, { ...candidate, alternatives: [] });
    else grouped.get(key).alternatives.push({
      targetId: candidate.targetId, targetName: candidate.targetName,
      scope: candidate.scope, priceCents: candidate.priceCents,
    });
  }
  return respond([...grouped.values()]);
};

module.exports = { getNextProviders };
