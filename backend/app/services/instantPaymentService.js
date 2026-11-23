const mongoose = require("mongoose");
const stripe = require("@config/stripe");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const { NotificationTypes } = require("@models/Notifications");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { openOrReopenConversationForBooking } = require("../../commonModules/chatModule/services/conversationGateService");
const { createStripePayment, cancelStripePayment } = require("@services/stripePayment");
const { getOrCreateCustomer } = require("@services/stripeAccount");
const { applyDebtLock, syncDebtLock } = require("./paymentService");
const { consumeDeductions, restoreDeductions } = require("./penaltyService");
const { instantEvents } = require("./instantOfferService");
const { instantTestFlowEnabled } = require("@utils/bookingEligibility");

// Minutes to wait after the 1st..4th failed capture; the 5th failure goes to the fallback charge.
const CAPTURE_BACKOFF_MIN = [1, 5, 15, 60];
const MAX_PAYOUT_ATTEMPTS = 5;
const DEAD_AUTH_CODES = ["payment_intent_unexpected_state", "charge_expired_for_capture", "charge_already_captured"];

const notify = (opts) => sendUserNotifications(opts);
const log = (label) => (err) => console.error(`${label}:`, err.message);

// ─── Hold ──────────────────────────────────────────────────────────────────

/**
 * One authorization on the platform account for price + booking fee: manual
 * capture, no destination, no application fee. Returns { ok, paymentDoc } or
 * { ok:false, flagClient, message } — flagClient is true when the card itself
 * was the problem (declined / needs another card), false for an outage.
 */
const holdInstantPayment = async ({ user, bookingId, totalCents, paymentMethod, businessId, offSession = false }) => {
  const customer = await getOrCreateCustomer(user);
  const paymentId = new mongoose.Types.ObjectId();

  let intent;
  try {
    intent = await createStripePayment({
      amount: totalCents,
      customerId: customer.id,
      paymentMethodId: paymentMethod,
      transferGroup: `booking_${bookingId}`,
      currency: "usd",
      metadata: {
        paymentId: String(paymentId),
        bookingId: String(bookingId),
        userId: String(user._id),
        businessId: String(businessId),
        purpose: "instant_hold",
      },
      off_session: offSession,
    });
  } catch (err) {
    const cardProblem = err.stripeType === "StripeCardError" || err.code === "card_declined";
    return { ok: false, flagClient: cardProblem, message: err.message };
  }

  if (intent.status !== "requires_capture") {
    // 3DS or another step we can't complete server-side: treat as a failed hold
    await cancelStripePayment(intent.id).catch(log("instant hold cleanup"));
    return { ok: false, flagClient: true, message: `Hold not authorized (${intent.status})` };
  }

  const paymentDoc = await Payment.create({
    _id: paymentId,
    user: user._id,
    business: businessId,
    amount: totalCents / 100,
    currency: "usd",
    stripePaymentId: intent.id,
    status: "authorized",
    type: "booking_payment",
    paymentObject: {
      amount: intent.amount,
      currency: intent.currency,
      customer: intent.customer,
      paymentMethod: intent.payment_method,
      status: intent.status,
    },
  });
  return { ok: true, paymentDoc };
};

// Cancels the authorization: the client is never charged.
const releaseHold = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking?.payment) return null;

  const payment = await Payment.findById(booking.payment);
  if (!payment?.stripePaymentId) throw new Error("Booking authorization payment not found");
  if (!["pending", "authorized", "released", "failed", "expired"].includes(payment.status)) {
    throw new Error("Captured payment cannot be released as an authorization");
  }
  let intent;
  try {
    intent = await cancelStripePayment(payment.stripePaymentId);
  } catch (error) {
    intent = await stripe.paymentIntents.retrieve(payment.stripePaymentId);
    if (intent.status !== "canceled") throw error;
  }
  if (intent.status !== "canceled") throw new Error("Stripe authorization was not canceled");
  if (payment.status !== "released") {
    payment.status = "released";
    await payment.save();
  }
  await Booking.updateOne(
    { _id: bookingId, payment: payment._id, paymentStatus: { $in: ["authorized", "pending", "requires_payment_fix"] } },
    { $set: { paymentStatus: "released" } },
  );
  return booking;
};

// ─── Capture ───────────────────────────────────────────────────────────────

/**
 * Starts the single capture for a booking. completion captures the full
 * total, cancellation the deposit + booking fee; either way amount_to_capture
 * is passed explicitly so a rerouted booking never captures the original,
 * larger hold. Everything after the first attempt (retries, fallback charge,
 * debt lock) is driven from the stored `capture` state.
 */
