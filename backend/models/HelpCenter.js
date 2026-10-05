const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const helpCenterSchema = new mongoose.Schema(
  {
    title: {
      type: translationSchema,
      required: true,
      default: () => ({}),
    },
    description: {
      type: translationSchema,
      required: true,
      default: () => ({}),
    },
    coverImage: {
      type: String,
      default: "noimg.png",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "published"],
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

const HelpCenter = mongoose.model("HelpCenter", helpCenterSchema);

module.exports = HelpCenter;
