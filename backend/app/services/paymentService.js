const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const { createStripePayment, createStripeSetupIntent, captureStripePayment } = require("@services/stripePayment");
const { getOrCreateCustomer, attachPaymentMethod } = require("@services/stripeAccount");
const { User } = require("@models/UserModel");
const { userCache } = require("@config/nodeCache");
const Payment = require("@models/Payment");
const { default: mongoose } = require("mongoose");

const APPLICATION_FEE_PERCENT = 0.05; // 5% platform fee

// A capture that failed after the service was delivered. Deliberately not
// "requires_payment_fix" — that is a pre-service authorization failure with its
// own 24h grace deadline and recovery flow (see bookingLifecycleService).
const OUTSTANDING_PAYMENT_STATUS = "failed";

/**
 * What a customer actually owes, derived from their bookings rather than stored.
 *
 * The debt used to live in a single User.outstandingBooking pointer, so each new
 * failed capture overwrote the previous one: a customer with seven failed
 * bookings showed one, and settling it cleared the lock while six debts stayed
 * invisible. The bookings themselves are the only source that can hold more than
 * one, so the list is computed from them every time and cannot drift.
 *
 * Ordered oldest first — that is the one the customer is asked to settle next.
 */
const getOutstandingDebt = async (userId) => {
  const bookings = await Booking.find({ user: userId, paymentStatus: OUTSTANDING_PAYMENT_STATUS })
    .select("bookingId target date business")
    .sort({ date: 1, createdAt: 1 })
    .lean();

  const items = bookings.map((booking) => ({
    _id: booking._id,
    bookingId: booking.bookingId,
    name: booking.target?.[0]?.name ?? null,
    amount: booking.target?.[0]?.price ?? 0,
    date: booking.date,
    business: booking.business,
  }));

  return {
    hasDebt: items.length > 0,
    count: items.length,
    // Rounded because these are summed floats — 3 × 19.99 should read 59.97.
    totalAmount: Number(items.reduce((sum, item) => sum + (item.amount || 0), 0).toFixed(2)),
    bookings: items,
  };
};

/**
 * Recompute the user's debt flag from their bookings. Called after anything that
 * adds or clears a failed capture, so the flag can never say "clear" while a
 * failed booking is still outstanding.
 */
const syncDebtLock = async (userId) => {
  const debt = await getOutstandingDebt(userId);

  await User.findByIdAndUpdate(userId, {
    hasOutstandingDebt: debt.hasDebt,
    // The whole list, so the user document reflects what is actually owed
    // instead of one id. Ordered oldest first, same as the API reports it.
    outstandingBookings: debt.bookings.map((booking) => booking._id),
    outstandingAmount: debt.totalAmount,
    // Retained for clients reading the older single-booking payload. It now
    // means "the next one to settle" (oldest unpaid) rather than "whichever
    // failed most recently", and is null once nothing is owed.
    outstandingBooking: debt.bookings[0]?._id ?? null,
  });
  userCache.del(String(userId));

  return debt;
};

/**
 * Branch A (booking <= 4 days away): create a manual-capture PaymentIntent.
 * When paymentMethod is supplied the PI is confirmed immediately (API/test flow);
 * otherwise the caller returns client_secret so the frontend confirms via Elements.
 * Returns { paymentDoc, clientSecret }.
 */
const authorizeBookingPayment = async ({ amount, user, entity, paymentMethod, bookingId, draftId }) => {
  const stripeInfo = entity.stripe;
  const business = entity.business;
  // Destination charges are always on (no env gate) — the business account
  // must be genuinely onboarded, in test mode too, or Stripe rejects the PI.
  if (!stripeInfo?.accountId || !String(stripeInfo.accountId).startsWith("acct_")) {
    throw new Error("Business Stripe account is not connected");
  }
  if (!stripeInfo.onboardingComplete) {
    throw new Error("Business has not completed Stripe onboarding");
  }
  if (!amount || amount <= 0) {
    throw new Error("Invalid payment amount");
  }

  const customer = await getOrCreateCustomer(user);
  const amountCents = Math.round(amount * 100);
  const applicationFeeAmount = Math.round(amountCents * APPLICATION_FEE_PERCENT);
  const paymentId = new mongoose.Types.ObjectId();

  const stripePayment = await createStripePayment({
    amount: amountCents,
    customerId: customer.id,
    paymentMethodId: paymentMethod,
    destinationAccountId: stripeInfo.accountId,
    applicationFee: applicationFeeAmount,
    transferGroup: draftId || bookingId ? String(draftId || bookingId) : undefined,
    currency: user.currency || "usd",
    metadata: {
      paymentId: paymentId.toString(),
      draftId: draftId ? draftId.toString() : "",
      bookingId: bookingId ? bookingId.toString() : "",
      userId: user._id.toString(),
      businessId: business.toString(),
      purpose: "booking_authorization",
    },
    // Customer is actively completing checkout right now — on-session, so a
    // required 3DS challenge comes back as requires_action + client_secret
    // instead of a hard decline.
    off_session: false,
  });
  if (!stripePayment || !stripePayment.id) {
    throw new Error("Failed to create Stripe payment");
  }

  const paymentDoc = await Payment.create({
    _id: paymentId,
    user: user._id,
    amount,
    currency: user.currency || "usd",
    stripePaymentId: stripePayment.id,
    status: stripePayment.status === "requires_capture" ? "authorized" : "pending",
    type: "booking_payment",
    business,
    paymentObject: {
      amount: stripePayment.amount,
      currency: stripePayment.currency,
      customer: stripePayment.customer,
      paymentMethod: stripePayment.payment_method,
      applicationFeeAmount,
      destinationAccountId: stripePayment.transfer_data?.destination,
      status: stripePayment.status,
    },
  });

  return { paymentDoc, clientSecret: stripePayment.client_secret, stripeStatus: stripePayment.status };
};

