const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const BadgeStatuses = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  DELETED: "deleted",
};

const badgeOptionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    translations: {
      type: translationSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: Object.values(BadgeStatuses),
      default: BadgeStatuses.ACTIVE,
      index: true,
    },
  },
  // {
  //   timestamps: true,
  // },
);

const badgeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    translations: {
      type: translationSchema,
      default: () => ({}),
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    options: {
      type: [badgeOptionSchema],
      default: [],
    },
    scope: {
      type: String,
      enum: ["user", "business", "both"],
      default: "business",
    },
    status: {
      type: String,
      enum: Object.values(BadgeStatuses),
      default: BadgeStatuses.ACTIVE,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

badgeSchema.index({ name: 1, status: 1 });

const Badge = mongoose.model("Badge", badgeSchema);

module.exports = {
  Badge,
  BadgeStatuses,
};