const beginCapture = async (bookingId, { kind, amountCents }) => {
  await Booking.updateOne(
    { _id: bookingId, "capture.status": { $in: [null, "none"] } },
    { $set: { capture: { kind, amountCents, status: "retrying", attempts: 0, nextAttemptAt: new Date() } } },
  );
  return runCapture(bookingId);
};

const runCapture = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking || booking.capture?.status !== "retrying") return null;
  if (booking.capture.safeguarded) return require("./bookingCompletionCapture").runCompletionCapture(bookingId);
  const payment = await Payment.findById(booking.payment);
  if (!payment) return null;

  const { kind, amountCents } = booking.capture;
  let intent;
  try {
    try {
      intent = await stripe.paymentIntents.capture(payment.stripePaymentId, {
        amount_to_capture: amountCents,
        expand: ["latest_charge.balance_transaction"],
      });
    } catch (err) {
      // A retry after a lost response: the capture may have gone through already
      const current = await stripe.paymentIntents.retrieve(payment.stripePaymentId, {
        expand: ["latest_charge.balance_transaction"],
      });
      if (current.status !== "succeeded") throw err;
      intent = current;
    }
  } catch (err) {
    return onCaptureFailed(booking, payment, err);
  }

  if (intent.status !== "succeeded" || intent.amount_received !== amountCents) {
    throw new Error("Captured payment amount or status does not match the booking");
  }

  const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const stripeFeeCents = charge?.balance_transaction?.fee ?? null;

  payment.status = kind === "cancellation" ? "partially_captured" : "captured";
  payment.capturedAmount = (intent.amount_received ?? amountCents) / 100;
  await payment.save();

  await Booking.updateOne(
    { _id: bookingId },
    {
      $set: {
        paymentStatus: kind === "cancellation" ? "partially_captured" : "captured",
        "capture.status": "captured",
        "capture.nextAttemptAt": null,
        "capture.stripeFeeCents": stripeFeeCents,
        "capture.chargeId": charge?.id,
        ...(kind === "cancellation" && { "pricing.heldCents": 0 }),
      },
      $unset: { stripePaymentMethodId: "" },
    },
  );
  await syncDebtLock(booking.user).catch(log("syncDebtLock"));
  return payProvider(bookingId);
};

const onCaptureFailed = async (booking, payment, err) => {
  const dead = DEAD_AUTH_CODES.includes(err.code) || /canceled|expired/i.test(err.message || "");
  const attempts = (booking.capture.attempts || 0) + 1;
  console.error(`instant capture failed for ${booking.bookingId} (attempt ${attempts}):`, err.message);

  if (!dead && attempts <= CAPTURE_BACKOFF_MIN.length) {
    await Booking.updateOne(
      { _id: booking._id, "capture.status": "retrying" },
      {
        $set: {
          paymentStatus: "payment_due",
          "capture.attempts": attempts,
          "capture.lastError": err.message,
          "capture.nextAttemptAt": new Date(Date.now() + CAPTURE_BACKOFF_MIN[attempts - 1] * 60 * 1000),
        },
      },
    );
    if (attempts === 1) {
      // Blocks new bookings until payment succeeds.
      await syncDebtLock(booking.user).catch(log("syncDebtLock"));
      notify({
        recipientIds: [booking.user],
        title: "Payment issue",
        body: "We couldn't process your payment. We'll retry automatically; please make sure your card is working.",
        data: { type: "instant_capture_retry", objectType: "booking", bookingId: String(booking._id) },
        notificationType: NotificationTypes.SYSTEM,
        objectId: booking._id,
      });
    }
    return null;
  }

  payment.status = "failed";
  await payment.save();
  return chargeFallback(booking._id, err.message);
};

/**
 * The authorization is dead (expired, canceled, reversed) or retries ran out:
 * charge the saved card directly, off session. If that fails too, the client is
 * debt-locked. The provider is paid only after the charge succeeds.
 */
