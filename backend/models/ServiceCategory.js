const mongoose = require("mongoose");

// Freeform, per-provider category used to group a business's own
// services/packages. Unrelated to Category.js, which is the admin-curated
// list used for BusinessProfile's Profile Category.
const serviceCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    description: {
      type: String,
      trim: true,
    },
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessProfile",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.models.ServiceCategory || mongoose.model("ServiceCategory", serviceCategorySchema);
