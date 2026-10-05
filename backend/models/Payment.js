const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    type: {
      type: String,
      enum: ["booking_payment", "debt_settlement"],
      default: "booking_payment",
      required: true,
    },
    currency: {
      type: String,
      default: "usd",
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "authorized", "captured", "partially_captured", "released", "failed", "expired", "refunded"],
      default: "pending",
    },
    capturedAmount: {
      type: Number,
    },
    paymentObject: {
      type: Object,
      default: {},
    },

    stripePaymentId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
  },
  { timestamps: true },
);

const Payment = mongoose.model("Payment", paymentSchema);

module.exports = Payment;
