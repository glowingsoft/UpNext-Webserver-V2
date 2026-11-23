const mongoose = require("mongoose");
const Card = require("@models/Card");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { getInstantSettings, computeInstantPricing, toCents } = require("@utils/instantPricing");
const { savedCardIsValid, resolveScheduledSlot } = require("@utils/bookingEligibility");
const { resolveDrivingDurations } = require("@utils/routeDistanceHelper");
const { AGREEMENT_TEXT, AGREEMENT_VERSION, cancellationPolicyText } = require("@utils/bookingPolicy");

const invalid = (error, status = 400) => ({ error, status });
const validCoordinates = (coords) => Array.isArray(coords) && coords.length === 2 &&
  coords.every(Number.isFinite) && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90 &&
  (coords[0] !== 0 || coords[1] !== 0);

const validateBookingRequest = async ({ userId, body, now = new Date() }) => {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !["service", "package"].includes(body.scope) ||
      !mongoose.isValidObjectId(body.targetId) ||
      !mongoose.isValidObjectId(body.providerId) ||
      typeof body.stripePaymentMethodId !== "string" || !body.stripePaymentMethodId.trim()) {
    return invalid("invalid_request");
  }
  if (body.agreedNonRefundable !== true || body.agreementVersion !== AGREEMENT_VERSION) {
    return invalid("instant_agreement_required");
  }
  if (body.promotionId) return invalid("instant_promotion_unavailable");
  const origin = [body.lng, body.lat];
  if (!validCoordinates(origin)) return invalid("location_required");
  const model = body.scope === "service" ? Services : Packages;
  const [settings, card, entity] = await Promise.all([
    getInstantSettings(),
    Card.findOne({ user: userId, paymentMethodId: body.stripePaymentMethodId }).lean(),
    model.findById(body.targetId).lean(),
  ]);
  if (!savedCardIsValid(card, now)) return invalid("booking_saved_card_required");
  if (!entity || entity.status !== "active" || entity.isAvailable !== true ||
      String(entity.business) !== String(body.providerId)) return invalid("booking_entity_not_found", 404);
  const price = toCents(entity.price);
  if (!Number.isSafeInteger(price) || price < settings.minInstantPriceCents) return invalid("instant_price_too_low");
  const profile = await BusinessProfile.findOne({
    _id: entity.business, status: "active", isAvailable: true,
    $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
  }).lean();
  if (!profile || String(profile.user) === String(userId)) return invalid("instant_provider_unavailable", 409);
  const owner = await User.findOne({ _id: profile.user, "accountState.status": "active" }, "timezone").lean();
  if (!owner) return invalid("instant_provider_unavailable", 409);
  const schedule = resolveScheduledSlot({
    date: body.date, slot: body.slot, timezone: owner.timezone, slots: entity.slots,
    operatingHours: profile.operatingHours, now, maxAdvanceDays: settings.maxAdvanceDays,
  });
  if (!schedule) return invalid("booking_slot_invalid");
  if (schedule.appointmentStart.getTime() - now.getTime() > 7 * 86400000) {
    return invalid("instant_advance_unavailable");
  }
  if (!Number.isSafeInteger(entity.concurrentClients) || entity.concurrentClients < 1) {
    throw new Error("Invalid listing capacity");
  }
  const occupied = await Booking.countDocuments({
    scope: body.scope, "target._id": entity._id, date: schedule.date,
    "slot.open": schedule.slot.open, "slot.close": schedule.slot.close, status: { $in: ["confirmed", "ongoing"] },
  });
  if (occupied >= entity.concurrentClients) return invalid("booking_slot_full", 409);
  if (schedule.isAvailableNow) {
    if (!validCoordinates(profile.location?.coordinates)) return invalid("instant_provider_unavailable", 409);
    const [duration] = await resolveDrivingDurations({ origin, destinations: [profile.location.coordinates] });
    if (duration === null || duration > 1800) return invalid("instant_provider_unavailable", 409);
    if (!Number.isFinite(duration) || duration < 0) throw new Error("Invalid provider travel duration");
  }
  const policy = entity.cancellationPolicy || "non_refundable";
  return {
    data: {
      entity,
      profile,
      schedule,
      origin,
      settings,
      pricing: computeInstantPricing({ servicePriceCents: price, settings, heldCents: 0 }),
      agreement: { text: AGREEMENT_TEXT, version: AGREEMENT_VERSION, agreedAt: now },
      cancellationPolicySnapshot: { policy, text: cancellationPolicyText(policy), version: AGREEMENT_VERSION },
    },
  };
};

module.exports = { validateBookingRequest };
