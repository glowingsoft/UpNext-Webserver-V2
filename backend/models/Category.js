const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    icon: {
      type: String,
      default: "",
      trim: true,
    },
    scope: {
      type: String,
      enum: ["business", "user", "both"],
      default: "business",
    },
    color: {
      type: String,
      default: "",
      trim: true,
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "deleted"],
      default: "active",
    },
    translations: translationSchema,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.models.Category || mongoose.model("Category", categorySchema);
