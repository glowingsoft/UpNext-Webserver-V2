const mongoose = require("mongoose");

const { Schema } = mongoose;

const providerPenaltySchema = new Schema(
  {
    provider: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
    booking: { type: Schema.Types.ObjectId, ref: "Booking" },
    type: { type: String, enum: ["cancellation", "no_show", "dispute"], required: true },
    weight: { type: Number, required: true }, // no_show = 2, cancellation = 1, dispute = 0
    deductionCents: { type: Number, default: 0, min: 0 },
    appliedCents: { type: Number, default: 0, min: 0 }, // consumed so far; carries forward until == deductionCents
    appliedAt: { type: Date, default: null }, // set when fully applied
    note: { type: String },
  },
  { timestamps: true },
);

providerPenaltySchema.index({ provider: 1, createdAt: -1 });
providerPenaltySchema.index({ provider: 1, appliedAt: 1 });
// One penalty per booking per type, so a retried cancel can't double count.
providerPenaltySchema.index({ booking: 1, type: 1 }, { unique: true, partialFilterExpression: { booking: { $type: "objectId" } } });

module.exports = mongoose.model("ProviderPenalty", providerPenaltySchema);
