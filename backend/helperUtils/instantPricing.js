const AdminSettings = require("@models/AdminSettings");

// Prices are stored as dollars on services; everything instant works in cents.
const toCents = (dollars) => Math.round(Number(dollars) * 100);

const DEFAULTS = {
  feeFloorCents: 700,
  feeRatePercent: 8,
  feeCapCents: 2000,
  minInstantPriceCents: 2500,
  depositPercent: 15,
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

const getInstantSettings = async () => {
  const doc = await AdminSettings.findOne({}, "instant").lean();
  return { ...DEFAULTS, ...(doc?.instant || {}) };
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

// What a non-refundable client cancellation after accept captures.
const cancellationCaptureCents = (pricing) => Math.min(pricing.heldCents, pricing.depositCents + pricing.chargeFeeCents);

module.exports = {
  toCents,
  getInstantSettings,
  bookingFeeCents,
  computeInstantPricing,
  cancellationCaptureCents,
  INSTANT_DEFAULTS: DEFAULTS,
};