const chargeFallback = async (bookingId, reason) => {
  const booking = await Booking.findById(bookingId);
  if (!booking || booking.capture?.status !== "retrying") return null;
  const oldPayment = await Payment.findById(booking.payment);
  const user = await User.findById(booking.user).lean();
  const { kind, amountCents } = booking.capture;
  const paymentId = new mongoose.Types.ObjectId();

  try {
    const customer = await getOrCreateCustomer(user);
    const pmId = oldPayment?.paymentObject?.paymentMethod;
    if (!pmId) throw new Error("No saved payment method");

    const intent = await createStripePayment({
      amount: amountCents,
      customerId: customer.id,
      paymentMethodId: pmId,
      transferGroup: `booking_${booking._id}`,
      currency: "usd",
      capture_method: "automatic",
      metadata: {
        paymentId: String(paymentId),
        bookingId: String(booking._id),
        userId: String(booking.user),
        purpose: "instant_fallback_charge",
      },
      off_session: true,
    });
    if (intent.status !== "succeeded") throw new Error(`Fallback charge ${intent.status}`);

    const full = await stripe.paymentIntents.retrieve(intent.id, { expand: ["latest_charge.balance_transaction"] });
    const charge = full.latest_charge;
    await Payment.create({
      _id: paymentId,
      user: booking.user,
      business: booking.business,
      amount: amountCents / 100,
      capturedAmount: amountCents / 100,
      stripePaymentId: intent.id,
      status: "captured",
      type: "booking_payment",
      paymentObject: { paymentMethod: pmId, status: "succeeded", fallbackFor: oldPayment?._id },
    });
    await Booking.updateOne(
      { _id: bookingId },
      {
        $set: {
          payment: paymentId,
          paymentStatus: kind === "cancellation" ? "partially_captured" : "captured",
          "capture.status": "fallback_charged",
          "capture.nextAttemptAt": null,
          "capture.lastError": reason,
          "capture.stripeFeeCents": charge?.balance_transaction?.fee ?? null,
          "capture.chargeId": charge?.id,
          ...(kind === "cancellation" && { "pricing.heldCents": 0 }),
        },
      },
    );
    // Don't leave a live authorization behind on the card
    if (oldPayment && oldPayment.status !== "captured") {
      await cancelStripePayment(oldPayment.stripePaymentId).catch(() => {});
    }
    await syncDebtLock(booking.user).catch(log("syncDebtLock"));
    return payProvider(bookingId);
  } catch (err) {
    console.error(`instant fallback charge failed for ${booking.bookingId}:`, err.message);
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { "capture.status": "failed", "capture.nextAttemptAt": null, "capture.lastError": err.message } },
    );
    // Marks paymentStatus "failed", locks the client out of new bookings and tells them
    await applyDebtLock({ booking: await Booking.findById(bookingId) });
    return null;
  }
};

// ─── Provider payout (separate charges and transfers) ──────────────────────

/**
 * Pays the provider once after completion. Customer cancellation deposits are
 * retained by the platform and never create a provider payout.
 * A captured charge and its actual balance-transaction fee are required.
 */
const payProvider = async (bookingId) => {
  const claimed = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      "payout.status": { $in: ["none", "failed"] },
      "payout.attempts": { $lt: MAX_PAYOUT_ATTEMPTS },
      "capture.status": { $in: ["captured", "fallback_charged"] },
      "capture.kind": { $ne: "cancellation" },
      ...(!instantTestFlowEnabled() && { "capture.safeguarded": { $ne: true } }),
    },
    { $set: { payoutStatus: "pending", "payout.status": "processing" }, $inc: { "payout.attempts": 1 } },
    { new: true },
  );
  if (!claimed) {
    await Booking.updateOne(
      {
        _id: bookingId,
        "capture.kind": "cancellation",
        "payout.status": { $in: ["none", "failed"] },
      },
      {
        $set: {
          payoutStatus: "skipped",
          "payout.status": "skipped",
          "payout.grossCents": 0,
          "payout.stripeFeeShareCents": 0,
          "payout.deductionCents": 0,
          "payout.deductions": [],
          "payout.netCents": 0,
          "payout.transferId": null,
          "payout.paidAt": null,
        },
      },
    );
    return null;
  }

  const { capture, pricing } = claimed;
  const providerShare = pricing.servicePriceCents;
  const capturedCents = capture.amountCents;

  let applied = [];
  try {
    if ((!capture.chargeId || capture.stripeFeeCents == null) && claimed.payment) {
      const payment = await Payment.findById(claimed.payment).lean();
      if (!payment?.stripePaymentId) throw new Error("Captured payment not found");
      const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentId, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = intent.latest_charge;
      if (intent.status !== "succeeded" || intent.amount_received !== capturedCents ||
          !charge || typeof charge !== "object" || typeof charge.balance_transaction !== "object" ||
          !charge.balance_transaction) {
        throw new Error("Captured payment or Stripe balance transaction is not available");
      }
      capture.chargeId = charge.id;
      capture.stripeFeeCents = charge.balance_transaction.fee;
      await Booking.updateOne(
        { _id: bookingId, "payout.status": "processing", "capture.status": { $in: ["captured", "fallback_charged"] } },
        { $set: { "capture.chargeId": capture.chargeId, "capture.stripeFeeCents": capture.stripeFeeCents } },
      );
    }
    if (!capture.chargeId || !Number.isSafeInteger(capture.stripeFeeCents) || capture.stripeFeeCents < 0 ||
        !Number.isSafeInteger(capturedCents) || capturedCents <= 0 ||
        !Number.isSafeInteger(providerShare) || providerShare < 0 || providerShare > capturedCents) {
      throw new Error("Captured charge, actual Stripe fee, and valid captured amount are required for payout");
    }
    const profile = await BusinessProfile.findById(claimed.business, "user").lean();
    const owner = profile ? await User.findById(profile.user, "stripe").lean() : null;
    const destination = owner?.stripe?.accountId;
    if (!destination) throw new Error("Provider has no connected Stripe account");

    const totalFee = capture.stripeFeeCents;
    const feeShare = Math.round((totalFee * providerShare) / capturedCents);
    const afterFee = Math.max(0, providerShare - feeShare);

    const consumed = await consumeDeductions(claimed.business, afterFee);
    applied = consumed.applied;
    const net = afterFee - consumed.totalCents;
    const chargeId = capture.chargeId;

    let transferId = null;
    if (net > 0) {
      const group = `booking_${bookingId}`;
      const existing = await stripe.transfers.list({ transfer_group: group, destination, limit: 5 });
      const prior = existing.data.find((t) => t.metadata?.bookingId === String(bookingId) && !t.reversed);
      const transfer =
        prior ||
        (await stripe.transfers.create(
          {
            amount: net,
            currency: "usd",
            destination,
            transfer_group: group,
            source_transaction: chargeId,
            metadata: { bookingId: String(bookingId), kind: capture.kind },
          },
          { idempotencyKey: `payout_${bookingId}` },
        ));
      transferId = transfer.id;
    }

    await Booking.updateOne(
      { _id: bookingId },
      {
        $set: {
          payout: {
            status: net > 0 ? "paid" : "skipped",
            attempts: claimed.payout.attempts,
            grossCents: providerShare,
            stripeFeeShareCents: feeShare,
            deductionCents: consumed.totalCents,
            deductions: applied,
            netCents: net,
            transferId,
            paidAt: new Date(),
          },
          payoutStatus: net > 0 ? "paid" : "skipped",
        },
      },
    );

    if (net > 0 || consumed.totalCents > 0) {
      notify({
        recipientIds: [claimed.business],
        title: "Payout sent",
        body: `Your payout of $${(net / 100).toFixed(2)} is on its way${consumed.totalCents ? ` (after $${(consumed.totalCents / 100).toFixed(2)} in deductions)` : ""}.`,
        data: { type: "instant_payout", objectType: "booking", bookingId: String(bookingId) },
        notificationType: NotificationTypes.SYSTEM,
        objectId: bookingId,
      });
    }
    return { net, transferId };
  } catch (err) {
    console.error(`payout failed for ${claimed.bookingId}:`, err.message);
    await restoreDeductions(applied);
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { payoutStatus: "failed", "payout.status": "failed", "payout.lastError": err.message, "payout.deductions": [] } },
    );
    return null;
  }
};

