const mongoose = require("mongoose");

const businessAnalyticsEventSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
    type: { type: String, enum: ["profile_view", "search_impression"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

businessAnalyticsEventSchema.index({ business: 1, type: 1, createdAt: 1 });

module.exports = mongoose.model("BusinessAnalyticsEvent", businessAnalyticsEventSchema);
