const mongoose = require("mongoose");
const {
  selectedBadgeSchema,
  locationSchema,
  dayScheduleSchema,
  defaultDaySchedule,
  businessNotificationPreferencesSchema,
  categoryRefSchema,
  tagRefSchema,
} = require("./Models");

const businessProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    image: {
      type: String,
      default: "noimg.png",
      trim: true,
    },
    coverImage: {
      type: String,
      default: "noimg.png",
      trim: true,
    },

    businessName: {
      type: String,
      trim: true,
      default: "",
    },

    // URL-friendly identifier for public profile links; set once on creation
    // and never rewritten when businessName later changes.
    nameSlug: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    categories: {
      type: [categoryRefSchema],
      default: [],
    },

    tags: {
      type: [tagRefSchema],
      default: [],
    },

    location: locationSchema,

    businessType: {
      type: String,
      enum: ["solo", "team"],
      default: "solo",
    },

    teamSize: {
      type: Number,
      default: 1,
      min: 1,
    },

    yearsOfExperience: {
      type: Number,
      default: 0,
      min: 0,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    skills: {
      type: [String],
      default: [],
      validate: {
        validator: (v) => v.length >= 1 && v.length <= 10,
        message: "skills must have between 1 and 10 items",
      },
    },

    certifications: {
      files: {
        type: [String],
        default: [],
      },
      name: {
        type: String,
        trim: true,
        default: "",
      },
      version: {
        type: Number,
        default: 1,
      },
      status: {
        type: String,
        enum: ["not_submitted", "pending", "approved", "rejected"],
        default: "not_submitted",
      },
      rejectionReason: {
        type: String,
        default: "",
      },
      badgeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Badge",
        default: null,
      },
      optionId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
    },

    badges: {
      accessibilityInclusivity: {
        type: selectedBadgeSchema,
        default: {},
      },

      hairSpecialties: {
        type: selectedBadgeSchema,
        default: {},
      },

      nailSpecialties: {
        type: selectedBadgeSchema,
        default: {},
      },

      skinWellness: {
        type: selectedBadgeSchema,
        default: {},
      },

      serviceStyleAvailability: {
        type: selectedBadgeSchema,
        default: {},
      },

      experienceBackground: {
        type: selectedBadgeSchema,
        default: {},
      },

      businessSafety: {
        type: selectedBadgeSchema,
        default: {},
      },
      preferredCategory: {
        type: selectedBadgeSchema,
        default: {},
      },
      preferredServiceType: {
        type: selectedBadgeSchema,
        default: {},
      },
    },

    socialLinks: {
      instagram: {
        type: String,
        trim: true,
        default: "",
      },

      facebook: {
        type: String,
        trim: true,
        default: "",
      },

      linkedin: {
        type: String,
        trim: true,
        default: "",
      },

      website: {
        type: String,
        trim: true,
        default: "",
      },
    },
    status: {
      type: String,
      enum: ["pending", "active", "inactive", "suspended", "deleted"],
      default: "active",
    },
    operatingHours: {
      type: [dayScheduleSchema],
      default: defaultDaySchedule,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    // Set by the penalty ladder; isAvailable is flipped off alongside it and
    // restored by the offer sweeper once this passes.
    suspendedUntil: { type: Date, default: null },
    // The one offer this provider may be holding. Claimed with a CAS so a
    // provider never has two live offers.
    liveOffer: {
      offer: { type: mongoose.Schema.Types.ObjectId, ref: "BookingOffer", default: null },
      booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
      expiresAt: { type: Date, default: null },
    },
    // Counters feeding the reroute ranking (see instantRanking).
    matchStats: {
      offersReceived: { type: Number, default: 0 },
      offersAccepted: { type: Number, default: 0 },
      offersDeclined: { type: Number, default: 0 },
      offersExpired: { type: Number, default: 0 },
      responseSecTotal: { type: Number, default: 0 },
      responseCount: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      penaltyWeight30d: { type: Number, default: 0 },
      lastOfferAt: { type: Date, default: null },
    },

    notificationPreferences: {
      type: businessNotificationPreferencesSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

businessProfileSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("BusinessProfile", businessProfileSchema);
