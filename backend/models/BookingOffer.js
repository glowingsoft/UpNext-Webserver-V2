const mongoose = require("mongoose");

const { Schema } = mongoose;

const bookingOfferSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
    // The provider's own service that would fulfil the booking.
    serviceId: { type: Schema.Types.ObjectId, required: true },
    servicePriceCents: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired", "closed"],
      default: "pending",
      required: true,
    },
    attempt: { type: Number, required: true }, // 1-based position in the booking's search
    score: { type: Number, default: null }, // ranking score; null for the chosen provider's first offer
    sentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date },
  },
  { timestamps: true },
);

bookingOfferSchema.index({ booking: 1, business: 1 }, { unique: true });
bookingOfferSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("BookingOffer", bookingOfferSchema);
