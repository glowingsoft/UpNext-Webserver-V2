const mongoose = require("mongoose");

// `thumbnail` is derived from `file` on every write rather than sent by the
// client, and is stored rather than recomputed on read so the response can
// never point at an object that was never generated. It stays null for
// documents (no frame to show) and when generation failed.
// `ai_tags` holds the per-photo tags a vision model derives from the image
// itself (description/technique/style/color), so a photo is searchable even when the
// provider never labels it. Generation failures leave these empty arrays,
// the same "degrade, never block" contract thumbnail generation already uses.
const portfolioMediaTagsSchema = new mongoose.Schema(
  {
    description: { type: String, trim: true, default: "" },
    technique: { type: [String], default: [] },
    style: { type: [String], default: [] },
    color: { type: [String], default: [] },
  },
  { _id: false },
);

const portfolioMediaSchema = new mongoose.Schema(
  {
    file: { type: String, trim: true, required: true },
    thumbnail: { type: String, trim: true, default: null },
    ai_tags: { type: portfolioMediaTagsSchema, default: () => ({}) },
  },
  { _id: false },
);

const portfolioSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessProfile",
      required: true,
      index: true,
    },
    // businessName: {
    //   type: String,
    //   trim: true,
    //   required: true,
    // },
    name: {
      type: String,
      trim: true,
      required: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    media: {
      type: [portfolioMediaSchema],
      default: [],
    },
    // Flattened terms used by the portfolio text index. AI tags themselves
    // remain only on their corresponding media entry.
    search_keywords: { type: [String], default: [] },
  },
  {
    timestamps: true,
  },
);

portfolioSchema.index({ search_keywords: "text", name: "text", businessName: "text", description: "text" });

module.exports = mongoose.model("Portfolio", portfolioSchema);
