const mongoose = require("mongoose");

const { Schema } = mongoose;

const bookingOfferSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
    // The provider's own service/package that would fulfil the booking.
    serviceId: { type: Schema.Types.ObjectId, required: true },
    servicePriceCents: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired", "closed"],
      default: "pending",
      required: true,
    },
    score: { type: Number, default: null }, // ranking score for this provider
    // Track resends for send-again-once: max 2 sends per provider per attempt
    sendCount: { type: Number, default: 1 },
    sentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date },
  },
  { timestamps: true },
);

// Indexes for sweepers and queries
bookingOfferSchema.index({ booking: 1, status: 1, expiresAt: 1 });
bookingOfferSchema.index({ business: 1, status: 1, sendCount: 1 });
bookingOfferSchema.index(
  { booking: 1 },
  {
    name: "one_pending_offer_per_booking",
    unique: true,
    partialFilterExpression: { status: "pending" },
  },
);

module.exports = mongoose.model("BookingOffer", bookingOfferSchema);
