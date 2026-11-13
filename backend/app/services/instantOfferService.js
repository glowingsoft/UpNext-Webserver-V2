const mongoose = require("mongoose");
const { EventEmitter } = require("events");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { Services } = require("@models/Services");
const { User } = require("@models/UserModel");
const { NotificationTypes } = require("@models/Notifications");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { emitOfferReceived, emitOfferClosed } = require("@socketIo/instantOfferSocketEmitter");
const { getInstantSettings, computeInstantPricing, toCents } = require("@utils/instantPricing");
const { rankCandidates } = require("@utils/instantRanking");
const { buildDaySegments } = require("@utils/serviceUtil");
const { rollingWeights } = require("./penaltyService");

/**
 * Terminal transitions the payments layer reacts to (release / capture holds):
 *   "accepted"        { booking }                 - provider took the job
 *   "searchEnded"     { booking, reason }         - no_match, nothing was accepted
 *   "searchCanceled"  { booking }                 - client canceled before accept
 */
const instantEvents = new EventEmitter();

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STUCK_SEARCH_MS = 10 * 1000;

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const history = (status, by = "system", note) => ({ status, at: new Date(), by, ...(note && { note }) });
const freeOfferClause = (now) => ({ $or: [{ "liveOffer.offer": null }, { "liveOffer.expiresAt": { $lte: now } }] });

// ─── Eligibility ───────────────────────────────────────────────────────────

const isOpenNow = (operatingHours = [], now = new Date()) => {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = operatingHours.find((d) => d.dayOfWeek === DAYS[now.getDay()]);
  const yesterday = operatingHours.find((d) => d.dayOfWeek === DAYS[(now.getDay() + 6) % 7]);
  const inside = (segments, m) => segments.some((s) => m >= s.start && m < s.end);
  return inside(buildDaySegments(today), minutes) || inside(buildDaySegments(yesterday), minutes + 1440);
};

const stripeReady = (user) => !!user?.stripe?.accountId && !!user.stripe.chargesEnabled && !!user.stripe.onboardingComplete;

/**
 * Ranked reroute candidates: providers near the client who sell the same
 * category, aren't suspended or already holding an offer, are open now, are
 * Stripe-ready, free of another live instant job, and priced so the new total
 * fits inside the existing hold (price can only go down on a reroute).
 */
