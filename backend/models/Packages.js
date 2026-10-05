// Packageschema.js — shared base for both service types
const mongoose = require("mongoose");
const { Schema } = mongoose;
const { daySlotsSchema, badgeOptionRefSchema } = require("./Models");
// ─── Booking / Cancellation Rules Sub-schema ───────────────────────
const timeSchema = new Schema(
  {
    hours: { type: Number, default: 0 },
    mins: { type: Number, default: 0 },
  },
  { _id: false },
);

// ─── Base Service Schema (shared fields) ────────────────────────────
const baseFields = {
  business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
  services: [{ type: Schema.Types.ObjectId, ref: "Service", required: true }],
  category: { type: Schema.Types.ObjectId, ref: "ServiceCategory", required: true },
  subcategory: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },

  preferredServiceType: {
    type: badgeOptionRefSchema,
    required: true,
  },

  // ── Time slots (Set Slots screen) — bookable intervals per day.
  // Explicit mode: provided by the business, validated against operatingHours.
  // sameAsBusinessHours: auto-generated from operatingHours using
  // sessionSlotMins/gapBetweenSlotMins and stored here (regenerated when the
  // operating hours change — see regenerateBusinessHourSlots).
  slots: {
    type: [daySlotsSchema],
    default: [],
  },
  // "Session Slots (mins)" / "Gap between slots (mins)". Required in
  // sameAsBusinessHours mode; optional in explicit mode, where whatever the
  // business omits is measured back from the intervals (averaged when they
  // vary) — see deriveSessionConfigFromSlots.
  sessionSlotMins: { type: Number },
  gapBetweenSlotMins: { type: Number },

  // ── Booking / cancellation policy
  howLateCanBook: timeSchema,
  howLateCanCancel: timeSchema,
  refundPercentage: { type: Number, min: 0, max: 100, default: 0 },
  refundRules: { type: String },
  coverImage: { type: String, default: "noimg.png", trim: true },
  // ── Photos
  photos: [{ type: String }], // array of URLs / S3 keys

  price: {
    type: Number,
    min: 0,
    default: 0,
    required: true,
  },
  actualPrice: {
    type: Number,
    default: 0,
  },
  concurrentClients: {
    type: Number,
    min: 1,
    default: 1,
  },
  autoSelect: {
    type: Boolean,
    default: true,
  },
  sameAsBusinessHours: {
    type: Boolean,
    default: true,
  },
  status: {
    type: String,
    enum: ["active", "inactive", "deleted"],
    default: "active",
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
};

const Packageschema = new Schema(baseFields, {
  timestamps: true,
  collection: "packages",
});

const Packages = mongoose.models.packages || mongoose.model("packages", Packageschema);

module.exports = {
  Packages,
};
