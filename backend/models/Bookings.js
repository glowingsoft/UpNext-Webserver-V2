const mongoose = require("mongoose");

const { Schema } = mongoose;
const { badgeOptionRefSchema } = require("./Models");

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
    mode: { type: String, enum: ["instant"], default: "instant", required: true },
    status: {
      type: String,
      enum: [
        "requested",
        "awaiting_customer_decision",
        "accepted_awaiting_payment",
        "confirmed",
        "ongoing",
        "completed",
        "canceled",
      ],
      default: "requested",
    },
    cancelReason: {
      type: String,
      enum: [
        "no_match",
        "customer_timeout",
        "payment_timeout",
        "slot_taken",
        "client",
        "provider",
        "no_show",
        "system",
      ],
      default: null,
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
    // Attempt number (1-based) for send-again-once and 3-provider limit
    attempt: { type: Number, default: 1 },

    // Payout status (separate from payout sub-doc for easier querying)
    payoutStatus: {
      type: String,
      enum: ["none", "pending", "paid", "failed", "skipped"],
      default: "none",
    },

    // Per-attempt decline tracking (for send-again-once enforcement)
    providerDeclineCount: { type: Number, default: 0 },

    // Timeouts (when status expires)
    offerExpiresAt: { type: Date, default: null }, // Provider accept deadline (2 min for Available Now, 30 min for advance)
    awaitingPaymentDeadline: { type: Date, default: null }, // Auth failure grace period (5 min)
    awaitingDecisionDeadline: { type: Date, default: null }, // Session deadline while awaiting a customer decision

    // Check-ins
    checkIns: {
      arrived: { at: Date, lat: Number, lng: Number },
      customerArrived: { at: Date, lat: Number, lng: Number, by: { type: String, enum: ["user", "business"] } },
      completed: { at: Date, lat: Number, lng: Number },
    },

    // No-show dispute tracking
    noShow: {
      status: {
        type: String,
        enum: ["none", "reported", "contested", "upheld", "overturned"],
        default: "none",
      },
      reportedAt: Date,
      reportedBy: { type: String, enum: ["client", "provider"] },
      contestedAt: Date,
      contestNote: String,
      resolvedAt: Date,
      resolutionNote: String,
    },

    // Instant ("Up Next") matching state
    flow: {
      type: new Schema(
        {
          requestedAt: { type: Date, required: true },
          appointmentStart: { type: Date },
          isAvailableNow: { type: Boolean },
          location: { type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number] } },
          categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
          subcategoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory", default: null },
          preferredServiceType: { type: badgeOptionRefSchema },
          attemptStartedAt: { type: Date },
          attemptExpiresAt: { type: Date },
          currentProviderIndex: { type: Number }, // For ranked re-offer

          // Current live offer
          currentOffer: {
            offerId: { type: Schema.Types.ObjectId, ref: "BookingOffer" },
            sentAt: { type: Date },
            expiresAt: { type: Date },
            pauseAttempt: { type: Boolean, default: false },
          },
        },
        { _id: false },
      ),
      required: function () {
        return this.mode === "instant";
      },
    },
    // Integer cents, snapshotted for the selected provider.
    pricing: {
      type: new Schema(
        {
          servicePriceCents: { type: Number, required: true },
          depositCents: { type: Number, required: true },
          feeCents: { type: Number, required: true }, // fee before promo
          promoDiscountCents: { type: Number, default: 0 }, // reduces fee only
          chargeFeeCents: { type: Number, required: true }, // fee actually charged
          totalCents: { type: Number, required: true }, // price + chargeFee
          heldCents: { type: Number, required: true, min: 0 }, // zero until a PaymentIntent is authorized
          settings: { type: Schema.Types.Mixed },
        },
        { _id: false },
      ),
      required: function () {
        return this.mode === "instant";
      },
    },
    cancellation: {
      actor: { type: String, enum: ["user", "business"] },
      reason: { type: String },
      canceledAt: { type: Date },
      policy: { type: String, enum: ["non_refundable", "refundable_24h"] },
      depositCents: { type: Number, min: 0 },
      chargeCents: { type: Number, min: 0 },
      refundableDepositCents: { type: Number, min: 0, default: 0 },
      providerPenalty: { type: Schema.Types.ObjectId, ref: "ProviderPenalty" },
      providerCancellationNumber: { type: Number, min: 1 },
      warningIssued: { type: Boolean, default: false },
      rankingReductionApplied: { type: Boolean, default: false },
      suspendedUntil: { type: Date, default: null },
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
      safeguarded: { type: Boolean, default: false },
      leaseToken: { type: String },
      leaseUntil: { type: Date },
    },
    // One transfer per booking, after capture succeeds.
    payout: {
      status: { type: String, enum: ["none", "processing", "paid", "failed", "skipped"], default: "none" },
      attempts: { type: Number, default: 0 },
      grossCents: { type: Number },
      stripeFeeShareCents: { type: Number },
      deductionCents: { type: Number },
      deductions: { type: [{ _id: false, penalty: Schema.Types.ObjectId, cents: Number }], default: [] },
      netCents: { type: Number },
      transferId: { type: String },
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
    cancellationPolicySnapshot: {
      type: new Schema(
        {
          policy: { type: String, enum: ["non_refundable", "refundable_24h"], required: true },
          text: { type: String, required: true },
          version: { type: String, required: true },
        },
        { _id: false },
      ),
    },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    authorization: {
      offerId: { type: Schema.Types.ObjectId, ref: "BookingOffer" },
      initialPaymentMethodId: String,
      paymentMethodId: String,
      customerId: String,
      intentId: String,
      confirmKey: String,
      confirmMode: { type: String, enum: ["off_session", "on_session"] },
      needsFix: { type: Boolean, default: false },
      cleanupPending: { type: Boolean, default: false },
    },
    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "authorized",
        "requires_payment_fix",
        "capture_retrying",
        "captured",
        "partially_captured",
        "released",
        "payment_due",
        "failed",
      ],
      default: "pending",
    },
    stripePaymentMethodId: { type: String },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    business: { type: Schema.Types.ObjectId, ref: "BusinessProfile", required: true },
  },
  {
    timestamps: true,
  },
);

// Indexes for sweepers
bookingSchema.index({ status: 1, offerExpiresAt: 1 });
bookingSchema.index({ status: 1, awaitingPaymentDeadline: 1 });
bookingSchema.index({ status: 1, awaitingDecisionDeadline: 1 });
bookingSchema.index({ status: 1, "flow.attemptStartedAt": 1 });
bookingSchema.index({ status: 1, "flow.attemptExpiresAt": 1 });
bookingSchema.index(
  { user: 1 },
  {
    name: "one_active_booking_attempt_per_customer",
    unique: true,
    partialFilterExpression: {
      status: { $in: ["requested", "awaiting_customer_decision", "accepted_awaiting_payment"] },
    },
  },
);

module.exports = mongoose.model("Booking", bookingSchema);
