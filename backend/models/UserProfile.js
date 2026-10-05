const mongoose = require("mongoose");
const {
  selectedBadgeSchema,
  locationSchema,
  userNotificationPreferencesSchema,
  categoryRefSchema,
} = require("./Models");
const userProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    location: locationSchema,

    categories: {
      type: [categoryRefSchema],
      default: [],
    },

    description: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },

    badges: {
      servicePreference: {
        type: selectedBadgeSchema,
        default: {},
      },

      preferredBookingTime: {
        type: selectedBadgeSchema,
        default: {},
      },

      bookingStyle: {
        type: selectedBadgeSchema,
        default: {},
      },

      travelDistance: {
        type: selectedBadgeSchema,
        default: {},
      },

      bookingFrequency: {
        type: selectedBadgeSchema,
        default: {},
      },

      preferredServiceType: {
        type: selectedBadgeSchema,
        default: {},
      },
    },
    status: {
      type: String,
      enum: ["pending", "active", "inactive", "suspended", "deleted"],
      default: "active",
    },

    notificationPreferences: {
      type: userNotificationPreferencesSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);
const UserProfile = mongoose.model("UserProfile", userProfileSchema);
module.exports = {
  UserProfile,
};
