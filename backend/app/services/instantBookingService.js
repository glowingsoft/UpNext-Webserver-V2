const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const Payment = require("@models/Payment");
const { Services } = require("@models/Services");
const { Promotion } = require("@models/Promotions");
const PromotionUsage = require("@models/PromotionUsage");
const { User } = require("@models/UserModel");
const { NotificationTypes } = require("@models/Notifications");
const { userCache } = require("@config/nodeCache");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { getInstantSettings, computeInstantPricing, cancellationCaptureCents, toCents } = require("@utils/instantPricing");
const { recordPenalty } = require("./penaltyService");
const { startSearch, cancelSearch } = require("./instantOfferService");
const { holdInstantPayment, releaseHold, beginCapture } = require("./instantPaymentService");

const AGREEMENT_TEXT = "Once a provider accepts, your deposit and booking fee are non-refundable.";
const AGREEMENT_VERSION = "instant-v1";
const ACTIVE_STATUSES = ["searching", "scheduled"];

const history = (status, by, note) => ({ status, at: new Date(), by, ...(note && { note }) });
const notify = (opts) => sendUserNotifications(opts);
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const validCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

const setInstantBlocked = async (userId, blocked) => {
  await User.updateOne({ _id: userId }, { $set: { instantBlocked: blocked } });
  userCache.del(String(userId));
};

const generateBookingId = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `IB-${ts}-${rand}`;
};

// A promo only ever shrinks the booking fee.
const promoFeeDiscountCents = (promotion, feeCents) => {
  if (!promotion) return 0;
  const raw =
    promotion.discountType === "percentage"
      ? Math.round((feeCents * promotion.discount) / 100)
      : toCents(promotion.discount);
  return Math.min(feeCents, Math.max(0, raw));
};

const loadService = async (targetId) => {
  const service = await Services.findById(targetId).lean();
  if (!service || ["deleted", "inactive"].includes(service.status)) return null;
  return service;
};

const businessUnavailable = (profile) =>
  !profile ||
  profile.status !== "active" ||
  profile.isAvailable === false ||
  (profile.suspendedUntil && profile.suspendedUntil > new Date());

// ─── Quote ─────────────────────────────────────────────────────────────────

const quote = async ({ targetId, promotionId }) => {
  const service = await loadService(targetId);
  if (!service) return { error: "booking_entity_not_found", status: 404 };
  const settings = await getInstantSettings();
  const servicePriceCents = toCents(service.price);
  const fee = computeInstantPricing({ servicePriceCents, settings }).feeCents;

  let promotion = null;
  if (promotionId) {
    promotion = await Promotion.findOne({
      _id: promotionId,
      targetId: service._id,
      status: "active",
      expiresAt: { $gt: new Date() },
    }).lean();
  }
  const pricing = computeInstantPricing({
    servicePriceCents,
    promoDiscountCents: promoFeeDiscountCents(promotion, fee),
    settings,
  });
  delete pricing.settings;
  return {
    data: {
      eligible: servicePriceCents >= settings.minInstantPriceCents,
      minInstantPriceCents: settings.minInstantPriceCents,
      pricing,
      agreement: { text: AGREEMENT_TEXT, version: AGREEMENT_VERSION },
    },
  };
};

// ─── Checkout ──────────────────────────────────────────────────────────────

