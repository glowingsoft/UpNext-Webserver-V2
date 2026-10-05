const mongoose = require("mongoose");

// One row per (promotion, booking) redemption — used to enforce
// Promotion.totalUsageLimit (count of all rows for a promotion) and
// Promotion.perUserLimit (count of rows for a promotion scoped to one user).
// booking is unique — a given booking can only ever redeem one promotion once.
const promotionUsageSchema = new mongoose.Schema(
  {
    promotion: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
  },
  { timestamps: true },
);

promotionUsageSchema.index({ promotion: 1, user: 1 });

module.exports = mongoose.model("PromotionUsage", promotionUsageSchema);
