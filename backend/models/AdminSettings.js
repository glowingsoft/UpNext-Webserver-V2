const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const adminSettingsSchema = new mongoose.Schema(
  {
    terms_and_conditions: {
      type: String,
      trim: true,
    },
    about_us: {
      type: String,
      trim: true,
    },
    privacy_policy: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);
const settingsSchema = new mongoose.Schema(
  {
    terms_and_conditions: {
      type: translationSchema,
      default: () => ({}),
    },
    about_us: {
      type: translationSchema,
      default: () => ({}),
    },
    privacy_policy: {
      type: translationSchema,
      default: () => ({}),
    },
    // "Up Next" instant booking knobs. Money is integer cents, percentages are
    // plain numbers (8 = 8%). Read through getInstantSettings, never directly.
    instant: {
      feeFloorCents: { type: Number, default: 700, min: 0 },
      feeRatePercent: { type: Number, default: 8, min: 0 },
      feeCapCents: { type: Number, default: 2000, min: 0 },
      minInstantPriceCents: { type: Number, default: 2500, min: 0 },
      depositPercent: { type: Number, default: 15, min: 0, max: 100 },
      instantPayoutFeePercent: { type: Number, default: 1.5, min: 0 },
      offerWindowSec: { type: Number, default: 90, min: 10 },
      maxProviders: { type: Number, default: 3, min: 1 },
      maxSearchSec: { type: Number, default: 300, min: 30 },
      radiusKm: { type: Number, default: 25, min: 1 },
      penaltyDeductionCents: { type: Number, default: 700, min: 0 },
      penaltyWindowDays: { type: Number, default: 30, min: 1 },
      suspensionHours: { type: Number, default: 24, min: 1 },
      noShowReportWindowMin: { type: Number, default: 60, min: 1 },
      noShowContestWindowHours: { type: Number, default: 24, min: 1 },
    },
  },
  { timestamps: true },
);
const AdminSettings = mongoose.model("AdminSettings", settingsSchema);

module.exports = AdminSettings;