const createInstantBooking = async ({ userId, body }) => {
  const { targetId, stripePaymentMethodId, promotionId, agreedNonRefundable, agreementVersion } = body;
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const matchSimilar = body.matchSimilar === true || body.matchSimilar === "true";

  if (agreedNonRefundable !== true || agreementVersion !== AGREEMENT_VERSION) {
    return { error: "instant_agreement_required", status: 400 };
  }
  if (!validCoord(lat, lng)) return { error: "location_required", status: 400 };
  if (!stripePaymentMethodId) return { error: "payment_method_required", status: 400 };

  const user = await User.findById(userId);
  if (!user) return { error: "user_not", status: 404 };
  if (user.instantBlocked) return { error: "instant_blocked_update_card", status: 403 };

  const service = await loadService(targetId);
  if (!service) return { error: "booking_entity_not_found", status: 404 };

  const settings = await getInstantSettings();
  const servicePriceCents = toCents(service.price);
  if (servicePriceCents < settings.minInstantPriceCents) {
    return { error: "instant_price_too_low", status: 400, data: { minInstantPriceCents: settings.minInstantPriceCents } };
  }

  const active = await Booking.exists({ user: userId, mode: "instant", status: { $in: ACTIVE_STATUSES } });
  if (active) return { error: "instant_booking_in_progress", status: 409 };

  const profile = await BusinessProfile.findById(service.business, "user status isAvailable suspendedUntil").lean();
  if (!profile || String(profile.user) === String(userId)) return { error: "booking_entity_not_found", status: 404 };
  if (businessUnavailable(profile) && !matchSimilar) return { error: "instant_provider_unavailable", status: 409 };

  let promotion = null;
  if (promotionId) {
    promotion = await Promotion.findOne({
      _id: promotionId,
      targetId: service._id,
      status: "active",
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!promotion) return { error: "promotion_not_found", status: 400 };
    const [totalUsed, userUsed] = await Promise.all([
      PromotionUsage.countDocuments({ promotion: promotion._id }),
      PromotionUsage.countDocuments({ promotion: promotion._id, user: userId }),
    ]);
    if (totalUsed >= promotion.totalUsageLimit) return { error: "promotion_usage_limit_reached", status: 400 };
    if (userUsed >= promotion.perUserLimit) return { error: "promotion_user_limit_reached", status: 400 };
  }

  const baseFee = computeInstantPricing({ servicePriceCents, settings }).feeCents;
  const pricing = computeInstantPricing({
    servicePriceCents,
    promoDiscountCents: promoFeeDiscountCents(promotion, baseFee),
    settings,
  });

  const _id = new mongoose.Types.ObjectId();
  const hold = await holdInstantPayment({
    user,
    bookingId: _id,
    totalCents: pricing.totalCents,
    paymentMethod: stripePaymentMethodId,
    businessId: profile._id,
  });
  if (!hold.ok) {
    if (hold.flagClient) await setInstantBlocked(userId, true);
    return { error: "instant_hold_failed", status: 402, data: { message: hold.message } };
  }
  if (user.instantBlocked) await setInstantBlocked(userId, false);

  const now = new Date();
  const slotMins = service.sessionSlotMins || 60;
  const closeDate = new Date(now.getTime() + slotMins * 60 * 1000);
  const open = hhmm(now);
  const close = hhmm(closeDate);

  let booking;
  try {
    booking = await Booking.create({
      _id,
      bookingId: generateBookingId(),
      mode: "instant",
      scope: "service",
      source: "UpNext",
      target: [{ name: service.name, price: servicePriceCents / 100 }],
      slot: { open, close, isOverNight: close < open },
      date: now,
      status: "searching",
      statusHistory: [history("searching", "user")],
      instant: {
        requestedAt: now,
        location: { type: "Point", coordinates: [lng, lat] },
        categoryId: service.category,
        chosenBusiness: profile._id,
        matchSimilar,
        searchStartedAt: now,
        searchDeadline: new Date(now.getTime() + settings.maxSearchSec * 1000),
      },
      pricing,
      agreement: { text: AGREEMENT_TEXT, version: agreementVersion, agreedAt: now },
      payment: hold.paymentDoc._id,
      paymentStatus: "authorized",
      user: userId,
      business: profile._id,
    });
    if (promotion) {
      await PromotionUsage.create({ promotion: promotion._id, user: userId, booking: booking._id });
    }
  } catch (err) {
    // Never leave a hold behind without a booking to own it
    await Booking.deleteOne({ _id });
    hold.paymentDoc.status = "pending";
    await hold.paymentDoc.save();
    const { cancelStripePayment } = require("@services/stripePayment");
    await cancelStripePayment(hold.paymentDoc.stripePaymentId).catch(() => {});
    hold.paymentDoc.status = "released";
    await hold.paymentDoc.save();
    throw err;
  }

  await startSearch(booking._id);
  return { data: await Booking.findById(booking._id).lean() };
};

// ─── Reads ─────────────────────────────────────────────────────────────────

const getInstantBooking = async ({ id, userId, businessId }) => {
  const filter = { _id: id, mode: "instant", ...(businessId ? { business: businessId } : { user: userId }) };
  const booking = await Booking.findOne(filter).lean();
  if (!booking) return { error: "booking_not_found", status: 404 };
  return { data: booking };
};

const getCurrentOffer = async ({ businessId }) => {
  const offer = await BookingOffer.findOne({
    business: businessId,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!offer) return { data: null };
  const booking = await Booking.findById(offer.booking, "bookingId target instant.location pricing.servicePriceCents").lean();
  return {
    data: {
      offerId: offer._id,
      bookingId: offer.booking,
      expiresAt: offer.expiresAt,
      serverNow: new Date(),
      servicePriceCents: offer.servicePriceCents,
      booking,
    },
  };
};

// ─── Client cancel ─────────────────────────────────────────────────────────

const clientCancel = async ({ id, userId, reason }) => {
  const existing = await Booking.findOne({ _id: id, user: userId, mode: "instant" }, "status").lean();
  if (!existing) return { error: "booking_not_found", status: 404 };
  if (existing.status === "searching") return cancelSearch({ bookingId: id, userId });

  // After accept an instant booking is always non-refundable: deposit + fee are captured, the rest released.
  const booking = await Booking.findOneAndUpdate(
    { _id: id, user: userId, mode: "instant", status: "scheduled" },
    {
      $set: { status: "canceled", cancel: { by: "user", reason: reason || "canceled_after_accept" } },
      $push: { statusHistory: history("canceled", "user", reason) },
    },
    { new: true },
  );
  if (!booking) return { error: "booking_cannot_cancel", status: 400 };

  await beginCapture(booking._id, { kind: "cancellation", amountCents: cancellationCaptureCents(booking.pricing) });
  notify({
    recipientIds: [booking.business],
    title: "Booking canceled",
    body: "The client canceled the instant booking.",
    data: { type: "instant_canceled", objectType: "booking", bookingId: String(booking._id) },
    notificationType: NotificationTypes.BOOKING_CANCELED,
    objectId: booking._id,
  });
  return { data: await Booking.findById(id).lean() };
};

// ─── Provider cancel + automatic rematch ───────────────────────────────────

const providerCancel = async ({ id, businessId, reason }) => {
  const booking = await Booking.findOneAndUpdate(
    {
      _id: id,
      business: businessId,
      mode: "instant",
      status: "scheduled",
      "instant.checkIns.arrived.at": { $exists: false },
    },
    {
      $set: { status: "canceled", cancel: { by: "business", reason: reason || "canceled_by_provider" } },
      $push: { statusHistory: history("canceled", "business", reason) },
    },
    { new: true },
  );
  if (!booking) return { error: "booking_cannot_cancel", status: 400 };

  // Nothing was captured: the client pays nothing, the provider takes a penalty.
  const oldPayment = await Payment.findById(booking.payment);
  await releaseHold(booking._id);
  await recordPenalty({ providerId: businessId, bookingId: booking._id, type: "cancellation", note: reason });

  const user = await User.findById(booking.user);
  const pmId = oldPayment?.paymentObject?.paymentMethod;
  const hold =
    user && pmId
      ? await holdInstantPayment({
          user,
          bookingId: booking._id,
          totalCents: booking.pricing.totalCents,
          paymentMethod: pmId,
          businessId: booking.business,
          offSession: true,
        })
      : { ok: false, flagClient: false };

  if (!hold.ok) {
    if (hold.flagClient) await setInstantBlocked(booking.user, true);
    notify({
      recipientIds: [booking.user],
      title: "Booking canceled",
      body: "Your provider canceled and we couldn't find a replacement. You were not charged.",
      data: { type: "instant_canceled", objectType: "booking", bookingId: String(booking._id) },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
    return { data: { booking: await Booking.findById(id).lean(), rematch: false } };
  }

  const now = new Date();
  const settings = await getInstantSettings();
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        status: "searching",
        payment: hold.paymentDoc._id,
        paymentStatus: "authorized",
        "pricing.heldCents": booking.pricing.totalCents,
        "instant.matchSimilar": true,
        "instant.providersTried": 0,
        "instant.searchStartedAt": now,
        "instant.searchDeadline": new Date(now.getTime() + settings.maxSearchSec * 1000),
        "instant.offer.current": null,
        "instant.offer.expiresAt": null,
        "instant.checkIns": {},
      },
      $unset: { cancel: "" },
      $addToSet: { "instant.excluded": businessId },
      $push: { statusHistory: history("searching", "system", "rematch_after_provider_cancel") },
    },
  );
  notify({
    recipientIds: [booking.user],
    title: "Finding you another provider",
    body: "Your provider canceled. We're looking for a replacement; you have not been charged.",
    data: { type: "instant_rematch", objectType: "booking", bookingId: String(booking._id) },
    notificationType: NotificationTypes.SYSTEM,
    objectId: booking._id,
  });
  // advance(), not startSearch(): the first offer to the "chosen" provider is over
  await require("./instantOfferService").advance(booking._id);
  return { data: { booking: await Booking.findById(id).lean(), rematch: true } };
};

// ─── Check-ins ─────────────────────────────────────────────────────────────

const arrived = async ({ id, businessId, lat, lng }) => {
  if (!validCoord(Number(lat), Number(lng))) return { error: "location_required", status: 400 };
  const booking = await Booking.findOneAndUpdate(
    { _id: id, business: businessId, mode: "instant", status: "scheduled", "instant.checkIns.arrived.at": { $exists: false } },
    { $set: { "instant.checkIns.arrived": { at: new Date(), lat: Number(lat), lng: Number(lng) } } },
    { new: true },
  );
  if (!booking) return { error: "booking_cannot_check_in", status: 400 };
  notify({
    recipientIds: [booking.user],
    title: "Your provider has arrived",
    body: "Your provider checked in at your location.",
    data: { type: "instant_arrived", objectType: "booking", bookingId: String(booking._id) },
    notificationType: NotificationTypes.BOOKING_PICKED,
    objectId: booking._id,
  });
  return { data: booking };
};

const complete = async ({ id, businessId, lat, lng }) => {
  if (!validCoord(Number(lat), Number(lng))) return { error: "location_required", status: 400 };
  const booking = await Booking.findOneAndUpdate(
    {
      _id: id,
      business: businessId,
      mode: "instant",
      status: "scheduled",
      "instant.checkIns.arrived.at": { $exists: true },
      "instant.noShow.status": "none",
    },
    {
      $set: {
        status: "completed",
        "instant.checkIns.completed": { at: new Date(), lat: Number(lat), lng: Number(lng) },
      },
      $push: { statusHistory: history("completed", "business") },
    },
    { new: true },
  );
  if (!booking) return { error: "booking_cannot_complete", status: 400 };

  await beginCapture(booking._id, { kind: "completion", amountCents: booking.pricing.totalCents });
  notify({
    recipientIds: [booking.user],
    title: "Service completed",
    body: "Your service was completed.",
    data: { type: "instant_completed", objectType: "booking", bookingId: String(booking._id) },
    notificationType: NotificationTypes.BOOKING_COMPLETED,
    objectId: booking._id,
  });
  return { data: await Booking.findById(id).lean() };
};

// ─── No-show ───────────────────────────────────────────────────────────────

const reportNoShow = async ({ id, userId }) => {
  const settings = await getInstantSettings();
  const cutoff = new Date(Date.now() - settings.noShowReportWindowMin * 60 * 1000);
  const booking = await Booking.findOneAndUpdate(
    {
      _id: id,
      user: userId,
      mode: "instant",
      status: "scheduled",
      "instant.requestedAt": { $gte: cutoff },
      "instant.checkIns.arrived.at": { $exists: false },
    },
    {
      $set: {
        status: "canceled",
        cancel: { by: "system", reason: "provider_no_show_reported" },
        "instant.noShow": { status: "reported", reportedAt: new Date() },
      },
      $push: { statusHistory: history("canceled", "user", "no_show_reported") },
    },
    { new: true },
  );
  if (!booking) return { error: "no_show_cannot_report", status: 400 };

  // Nothing is captured on a reported no-show; the client pays nothing.
  await releaseHold(booking._id);
  notify({
    recipientIds: [booking.business],
    title: "No-show reported",
    body: "A client reported you as a no-show. You can contest this within 24 hours.",
    data: { type: "instant_no_show", objectType: "booking", bookingId: String(booking._id) },
    notificationType: NotificationTypes.SYSTEM,
    objectId: booking._id,
  });
  return { data: await Booking.findById(id).lean() };
};

const contestNoShow = async ({ id, businessId, note }) => {
  const settings = await getInstantSettings();
  const cutoff = new Date(Date.now() - settings.noShowContestWindowHours * 60 * 60 * 1000);
  const booking = await Booking.findOneAndUpdate(
    {
      _id: id,
      business: businessId,
      mode: "instant",
      "instant.noShow.status": "reported",
      "instant.noShow.reportedAt": { $gte: cutoff },
    },
    { $set: { "instant.noShow.status": "contested", "instant.noShow.contestedAt": new Date(), "instant.noShow.contestNote": note || "" } },
    { new: true },
  );
  if (!booking) return { error: "no_show_cannot_contest", status: 400 };
  return { data: booking };
};

// Upheld: provider penalty (weight 2). Overturned: no penalty, no re-charge, provider gets nothing.
const resolveNoShow = async ({ id, outcome, note }) => {
  const booking = await Booking.findOneAndUpdate(
    { _id: id, mode: "instant", "instant.noShow.status": { $in: ["reported", "contested"] } },
    {
      $set: {
        "instant.noShow.status": outcome,
        "instant.noShow.resolvedAt": new Date(),
        "instant.noShow.resolutionNote": note || "",
      },
    },
    { new: true },
  );
  if (!booking) return { error: "no_show_cannot_resolve", status: 400 };
  if (outcome === "upheld") {
    await recordPenalty({ providerId: booking.business, bookingId: booking._id, type: "no_show", note });
  }
  return { data: booking };
};

module.exports = {
  AGREEMENT_TEXT,
  AGREEMENT_VERSION,
  quote,
  createInstantBooking,
  getInstantBooking,
  getCurrentOffer,
  clientCancel,
  providerCancel,
  arrived,
  complete,
  reportNoShow,
  contestNoShow,
  resolveNoShow,
};
