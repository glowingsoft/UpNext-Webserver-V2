const mongoose = require("mongoose");

const TagStatuses = Object.freeze({ ACTIVE: "active", INACTIVE: "inactive", DELETED: "deleted" });

const tagSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    status: { type: String, enum: Object.values(TagStatuses), default: TagStatuses.ACTIVE, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

tagSchema.index({ category: 1, name: 1 });

module.exports = { Tag: mongoose.models.Tag || mongoose.model("Tag", tagSchema), TagStatuses };
