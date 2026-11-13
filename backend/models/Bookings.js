const mongoose = require("mongoose");

const { Schema } = mongoose;

const bookingSchema = new Schema(
  {
    bookingId: {
      type: String,
      required: true,
      unique: true,
    },
    scope: {
      type: String,
      enum: ["service", "package"],
      required: true,
    },
    source: { type: String, default: "Other" },
    target: [
      {
        name: { type: String, required: true },
        price: { type: Number, required: true },
        actaulPrice: { type: Number },
        // Display name of the entity's preferredServiceType badge option,
        // resolved at booking time (e.g. "Onsite")
        preferredServiceType: { type: String, default: null },
      },
    ],
    slot: {
      open: { type: String, required: true }, // e.g., "09:00"
      close: { type: String, required: true }, // e.g., "10:00"
      isOverNight: { type: Boolean, default: false },
    },
    date: { type: Date, required: true },
    cancel: {
      reason: { type: String },
      by: { type: String, enum: ["user", "business", "system"] },
    },
    mode: { type: String, enum: ["scheduled", "instant"], default: "scheduled", required: true },
    status: {
      type: String,
      enum: ["searching", "no_match", "scheduled", "requested", "ongoing", "expired", "canceled", "completed"],
      default: "requested",
    },
    statusHistory: {
      type: [
        {
          _id: false,
          status: { type: String, required: true },
          at: { type: Date, default: Date.now },
          by: { type: String, enum: ["user", "business", "system", "admin"], default: "system" },
          note: { type: String },
        },
      ],
      default: [],
    },
    // Instant ("Up Next") matching state. `offer` is what the sweeper indexes.
    instant: {
      type: new Schema(
        {
          requestedAt: { type: Date, required: true },
          location: { type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number] } },
          categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
          chosenBusiness: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
          matchSimilar: { type: Boolean, default: false },
          searchStartedAt: { type: Date, required: true },
          searchDeadline: { type: Date, required: true },
          providersTried: { type: Number, default: 0 },
          excluded: { type: [Schema.Types.ObjectId], default: [] },
          offer: {
            current: { type: Schema.Types.ObjectId, ref: "BookingOffer", default: null },
            expiresAt: { type: Date, default: null },
          },
          acceptedAt: { type: Date },
          checkIns: {
            arrived: { at: Date, lat: Number, lng: Number },
            completed: { at: Date, lat: Number, lng: Number },
          },
          noShow: {
            status: { type: String, enum: ["none", "reported", "contested", "upheld", "overturned"], default: "none" },
            reportedAt: Date,
            contestedAt: Date,
            contestNote: String,
            resolvedAt: Date,
            resolutionNote: String,
          },
        },
        { _id: false },
      ),
      required: function () {
        return this.mode === "instant";
      },
    },
    // Integer cents, snapshotted at booking and recomputed on reroute.
    pricing: {
      type: new Schema(
        {
          servicePriceCents: { type: Number, required: true },
          depositCents: { type: Number, required: true },
          feeCents: { type: Number, required: true }, // fee before promo
          promoDiscountCents: { type: Number, default: 0 }, // reduces fee only
          chargeFeeCents: { type: Number, required: true }, // fee actually charged
          totalCents: { type: Number, required: true }, // price + chargeFee
          heldCents: { type: Number, required: true }, // what the PaymentIntent authorizes
          settings: { type: Schema.Types.Mixed },
        },
        { _id: false },
      ),
      required: function () {
        return this.mode === "instant";
      },
    },
    // Instant capture bookkeeping: what is owed, retries, and how it ended.
    capture: {
      kind: { type: String, enum: ["completion", "cancellation"] },
      amountCents: { type: Number },
      status: { type: String, enum: ["none", "retrying", "captured", "fallback_charged", "failed"], default: "none" },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null },
      lastError: { type: String },
      stripeFeeCents: { type: Number },
      chargeId: { type: String },
    },
    // One transfer per booking, after capture (or from platform balance if capture failed).
    payout: {
      status: { type: String, enum: ["none", "processing", "paid", "failed", "skipped"], default: "none" },
      attempts: { type: Number, default: 0 },
      grossCents: { type: Number },
      stripeFeeShareCents: { type: Number },
      feeEstimated: { type: Boolean },
      deductionCents: { type: Number },
      deductions: { type: [{ _id: false, penalty: Schema.Types.ObjectId, cents: Number }], default: [] },
      netCents: { type: Number },
      transferId: { type: String },
      fromPlatformBalance: { type: Boolean },
      paidAt: { type: Date },
      lastError: { type: String },
    },
    agreement: {
      type: new Schema(
        {
          text: { type: String, required: true },
          version: { type: String, required: true },
          agreedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: function () {
        return this.mode === "instant";
      },
    },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "vaulted",
        "authorized",
        "requires_payment_fix",
        "capture_retrying",
        "captured",
        "partially_captured",
        "released",
        "failed",
      ],
      default: "pending",
    },
    stripePaymentMethodId: { type: String },
    stripeSetupIntentId: { type: String },
    expiresAt: { type: Date }, // manual-approval deadline
    paymentFixDeadline: { type: Date }, // grace period for requires_payment_fix
    approvalReminder: {
      sentCount: { type: Number, default: 0 },
      lastSentAt: { type: Date },
    },
    preStartReminderSentAt: { type: Date },
    snapshot: { type: mongoose.Schema.Types.Mixed },
    completionReminder: {
      sentCount: { type: Number, default: 0 },
      lastSentAt: { type: Date },
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
  },
  {
    timestamps: true,
  },
);

bookingSchema.index({ mode: 1, status: 1, "instant.offer.expiresAt": 1 });

module.exports = mongoose.model("Booking", bookingSchema);
