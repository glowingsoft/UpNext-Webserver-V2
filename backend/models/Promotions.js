const mongoose = require("mongoose");
const { Schema } = mongoose;

// Promotion Schema
const promotionSchema = new Schema({
  business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    trim: true,
    default: "",
  },
  photos: [{ type: String }], // array of URLs / S3 keys
  promoType: {
    type: String,
    required: true,
  },
  promoCode: {
    type: String,
    required: true,
  },
  discountType: {
    type: String,
    enum: ["percentage", "fixed"],
    required: true,
  },
  discount: {
    type: Number,
    required: true,
  },
  totalUsageLimit: {
    type: Number,
    required: true,
  },
  perUserLimit: {
    type: Number,
    required: true,
  },
  scope: {
    // "services"/"packages": targetId must belong to that model. "both": targetId
    // must belong to either model — the target's actual type isn't restricted.
    type: String,
    enum: ["services", "packages", "both"],
    required: true,
    default: "both"
  },
  targetId: {
    // Array so one promotion can bundle multiple services/packages. For
    // scope "services"/"packages" every id must belong to that one model;
    // for "both" each id may belong to either model.
    type: [{ type: mongoose.Schema.Types.ObjectId }],
    required: true,
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: "targetId must contain at least one id",
    },
  },
  status: {
    type: String,
    enum: ["active", "inactive", "deleted"],
    default: "active",
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

const Promotion = mongoose.model("Promotion", promotionSchema);

module.exports = {
  Promotion,
};