// ─── Cron: capture retries + payout retries ────────────────────────────────

const runInstantPaymentsCron = async () => {
  const now = new Date();

  const due = await Booking.find(
    { mode: "instant", "capture.safeguarded": { $ne: true }, paymentStatus: { $in: ["payment_due", "capture_retrying"] },
      "capture.status": "retrying", "capture.nextAttemptAt": { $lte: now } },
    "_id",
  )
    .limit(50)
    .lean();
  for (const b of due) {
    await runCapture(b._id).catch(log(`capture retry ${b._id}`));
  }

  const completionDue = await Booking.find(
    { mode: "instant", status: "completed", "capture.safeguarded": true,
      "capture.status": "retrying", "capture.nextAttemptAt": { $lte: now } },
    "_id",
  ).limit(50).lean();
  for (const b of completionDue) {
    await require("./bookingCompletionCapture").runCompletionCapture(b._id).catch(log(`completion capture ${b._id}`));
  }

  const stalePayouts = await Booking.find(
    {
      mode: "instant",
      "capture.status": { $in: ["captured", "fallback_charged"] },
      "payout.status": { $in: ["none", "failed"] },
      "payout.attempts": { $lt: MAX_PAYOUT_ATTEMPTS },
      updatedAt: { $lte: new Date(now.getTime() - 60 * 1000) },
    },
    "_id",
  )
    .limit(50)
    .lean();
  for (const b of stalePayouts) {
    await payProvider(b._id).catch(log(`payout retry ${b._id}`));
  }
};

// ─── Reactions to the offer engine ─────────────────────────────────────────

instantEvents.on("searchEnded", ({ booking }) => releaseHold(booking._id).catch(log("release after search end")));
instantEvents.on("searchCanceled", ({ booking }) => releaseHold(booking._id).catch(log("release after cancel")));
instantEvents.on("accepted", ({ booking }) =>
  openOrReopenConversationForBooking(booking).catch(log("open conversation after accept")),
);

module.exports = {
  holdInstantPayment,
  releaseHold,
  beginCapture,
  runCapture,
  payProvider,
  runInstantPaymentsCron,
};
