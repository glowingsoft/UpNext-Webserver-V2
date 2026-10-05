const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    reviewType: {
      type: String,
      enum: ["user", "services", "packages"],
      required: true,
    },
    object: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "reviewType",
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Reference to the User who wrote the review
      required: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5, // Rating should be between 1 and 5
      required: true,
    },
    comment: {
      type: String,
      trim: true,
      default: "",
    },
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessProfile", // Reference to the Business being reviewed
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking", // The specific booking this review was left for
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    audit: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

const Review = mongoose.model("Review", reviewSchema);

module.exports = Review;
