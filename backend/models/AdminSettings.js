const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const adminSettingsSchema = new mongoose.Schema(
  {
    terms_and_conditions: {
      type: String,
      trim: true,
    },
    about_us: {
      type: String,
      trim: true,
    },
    privacy_policy: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);
const settingsSchema = new mongoose.Schema(
  {
    terms_and_conditions: {
      type: translationSchema,
      default: () => ({}),
    },
    about_us: {
      type: translationSchema,
      default: () => ({}),
    },
    privacy_policy: {
      type: translationSchema,
      default: () => ({}),
    },
    // other fields...
  },
  { timestamps: true },
);
const AdminSettings = mongoose.model("AdminSettings", settingsSchema);

module.exports = AdminSettings;