const findRerouteCandidates = async (booking, settings) => {
  const { instant, pricing } = booking;
  if (!instant.location?.coordinates?.length) return [];
  const now = new Date();
  const excluded = (instant.excluded || []).map(oid);

  const maxPriceDollars = pricing.servicePriceCents / 100;
  const services = await Services.find({
    category: instant.categoryId,
    status: "active",
    isAvailable: { $ne: false },
    business: { $nin: excluded },
    price: { $lte: maxPriceDollars },
  })
    .select("business price name")
    .lean();

  const cheapest = new Map();
  for (const s of services) {
    const cents = toCents(s.price);
    if (cents < settings.minInstantPriceCents) continue;
    const held = computeInstantPricing({
      servicePriceCents: cents,
      promoDiscountCents: pricing.promoDiscountCents,
      settings,
    });
    if (held.totalCents > pricing.heldCents) continue;
    const key = String(s.business);
    if (!cheapest.has(key) || cents < cheapest.get(key).priceCents) {
      cheapest.set(key, { serviceId: s._id, serviceName: s.name, priceCents: cents });
    }
  }
  if (!cheapest.size) return [];

  const businesses = await BusinessProfile.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: instant.location.coordinates },
        distanceField: "distanceM",
        maxDistance: settings.radiusKm * 1000,
        spherical: true,
        query: {
          _id: { $in: [...cheapest.keys()].map(oid) },
          status: "active",
          isAvailable: true,
          ...freeOfferClause(now),
        },
      },
    },
    { $project: { user: 1, distanceM: 1, matchStats: 1, operatingHours: 1 } },
  ]);
  if (!businesses.length) return [];

  const [users, busy, weights] = await Promise.all([
    User.find({ _id: { $in: businesses.map((b) => b.user) } }, "stripe").lean(),
    Booking.distinct("business", {
      mode: "instant",
      status: { $in: ["scheduled", "ongoing"] },
      business: { $in: businesses.map((b) => b._id) },
    }),
    rollingWeights(
      businesses.map((b) => b._id),
      settings.penaltyWindowDays,
    ),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const busySet = new Set(busy.map(String));

  const eligible = businesses
    .filter((b) => stripeReady(userById.get(String(b.user))) && !busySet.has(String(b._id)) && isOpenNow(b.operatingHours, now))
    .map((b) => ({
      businessId: b._id,
      user: b.user,
      distanceM: b.distanceM,
      matchStats: b.matchStats,
      penaltyWeight: weights.get(String(b._id)) || 0,
      ...cheapest.get(String(b._id)),
    }));

  return rankCandidates(eligible, settings);
};

// ─── Offer lifecycle ───────────────────────────────────────────────────────

const clearBookingOffer = (bookingId, offerId, businessId) =>
  Booking.updateOne(
    { _id: bookingId, "instant.offer.current": offerId },
    {
      $set: { "instant.offer.current": null, "instant.offer.expiresAt": null },
      ...(businessId && { $addToSet: { "instant.excluded": businessId } }),
    },
  );

const STAT_FIELD = { accepted: "offersAccepted", declined: "offersDeclined", expired: "offersExpired" };

/**
 * pending -> accepted | declined | expired | closed. The CAS on `pending` is
 * what makes accept / decline / expiry / client-cancel race safely: exactly one
 * caller gets the offer back, everyone else gets null and must stand down.
 */
const transitionOffer = async (offerId, status, { extraFilter = {} } = {}) => {
  const now = new Date();
  const offer = await BookingOffer.findOneAndUpdate(
    { _id: offerId, status: "pending", ...extraFilter },
    { $set: { status, respondedAt: now } },
    { new: true },
  );
  if (!offer) return null;

  const inc = {};
  if (STAT_FIELD[status]) inc[`matchStats.${STAT_FIELD[status]}`] = 1;
  if (status === "accepted" || status === "declined") {
    inc["matchStats.responseSecTotal"] = Math.max(0, Math.round((now - offer.sentAt) / 1000));
    inc["matchStats.responseCount"] = 1;
  }
  const profile = await BusinessProfile.findOneAndUpdate(
    { _id: offer.business },
    { ...(Object.keys(inc).length && { $inc: inc }) },
    { new: true, projection: "user liveOffer" },
  ).lean();
  await BusinessProfile.updateOne({ _id: offer.business, "liveOffer.offer": offer._id }, { $set: { liveOffer: { offer: null, booking: null, expiresAt: null } } });

  if (profile) {
    emitOfferClosed({ userId: profile.user, bookingId: offer.booking, offerId: offer._id, expiresAt: offer.expiresAt });
  }
  return offer;
};

const sendOffer = async (booking, { businessId, user, serviceId, priceCents, score = null }, settings) => {
  const now = new Date();
  const expiresAt = new Date(
    Math.min(now.getTime() + settings.offerWindowSec * 1000, new Date(booking.instant.searchDeadline).getTime()),
  );
  if (expiresAt <= now) return null;

  const offerId = new mongoose.Types.ObjectId();
  const claimed = await BusinessProfile.findOneAndUpdate(
    { _id: businessId, status: "active", isAvailable: true, ...freeOfferClause(now) },
    {
      $set: { liveOffer: { offer: offerId, booking: booking._id, expiresAt }, "matchStats.lastOfferAt": now },
      $inc: { "matchStats.offersReceived": 1 },
    },
  );
  if (!claimed) return null;

  const release = () =>
    BusinessProfile.updateOne(
      { _id: businessId, "liveOffer.offer": offerId },
      { $set: { liveOffer: { offer: null, booking: null, expiresAt: null } }, $inc: { "matchStats.offersReceived": -1 } },
    );

  let offer;
  try {
    offer = await BookingOffer.create({
      _id: offerId,
      booking: booking._id,
      business: businessId,
      serviceId,
      servicePriceCents: priceCents,
      attempt: booking.instant.providersTried + 1,
      score,
      sentAt: now,
      expiresAt,
    });
  } catch (err) {
    await release();
    if (err.code === 11000) return null; // this provider was already offered this booking
    throw err;
  }

  const attached = await Booking.updateOne(
    { _id: booking._id, status: "searching", "instant.offer.current": null },
    { $set: { "instant.offer.current": offerId, "instant.offer.expiresAt": expiresAt }, $inc: { "instant.providersTried": 1 } },
  );
  if (!attached.modifiedCount) {
    // Booking was canceled or advanced by someone else while we were claiming.
    await BookingOffer.updateOne({ _id: offerId, status: "pending" }, { $set: { status: "closed", respondedAt: new Date() } });
    await release();
    return null;
  }

  emitOfferReceived({ userId: user, bookingId: booking._id, offerId, expiresAt });
  sendUserNotifications({
    recipientIds: [user],
    title: "New Up Next request",
    body: "A client needs a service now. Respond before the offer expires.",
    data: { type: "instant_offer", objectType: "booking", bookingId: String(booking._id), offerId: String(offerId), expiresAt: expiresAt.toISOString() },
    notificationType: NotificationTypes.BOOKING_REQUEST,
    objectId: booking._id,
    sender: booking.user,
  });

  return offer;
};

const endSearch = async (bookingId, reason) => {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: "searching" },
    {
      $set: { status: "no_match", cancel: { by: "system", reason }, "instant.offer.current": null, "instant.offer.expiresAt": null },
      $push: { statusHistory: history("no_match", "system", reason) },
    },
    { new: true },
  );
  if (booking) {
    sendUserNotifications({
      recipientIds: [booking.user],
      title: "No provider available",
      body: "We couldn't find a provider right now. You haven't been charged.",
      data: { type: "instant_no_match", objectType: "booking", bookingId: String(booking._id) },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
    instantEvents.emit("searchEnded", { booking, reason });
  }
  return booking;
};

/**
 * Next step after an offer closed without acceptance: reroute to the best
 * eligible provider, or end the search. Limits: max providers per search, the
 * overall deadline, and "match similar pro" must be on to go beyond the pick.
 */
const advance = async (bookingId) => {
  const booking = await Booking.findOne({ _id: bookingId, mode: "instant", status: "searching", "instant.offer.current": null });
  if (!booking) return null;

  const settings = await getInstantSettings();
  const { instant } = booking;
  if (!instant.matchSimilar) return endSearch(bookingId, "provider_unavailable");
  if (instant.providersTried >= settings.maxProviders) return endSearch(bookingId, "max_providers");
  if (new Date(instant.searchDeadline) <= new Date()) return endSearch(bookingId, "search_timeout");

  const candidates = await findRerouteCandidates(booking, settings);
  for (const candidate of candidates) {
    const offer = await sendOffer(booking, candidate, settings);
    if (offer) return offer;
    // Someone else attached an offer or the booking left "searching": stand down.
    const fresh = await Booking.findById(bookingId, "status instant.offer.current").lean();
    if (!fresh || fresh.status !== "searching" || fresh.instant.offer.current) return null;
  }
  return endSearch(bookingId, candidates.length ? "no_provider_accepted" : "no_eligible_provider");
};

/**
 * Entry point once the booking exists with a successful hold: the first offer
 * goes to the client's pick with no ranking or re-eligibility beyond the live
 * offer claim; if that's not possible fall through to the normal reroute.
 */
const startSearch = async (bookingId) => {
  const booking = await Booking.findOne({ _id: bookingId, mode: "instant", status: "searching" });
  if (!booking) return null;
  const settings = await getInstantSettings();
  const chosen = await BusinessProfile.findById(booking.instant.chosenBusiness, "user").lean();
  if (chosen) {
    const offer = await sendOffer(
      booking,
      {
        businessId: chosen._id,
        user: chosen.user,
        serviceId: booking.target[0]._id,
        priceCents: booking.pricing.servicePriceCents,
      },
      settings,
    );
    if (offer) return offer;
  }
  await Booking.updateOne({ _id: bookingId }, { $addToSet: { "instant.excluded": booking.instant.chosenBusiness } });
  return advance(bookingId);
};

const acceptOffer = async ({ offerId, businessId }) => {
  const now = new Date();
  const offer = await transitionOffer(offerId, "accepted", {
    extraFilter: { business: businessId, expiresAt: { $gt: now } },
  });
  if (!offer) return { error: "offer_not_available", status: 409 };

  const [booking, service, settings] = await Promise.all([
    Booking.findById(offer.booking).lean(),
    Services.findById(offer.serviceId).select("name price").lean(),
    getInstantSettings(),
  ]);
  if (!booking || !service) {
    return { error: "offer_not_available", status: 409 };
  }

  const pricing = computeInstantPricing({
    servicePriceCents: offer.servicePriceCents,
    promoDiscountCents: booking.pricing.promoDiscountCents,
    settings,
    heldCents: booking.pricing.heldCents,
  });
  if (pricing.totalCents > pricing.heldCents) {
    await BookingOffer.updateOne({ _id: offer._id }, { $set: { status: "closed" } });
    return { error: "offer_not_available", status: 409 };
  }
  // The snapshot keeps the settings the booking was created under.
  pricing.settings = booking.pricing.settings;

  const accepted = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "searching", "instant.offer.current": offer._id },
    {
      $set: {
        status: "scheduled",
        business: businessId,
        pricing,
        "instant.acceptedAt": now,
        "instant.offer.current": null,
        "instant.offer.expiresAt": null,
        "target.0._id": offer.serviceId,
        "target.0.name": service.name,
        "target.0.price": pricing.servicePriceCents / 100,
      },
      $push: { statusHistory: history("scheduled", "business", "offer_accepted") },
    },
    { new: true },
  );
  if (!accepted) {
    // Client canceled between the offer CAS and here; the cancel path owns the cleanup.
    await BookingOffer.updateOne({ _id: offer._id }, { $set: { status: "closed" } });
    return { error: "offer_not_available", status: 409 };
  }

  sendUserNotifications({
    recipientIds: [accepted.user],
    title: "Provider on the way",
    body: "A provider accepted your request.",
    data: { type: "instant_accepted", objectType: "booking", bookingId: String(accepted._id) },
    notificationType: NotificationTypes.BOOKING_APPROVED,
    objectId: accepted._id,
    sender: businessId,
  });
  instantEvents.emit("accepted", { booking: accepted });
  return { data: accepted };
};

