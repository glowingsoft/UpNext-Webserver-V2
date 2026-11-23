const AdminSettings = require("@models/AdminSettings");

// Prices are stored as dollars on services; everything instant works in cents.
const toCents = (dollars) => Math.round(Number(dollars) * 100);

const DEFAULTS = {
  feeFloorCents: 700,
  feeRatePercent: 8,
  feeCapCents: 2000,
  minInstantPriceCents: 2500,
  depositPercent: 15,
  providerAcceptSec: 120,
  providerAcceptSecAdvance: 1800,
  paymentSec: 300,
  customerDecisionSec: 180,
  maxAttemptMinutes: 15,
  maxAdvanceDays: 7,
  scoringWeights: { travelTime: 100, rating: 50, acceptanceRate: 30, similarity: 20 },
  timeoutStreakLimit: 3,
  instantPayoutFeePercent: 1.5,
  offerWindowSec: 90,
  maxProviders: 3,
  maxSearchSec: 300,
  radiusKm: 25,
  penaltyDeductionCents: 700,
  penaltyWindowDays: 30,
  suspensionHours: 24,
  noShowReportWindowMin: 60,
  noShowContestWindowHours: 24,
};

const mergeInstantSettings = (saved = {}) => {
  return {
    ...DEFAULTS,
    ...saved,
    scoringWeights: { ...DEFAULTS.scoringWeights, ...(saved.scoringWeights || {}) },
  };
};

const getInstantSettings = async () => {
  const doc = await AdminSettings.findOne({}, "instant").lean();
  return mergeInstantSettings(doc?.instant);
};

// min(cap, max(floor, rate x price)), rounded to a whole cent.
const bookingFeeCents = (servicePriceCents, s) =>
  Math.min(s.feeCapCents, Math.max(s.feeFloorCents, Math.round((servicePriceCents * s.feeRatePercent) / 100)));

const depositCents = (servicePriceCents, s) => Math.round((servicePriceCents * s.depositPercent) / 100);

/**
 * Snapshot for one (price, promo) pair. A promo only ever reduces the booking
 * fee — never the provider's price, deposit or payout — and can't take it
 * below zero. `heldCents` is the authorization amount; on a reroute it is
 * carried over from the original booking while everything else is recomputed.
 */
const computeInstantPricing = ({ servicePriceCents, promoDiscountCents = 0, settings, heldCents = null }) => {
  const feeCents = bookingFeeCents(servicePriceCents, settings);
  const discount = Math.min(Math.max(0, promoDiscountCents), feeCents);
  const chargeFeeCents = feeCents - discount;
  const totalCents = servicePriceCents + chargeFeeCents;
  return {
    servicePriceCents,
    depositCents: depositCents(servicePriceCents, settings),
    feeCents,
    promoDiscountCents: discount,
    chargeFeeCents,
    totalCents,
    heldCents: heldCents ?? totalCents,
    settings: {
      feeFloorCents: settings.feeFloorCents,
      feeRatePercent: settings.feeRatePercent,
      feeCapCents: settings.feeCapCents,
      minInstantPriceCents: settings.minInstantPriceCents,
      depositPercent: settings.depositPercent,
    },
  };
};

// Legacy cancellation path: never capture the booking fee as a cancellation charge.
const cancellationCaptureCents = (pricing) => Math.min(pricing.heldCents, pricing.depositCents);

module.exports = {
  toCents,
  getInstantSettings,
  mergeInstantSettings,
  bookingFeeCents,
  computeInstantPricing,
  cancellationCaptureCents,
  INSTANT_DEFAULTS: DEFAULTS,
};
