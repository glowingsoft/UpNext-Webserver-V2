const mongoose = require("mongoose");

const accountDeletionCleanupSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    s3Keys: { type: [String], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AccountDeletionCleanup", accountDeletionCleanupSchema);