/**
 * Branch B (booking > 4 days away): vault the card, hold nothing.
 * When paymentMethod is supplied it is attached + confirmed server-side;
 * otherwise the frontend confirms the SetupIntent with client_secret.
 * Returns { setupIntent, clientSecret }.
 */
const createBookingSetupIntent = async ({ user, paymentMethod, bookingId, draftId, businessId }) => {
  const customer = await getOrCreateCustomer(user);

  if (paymentMethod) {
    await attachPaymentMethod(customer.id, paymentMethod);
  }

  const setupIntent = await createStripeSetupIntent({
    customerId: customer.id,
    paymentMethodId: paymentMethod,
    metadata: {
      draftId: draftId ? draftId.toString() : "",
      bookingId: bookingId ? bookingId.toString() : "",
      userId: user._id.toString(),
      businessId: businessId ? businessId.toString() : "",
      purpose: "booking_vault",
    },
  });

  return { setupIntent, clientSecret: setupIntent.client_secret };
};

/**
 * Charge (authorize, manual capture) a vaulted card. offSession defaults to
 * true (horizon cron — nobody's present, a required challenge should hard-fail
 * cleanly into requires_payment_fix). Pass offSession: false for a
 * customer-initiated retry (fix-payment, same card) so a required 3DS
 * challenge comes back as requires_action + clientSecret instead.
 * Returns { paymentDoc, stripeStatus, clientSecret } or throws when authorization fails.
 */
const authorizeVaultedPayment = async ({ booking, user, entityStripe, offSession = true }) => {
  const amount = booking.target[0]?.price;
  if (!amount || amount <= 0) throw new Error("Invalid payment amount");
  if (!booking.stripePaymentMethodId) throw new Error("No vaulted payment method on booking");
  if (!entityStripe?.accountId || !String(entityStripe.accountId).startsWith("acct_")) {
    throw new Error("Business Stripe account is not connected");
  }

  const customer = await getOrCreateCustomer(user);
  const amountCents = Math.round(amount * 100);
  const applicationFeeAmount = Math.round(amountCents * APPLICATION_FEE_PERCENT);
  const paymentId = new mongoose.Types.ObjectId();

  const stripePayment = await createStripePayment({
    amount: amountCents,
    customerId: customer.id,
    paymentMethodId: booking.stripePaymentMethodId,
    destinationAccountId: entityStripe.accountId,
    applicationFee: applicationFeeAmount,
    transferGroup: booking._id.toString(),
    currency: user.currency || "usd",
    metadata: {
      paymentId: paymentId.toString(),
      bookingId: booking._id.toString(),
      userId: user._id.toString(),
      businessId: booking.business.toString(),
      purpose: "booking_horizon_authorization",
    },
    off_session: offSession,
  });

  const paymentDoc = await Payment.create({
    _id: paymentId,
    user: user._id,
    amount,
    currency: user.currency || "usd",
    stripePaymentId: stripePayment.id,
    status: stripePayment.status === "requires_capture" ? "authorized" : "pending",
    type: "booking_payment",
    business: booking.business,
    paymentObject: {
      amount: stripePayment.amount,
      currency: stripePayment.currency,
      customer: stripePayment.customer,
      paymentMethod: stripePayment.payment_method,
      applicationFeeAmount,
      destinationAccountId: stripePayment.transfer_data?.destination,
      status: stripePayment.status,
    },
  });

  return { paymentDoc, stripeStatus: stripePayment.status, clientSecret: stripePayment.client_secret };
};

/**
 * Debt lock settlement ("Complete Payment" button): immediate capture of the
 * outstanding booking amount, clears hasOutstandingDebt on success.
 */