const declineOffer = async ({ offerId, businessId }) => {
  const offer = await transitionOffer(offerId, "declined", { extraFilter: { business: businessId } });
  if (!offer) return { error: "offer_not_available", status: 409 };
  await clearBookingOffer(offer.booking, offer._id, offer.business);
  await advance(offer.booking);
  return { data: { offerId: offer._id } };
};

const expireOffer = async (offerId) => {
  const offer = await transitionOffer(offerId, "expired", { extraFilter: { expiresAt: { $lte: new Date() } } });
  if (!offer) return null;
  await clearBookingOffer(offer.booking, offer._id, offer.business);
  return advance(offer.booking);
};

// Client cancels while still searching: nothing was accepted, the hold is released by the payments layer.
const cancelSearch = async ({ bookingId, userId }) => {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, user: userId, mode: "instant", status: "searching" },
    {
      $set: { status: "canceled", cancel: { by: "user", reason: "canceled_before_accept" } },
      $push: { statusHistory: history("canceled", "user", "canceled_before_accept") },
    },
    { new: true },
  );
  if (!booking) return { error: "booking_cannot_cancel", status: 400 };

  const offerId = booking.instant.offer.current;
  if (offerId) await transitionOffer(offerId, "closed");
  await Booking.updateOne({ _id: booking._id }, { $set: { "instant.offer.current": null, "instant.offer.expiresAt": null } });
  instantEvents.emit("searchCanceled", { booking });
  return { data: booking };
};

