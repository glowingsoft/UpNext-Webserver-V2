const mongoose = require("mongoose");

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const defaultDaySchedule = days.map((day) => ({
  dayOfWeek: day,
  isOpen: true,
  startTime: "09:00",
  endTime: "22:00",
  breaks: [],
}));

const selectedBadgeSchema = new mongoose.Schema(
  {
    badgeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Badge",
      default: null,
    },

    optionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    badgeName: {
      type: String,
      trim: true,
      default: "",
    },

    optionName: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

// Reference to a badge option ({ badgeId, optionId }) — used for
// preferredServiceType on services, packages, and user profiles
const badgeOptionRefSchema = new mongoose.Schema(
  {
    badgeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Badge",
      required: true,
    },

    optionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
  },
  { _id: false },
);

// Embedded category reference ({ _id, name }) — single stored array replacing
// the old parallel categories/categoryNames arrays on user/business profiles.
// _id is the Category document's id; name is denormalized at write time.
const categoryRefSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },

  name: {
    type: String,
    trim: true,
    default: "",
  },
});

// Embedded tag reference stored on a business profile. Category membership is
// held on the canonical Tag document.
const tagRefSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tag",
    required: true,
  },
  name: {
    type: String,
    trim: true,
    default: "",
  },
});

const locationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],
      default: [0, 0],
      validate: {
        validator: function (value) {
          if (!Array.isArray(value) || value.length !== 2) {
            return false;
          }

          const [lng, lat] = value;
          return (
            typeof lng === "number" && typeof lat === "number" && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
          );
        },
        message: "invalid_geojson_coordinates",
      },
    },
    address: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);
const breakIntervalSchema = new mongoose.Schema(
  {
    start: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/, // validates "HH:MM" format
    },
    end: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  { _id: false }, // no separate _id for each break; they live inside the day
);

const dayScheduleSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: String,
      required: true,
      enum: days,
    },
    /** Toggle switch in the UI — false means "Closed" */
    isOpen: {
      type: Boolean,
      default: true,
    },
    /**
     * Working window for the day. Overnight is inferred:
     * endTime <= startTime means the window crosses midnight
     * (e.g. startTime "22:00", endTime "02:00").
     */
    startTime: {
      type: String,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
      required: function () {
        return this.isOpen;
      },
    },
    endTime: {
      type: String,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
      required: function () {
        return this.isOpen;
      },
    },
    /** Rest intervals inside the working window (e.g. lunch 13:00–14:00) */
    breaks: {
      type: [breakIntervalSchema],
      default: [],
    },
  },
  { _id: false },
);

/** One bookable interval; isOvernight marks a close past midnight. */
const slotIntervalSchema = new mongoose.Schema(
  {
    open: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    close: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    isOvernight: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

/**
 * Discrete bookable intervals per day — used by Services/Packages slots.
 * Either provided explicitly by the business, or auto-generated (and stored)
 * from the operating hours when sameAsBusinessHours is true.
 */
const daySlotsSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: String,
      required: true,
      enum: days,
    },
    isOpen: {
      type: Boolean,
      default: true,
    },
    intervals: {
      type: [slotIntervalSchema],
      default: [],
    },
  },
  { _id: false },
);

const translationSchema = new mongoose.Schema(
  {
    en: {
      type: String,
      trim: true,
      default: "",
    },
    es: {
      type: String,
      trim: true,
      default: "",
    },
    fr: {
      type: String,
      trim: true,
      default: "",
    },
    pt: {
      type: String,
      trim: true,
      default: "",
    },
    zh: {
      type: String,
      trim: true,
      default: "",
    },
    ar: {
      type: String,
      trim: true,
      default: "",
    },
    ht: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    _id: false,
  },
);

// Business toggles: Email / Push / Profile View Alerts / Message Alerts
const businessNotificationPreferencesSchema = new mongoose.Schema(
  {
    emailNotifications: {
      type: Boolean,
      default: true,
    },
    pushNotifications: {
      type: Boolean,
      default: true,
    },
    profileViewAlerts: {
      type: Boolean,
      default: true,
    },
    messageAlerts: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

// Customer toggles: Email / Push / Booking Reminders — a different set than
// the business side, no profileViewAlerts/messageAlerts for customers
const userNotificationPreferencesSchema = new mongoose.Schema(
  {
    emailNotifications: {
      type: Boolean,
      default: true,
    },
    pushNotifications: {
      type: Boolean,
      default: true,
    },
    bookingReminders: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

const LanguageCodes = {
  ENGLISH: "en",
  SPANISH: "es",
  FRENCH: "fr",
  PORTUGUESE: "pt",
  MANDARIN: "zh",
  ARABIC: "ar",
  HAITIAN_CREOLE: "ht",
};

module.exports = {
  selectedBadgeSchema,
  badgeOptionRefSchema,
  categoryRefSchema,
  tagRefSchema,
  locationSchema,
  breakIntervalSchema,
  dayScheduleSchema,
  slotIntervalSchema,
  daySlotsSchema,
  defaultDaySchedule,
  translationSchema,
  LanguageCodes,
  businessNotificationPreferencesSchema,
  userNotificationPreferencesSchema,
};
