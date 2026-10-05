const mongoose = require("mongoose");

const { Schema } = mongoose;

const bookingSchema = new Schema(
  {
    bookingId: {
      type: String,
      required: true,
      unique: true,
    },
    scope: {
      type: String,
      enum: ["service", "package"],
      required: true,
    },
    source: { type: String, default: "Other" },
    target: [
      {
        name: { type: String, required: true },
        price: { type: Number, required: true },
        actaulPrice: { type: Number },
        // Display name of the entity's preferredServiceType badge option,
        // resolved at booking time (e.g. "Onsite")
        preferredServiceType: { type: String, default: null },
      },
    ],
    slot: {
      open: { type: String, required: true }, // e.g., "09:00"
      close: { type: String, required: true }, // e.g., "10:00"
      isOverNight: { type: Boolean, default: false },
    },
    date: { type: Date, required: true },
    cancel: {
      reason: { type: String },
      by: { type: String, enum: ["user", "business"] },
    },
    status: {
      type: String,
      enum: ["scheduled", "requested", "ongoing", "expired", "canceled", "completed"],
      default: "requested",
    },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "vaulted",
        "authorized",
        "requires_payment_fix",
        "captured",
        "partially_captured",
        "released",
        "failed",
      ],
      default: "pending",
    },
    stripePaymentMethodId: { type: String },
    stripeSetupIntentId: { type: String },
    expiresAt: { type: Date }, // manual-approval deadline
    paymentFixDeadline: { type: Date }, // grace period for requires_payment_fix
    approvalReminder: {
      sentCount: { type: Number, default: 0 },
      lastSentAt: { type: Date },
    },
    preStartReminderSentAt: { type: Date },
    snapshot: { type: mongoose.Schema.Types.Mixed },
    completionReminder: {
      sentCount: { type: Number, default: 0 },
      lastSentAt: { type: Date },
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Booking", bookingSchema);