const settleOutstandingDebt = async ({ user, bookingId, paymentMethod }) => {
  const dbUser = await User.findById(user._id);
  if (!dbUser) return { error: "user_not", status: 404 };

  // Settle the booking the caller named. The route has always carried a
  // :bookingId but the service ignored it and settled whatever the single
  // pointer happened to hold — with several unpaid bookings that meant paying
  // off one the customer never chose. Falling back to the oldest keeps callers
  // that send nothing working.
  const booking = bookingId
    ? await Booking.findOne({ _id: bookingId, user: dbUser._id })
    : await Booking.findOne({ user: dbUser._id, paymentStatus: OUTSTANDING_PAYMENT_STATUS }).sort({
        date: 1,
        createdAt: 1,
      });

  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.paymentStatus !== OUTSTANDING_PAYMENT_STATUS) {
    return { error: "no_outstanding_debt", status: 400 };
  }

  const amount = booking.target[0]?.price;
  const customer = await getOrCreateCustomer(user);
  const amountCents = Math.round(amount * 100);
  const applicationFeeAmount = Math.round(amountCents * APPLICATION_FEE_PERCENT);
  const paymentId = new mongoose.Types.ObjectId();

  // Route the business's share like any booking charge. If their account is
  // unusable, charge platform-only anyway — the customer must always be able
  // to clear the debt lock; the transfer can be reconciled manually.
  const businessProfile = await BusinessProfile.findById(booking.business).select("user").lean();
  const businessOwner = businessProfile ? await User.findById(businessProfile.user).select("stripe").lean() : null;
  const destinationAccountId = String(businessOwner?.stripe?.accountId || "").startsWith("acct_")
    ? businessOwner.stripe.accountId
    : undefined;

  try {
    const stripePayment = await createStripePayment({
      amount: amountCents,
      customerId: customer.id,
      paymentMethodId: paymentMethod || booking.stripePaymentMethodId,
      destinationAccountId,
      applicationFee: destinationAccountId ? applicationFeeAmount : undefined,
      transferGroup: booking._id.toString(),
      currency: user.currency || "usd",
      capture_method: "automatic",
      metadata: {
        paymentId: paymentId.toString(),
        bookingId: booking._id.toString(),
        userId: user._id.toString(),
        businessId: booking.business.toString(),
        purpose: "debt_settlement",
      },
      // Customer is actively settling the debt right now — on-session.
      off_session: false,
    });

    if (!["succeeded", "processing"].includes(stripePayment.status)) {
      return { error: "debt_settlement_failed", status: 400 };
    }

    const paymentDoc = await Payment.create({
      _id: paymentId,
      user: user._id,
      amount,
      currency: user.currency || "usd",
      stripePaymentId: stripePayment.id,
      status: "captured",
      capturedAmount: amount,
      type: "debt_settlement",
      business: booking.business,
      paymentObject: stripePayment,
    });

    booking.payment = paymentDoc._id;
    booking.paymentStatus = "captured";
    booking.status = "completed";
    await booking.save();

    // Recomputed, not cleared: paying one booking must not unlock a customer who
    // still owes for others.
    const debt = await syncDebtLock(dbUser._id);

    sendUserNotifications({
      recipientIds: [booking.business],
      title: "Outstanding Payment Received",
      body: `The outstanding payment for booking "${booking.target[0]?.name}" has been settled`,
      data: { type: "booking_debt_settled", objectType: "booking" },
      notificationType: NotificationTypes.SYSTEM,
      objectId: booking._id,
      sender: user._id,
    });

    // outstandingDebt reports what is still owed after this payment, so the app
    // can keep the customer on the settle screen instead of telling them they
    // are clear and bouncing them off the next booking attempt.
    return { data: { booking, payment: paymentDoc, outstandingDebt: debt } };
  } catch (error) {
    console.error("settleOutstandingDebt error:", error);
    return { error: "debt_settlement_failed", status: 400 };
  }
};

/**
 * Mark a capture failure and lock the user until the debt is settled.
 */
const applyDebtLock = async ({ booking }) => {
  booking.paymentStatus = OUTSTANDING_PAYMENT_STATUS;
  await booking.save();

  const debt = await syncDebtLock(booking.user);

  // Say how much is owed in total once more than one booking is unpaid —
  // otherwise the customer settles one and is surprised to still be locked.
  const body =
    debt.count > 1
      ? `The payment for "${booking.target[0]?.name}" failed. You now have ${debt.count} unpaid bookings totalling ${debt.totalAmount}. Please complete your payment to continue booking.`
      : `The payment for "${booking.target[0]?.name}" failed. Please complete your payment to continue booking.`;

  sendUserNotifications({
    recipientIds: [booking.user],
    title: "Payment Failed",
    body,
    data: { type: "booking_payment_failed", objectType: "booking" },
    notificationType: NotificationTypes.SYSTEM,
    objectId: booking._id,
  });
};

module.exports = {
  authorizeBookingPayment,
  createBookingSetupIntent,
  authorizeVaultedPayment,
  settleOutstandingDebt,
  applyDebtLock,
  getOutstandingDebt,
  syncDebtLock,
};
