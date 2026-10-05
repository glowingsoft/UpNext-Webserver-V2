const mongoose = require("mongoose");

// Local record of a customer's saved cards. Stripe's PaymentMethod remains
// the source of truth for actually charging the card, but ownership
// (which user added it) and cardHolderName are tracked here rather than
// trusted from Stripe's live PaymentMethod.customer field, so listing/
// updating/deleting a card never depends on the Stripe Customer id staying
// in sync with our own user document.
const cardSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    paymentMethodId: { type: String, required: true, unique: true },
    cardHolderName: { type: String, default: null },
    brand: { type: String, default: null },
    last4: { type: String, default: null },
    expMonth: { type: Number, default: null },
    expYear: { type: Number, default: null },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

cardSchema.index({ user: 1 });

module.exports = mongoose.model("Card", cardSchema);