// ─── Sweeper (every 5s, under withLock) ────────────────────────────────────

const SWEEP_BATCH = 50;

const runOfferSweeper = async () => {
  const now = new Date();

  const expiring = await Booking.find(
    { mode: "instant", status: "searching", "instant.offer.expiresAt": { $lte: now } },
    "instant.offer.current",
  )
    .limit(SWEEP_BATCH)
    .lean();
  for (const b of expiring) {
    try {
      await expireOffer(b.instant.offer.current);
    } catch (err) {
      console.error(`Offer expiry failed for booking ${b._id}:`, err.message);
    }
  }

  // A crash between closing an offer and sending the next leaves a search with
  // no live offer; nothing else would ever pick it up.
  const stuck = await Booking.find(
    {
      mode: "instant",
      status: "searching",
      "instant.offer.current": null,
      updatedAt: { $lte: new Date(now.getTime() - STUCK_SEARCH_MS) },
    },
    "_id",
  )
    .limit(SWEEP_BATCH)
    .lean();
  for (const b of stuck) {
    try {
      await advance(b._id);
    } catch (err) {
      console.error(`Search recovery failed for booking ${b._id}:`, err.message);
    }
  }
};

module.exports = {
  instantEvents,
  isOpenNow,
  findRerouteCandidates,
  startSearch,
  advance,
  acceptOffer,
  declineOffer,
  expireOffer,
  cancelSearch,
  runOfferSweeper,
};
