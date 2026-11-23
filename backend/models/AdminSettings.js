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
      // Timers (seconds)
      providerAcceptSec: { type: Number, default: 120, min: 10 }, // 2 min for Available Now
      providerAcceptSecAdvance: { type: Number, default: 1800, min: 60 }, // 30 min for advance, capped at half time left
      paymentSec: { type: Number, default: 300, min: 30 }, // 5 min to fix card after auth fails
      customerDecisionSec: { type: Number, default: 180, min: 30 }, // Retained for compatibility; decisions use the attempt deadline
      maxAttemptMinutes: { type: Number, default: 15, min: 1 }, // 15 min total search time

      // Advance booking limit (max days in future)
      maxAdvanceDays: { type: Number, default: 7, min: 1 },

      // Fee calculation: fee = min(cap, max(floor, rate x price))
      feeFloorCents: { type: Number, default: 700, min: 0 }, // $7
      feeRatePercent: { type: Number, default: 8, min: 0 }, // 8%
      feeCapCents: { type: Number, default: 2000, min: 0 }, // $20

      // Minimum service price
      minInstantPriceCents: { type: Number, default: 2500, min: 0 }, // $25

      // Deposit as % of service price
      depositPercent: { type: Number, default: 15, min: 0, max: 100 },

      // Maximum providers or maximum time to find one
      maxProviders: { type: Number, default: 3, min: 1 },

      // Search radius
      radiusKm: { type: Number, default: 25, min: 1 },

      // Scoring weights for ranking eligible providers (weighted sum)
      scoringWeights: {
        travelTime: { type: Number, default: 100, min: 0 }, // Most important
        rating: { type: Number, default: 50, min: 0 },
        acceptanceRate: { type: Number, default: 30, min: 0 },
        similarity: { type: Number, default: 20, min: 0 },
      },

      // Penalty system
      penaltyDeductionCents: { type: Number, default: 700, min: 0 }, // $7 per penalty
      penaltyWindowDays: { type: Number, default: 30, min: 1 }, // Rolling 30-day window
      timeoutStreakLimit: { type: Number, default: 3, min: 1 }, // Consecutive timeouts before suspension
      suspensionHours: { type: Number, default: 24, min: 1 }, // Suspension duration

      // No-show rules
      noShowReportWindowMin: { type: Number, default: 60, min: 1 }, // Client can report within 1 hour
      noShowContestWindowHours: { type: Number, default: 24, min: 1 }, // Provider can contest within 24 hours
    },
  },
  { timestamps: true },
);
const AdminSettings = mongoose.model("AdminSettings", settingsSchema);

module.exports = AdminSettings;
