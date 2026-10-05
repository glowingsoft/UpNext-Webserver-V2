const mongoose = require("mongoose");

const { Schema } = mongoose;

// Checkout-in-progress hold. A real Booking is only created once payment is
// actually confirmed (synchronously when a paymentMethod is supplied, or from
// the Stripe webhook otherwise) — see materializeBookingFromDraft in
// bookingService.js. This draft is the temporary slot lock in the meantime.
const bookingDraftSchema = new Schema(
  {
    scope: {
      type: String,
      enum: ["service", "package"],
      required: true,
    },
    source: { type: String },
    target: [
      {
        name: { type: String, required: true },
        price: { type: Number, required: true },
        actaulPrice: { type: Number },
        preferredServiceType: { type: String, default: null },
      },
    ],
    slot: {
      open: { type: String, required: true },
      close: { type: String, required: true },
      isOverNight: { type: Boolean, default: false },
    },
    date: { type: Date, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
    promotion: { type: Schema.Types.ObjectId, ref: "Promotion" },
    stripePaymentIntentId: { type: String },
    stripeSetupIntentId: { type: String },
  },
  { timestamps: true },
);

// Backstop auto-expiry (30 min, matches CHECKOUT_TIMEOUT_MS in
// bookingLifecycleService.js) — the status-transition cron actively cleans
// these up and cancels the Stripe intent; this index just guarantees they
// never linger if the cron is ever delayed.
bookingDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 60 });

module.exports = mongoose.model("BookingDraft", bookingDraftSchema);
