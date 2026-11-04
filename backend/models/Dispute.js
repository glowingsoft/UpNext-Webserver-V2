const mongoose = require("mongoose");

const { Schema } = mongoose;

const disputeSchema = new Schema(
  {
    stripeDisputeId: { type: String, required: true, unique: true },
    stripePaymentIntentId: { type: String },
    booking: { type: Schema.Types.ObjectId, ref: "Booking" },
    provider: { type: Schema.Types.ObjectId, ref: "BusinessProfile" },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    amountCents: { type: Number, required: true },
    stripeFeeCents: { type: Number, default: 0 },
    reason: { type: String },
    status: { type: String, required: true }, // Stripe's dispute status, kept as sent
    outcome: { type: String, enum: ["open", "won", "lost"], default: "open" },
    // Set by an admin; only a provider-fault loss is recovered from the provider.
    faultParty: { type: String, enum: ["provider", "client", "platform", null], default: null },
    deductionRecorded: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Dispute", disputeSchema);
