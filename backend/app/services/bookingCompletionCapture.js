const { randomUUID } = require("node:crypto");
const stripe = require("@config/stripe");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const { instantTestFlowEnabled } = require("@utils/bookingEligibility");
const { syncDebtLock } = require("./paymentService");

const LEASE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

const runCompletionCapture = async (bookingId) => {
  if (!instantTestFlowEnabled()) throw new Error("Instant completion capture requires a non-production Stripe test key");
  const now = new Date();
  const token = randomUUID();
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId, mode: "instant", status: "completed", "capture.safeguarded": true,
      "capture.status": "retrying", "capture.nextAttemptAt": { $lte: now },
      $or: [{ "capture.leaseUntil": { $exists: false } }, { "capture.leaseUntil": null },
        { "capture.leaseUntil": { $lte: now } }],
    },
    { $set: { "capture.leaseToken": token, "capture.leaseUntil": new Date(now.getTime() + LEASE_MS) } },
    { new: true },
  );
  if (!booking) return null;

  const guard = { _id: bookingId, "capture.safeguarded": true,
    "capture.status": "retrying", "capture.leaseToken": token, payment: booking.payment };
  try {
    const amount = booking.capture.amountCents;
    const payment = await Payment.findById(booking.payment);
    if (!payment || !booking.authorization?.intentId || !booking.authorization.customerId ||
        payment.stripePaymentId !== booking.authorization.intentId ||
        String(payment.user) !== String(booking.user) || String(payment.business) !== String(booking.business) ||
        !["authorized", "captured", "failed"].includes(payment.status) ||
        !Number.isSafeInteger(amount) || amount <= 0 || booking.pricing.totalCents !== amount) {
      throw new Error("Booking authorization does not match the capture");
    }

    let intent = await stripe.paymentIntents.retrieve(payment.stripePaymentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    const validIntent = (value) => value.id === payment.stripePaymentId && value.amount === amount &&
      value.currency === "usd" && value.customer === booking.authorization.customerId &&
      value.metadata?.bookingId === String(booking._id) && value.capture_method === "manual";
    if (!validIntent(intent)) throw new Error("Stripe authorization does not match the booking");
    if (intent.status === "requires_capture") {
      if (intent.amount_capturable !== amount) throw new Error("Stripe capturable amount does not match the booking");
      intent = await stripe.paymentIntents.capture(payment.stripePaymentId, {
        amount_to_capture: amount, expand: ["latest_charge.balance_transaction"],
      }, { idempotencyKey: `booking-completion-capture-${booking._id}` });
    }
    if (!validIntent(intent) || intent.status !== "succeeded" || intent.amount_received !== amount) {
      throw new Error(`Stripe capture is not complete (${intent.status})`);
    }
    const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const updatedPayment = await Payment.updateOne(
      { _id: payment._id, stripePaymentId: intent.id },
      { $set: { status: "captured", capturedAmount: amount / 100, "paymentObject.status": intent.status } },
    );
    if (!updatedPayment.matchedCount) throw new Error("Captured payment record was not found");
    const saved = await Booking.updateOne(guard, {
      $set: {
        paymentStatus: "captured", "capture.status": "captured", "capture.nextAttemptAt": null,
        "capture.stripeFeeCents": charge?.balance_transaction?.fee ?? null,
        "capture.chargeId": charge?.id,
      },
      $unset: { "capture.leaseToken": "", "capture.leaseUntil": "", "capture.lastError": "",
        stripePaymentMethodId: "" },
    });
    if (!saved.matchedCount) return null;
  } catch (error) {
    console.error(`Completion capture failed for ${booking.bookingId}:`, error.message);
    const updated = await Booking.updateOne(guard, {
      $set: { paymentStatus: "payment_due", "capture.lastError": error.message,
        "capture.nextAttemptAt": new Date(Date.now() + RETRY_MS) },
      $inc: { "capture.attempts": 1 },
      $unset: { "capture.leaseToken": "", "capture.leaseUntil": "" },
    });
    if (updated.matchedCount) {
      await syncDebtLock(booking.user).catch((err) => console.error("syncDebtLock:", err.message));
    }
    return null;
  }

  await syncDebtLock(booking.user).catch((err) => console.error("syncDebtLock:", err.message));
  await require("./instantPaymentService").payProvider(bookingId);
  return true;
};

module.exports = { runCompletionCapture };
