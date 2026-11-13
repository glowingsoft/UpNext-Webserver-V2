// services/stripeWebhook.service.js
const stripe = require("../config/stripe");
const { User } = require("@models/UserModel");
const { userCache } = require("@config/nodeCache");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const Dispute = require("@models/Dispute");
const ProviderPenalty = require("@models/ProviderPenalty");
const { sendUserNotifications } = require("../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const { syncDebtLock } = require("../app/services/paymentService");

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const PAYMENT_FIX_GRACE_MS = 24 * 60 * 60 * 1000;

// Post-materialization lookup only (capture / failure events on a booking
// that must already exist) — goes through the Payment doc rather than Stripe
// metadata, since metadata never carries a real bookingId pre-materialization.
const findBookingForIntent = async (intent) => {
  const payment = await Payment.findOne({ stripePaymentId: intent.id });
  if (!payment) return null;
  return Booking.findOne({ payment: payment._id });
};
/**
 * Verify the incoming webhook and return the parsed event.
 */
function constructEvent(rawBody, signature) {
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    throw new Error(`Webhook verification failed: ${err.message}`);
  }
}

// --- Individual event handlers (each reusable) ---

async function handleAccountUpdated(account) {
  try {
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    // Onboarding is complete only when both marketplace capabilities are active
    const onboardingComplete =
      account.capabilities?.card_payments === "active" && account.capabilities?.transfers === "active";

    const user = await User.findOneAndUpdate(
      { "stripe.accountId": account.id },
      {
        "stripe.chargesEnabled": chargesEnabled,
        "stripe.payoutsEnabled": payoutsEnabled,
        "stripe.onboardingComplete": onboardingComplete,
      },
      { new: true },
    );

    if (user) userCache.del(user._id.toString());

    console.log(
      `account.updated ${account.id}: charges=${chargesEnabled} payouts=${payoutsEnabled} done=${onboardingComplete}`,
    );
  } catch (err) {
    console.error("handleAccountUpdated error:", err.message);
    throw err;
  }
}

async function handlePaymentAuthorized(paymentIntent) {
  try {
    // Instant holds are created and tracked by the instant payment service
    if (String(paymentIntent.metadata?.purpose || "").startsWith("instant")) return;

    // amount_capturable > 0 means authorized but not yet captured
    await Payment.findOneAndUpdate(
      { stripePaymentId: paymentIntent.id },
      { status: "authorized", "paymentObject.status": paymentIntent.status },
    );

    // Lazy require to avoid a services ↔ app/services import cycle
    const { findOrCreateBookingForPaymentIntent, routeBookingAfterPaymentSecured } = require("../app/services/bookingService");
    const { booking, isNew } = await findOrCreateBookingForPaymentIntent(paymentIntent);
    if (!booking) return;

    if (isNew) {
      // Booking didn't exist until this event — already created at paymentStatus "authorized"
      await routeBookingAfterPaymentSecured(booking);
    } else if (["vaulted", "requires_payment_fix"].includes(booking.paymentStatus)) {
      booking.paymentStatus = "authorized";
      if (paymentIntent.payment_method) booking.stripePaymentMethodId = paymentIntent.payment_method;
      booking.paymentFixDeadline = undefined;
      await booking.save();
      await routeBookingAfterPaymentSecured(booking);
    }

    console.log(`PaymentIntent authorized: ${paymentIntent.id}`);
  } catch (err) {
    console.error("handlePaymentAuthorized error:", err.message);
    throw err;
  }
}

async function handleSetupSucceeded(setupIntent) {
  try {
    const { findOrCreateBookingForSetupIntent, routeBookingAfterPaymentSecured } = require("../app/services/bookingService");
    const { booking, isNew } = await findOrCreateBookingForSetupIntent(setupIntent);
    if (!booking) {
      console.log(`setup_intent.succeeded ${setupIntent.id}: no matching booking or draft`);
      return;
    }

    if (isNew) {
      // Booking didn't exist until this event — already created at paymentStatus "vaulted"
      await routeBookingAfterPaymentSecured(booking);
      console.log(`SetupIntent succeeded: ${setupIntent.id} -> booking ${booking.bookingId}`);
      return;
    }

    booking.stripePaymentMethodId = setupIntent.payment_method;

    if (booking.paymentStatus === "requires_payment_fix") {
      // Customer fixed their card within the grace period — retry the hold
      const { retryHorizonAuthorization } = require("../app/services/bookingLifecycleService");
      await booking.save();
      await retryHorizonAuthorization(booking);
      return;
    }

    await booking.save();
    console.log(`SetupIntent succeeded: ${setupIntent.id} -> booking ${booking.bookingId}`);
  } catch (err) {
    console.error("handleSetupSucceeded error:", err.message);
    throw err;
  }
}

async function handlePaymentCaptured(paymentIntent) {
  try {
    // Instant bookings record their own capture (partial amounts, fee, payout)
    if (String(paymentIntent.metadata?.purpose || "").startsWith("instant")) return;

    await Payment.findOneAndUpdate(
      { stripePaymentId: paymentIntent.id },
      {
        status: "captured",
        capturedAmount: (paymentIntent.amount_received ?? paymentIntent.amount) / 100,
        "paymentObject.status": paymentIntent.status,
      },
    );

    const booking = await findBookingForIntent(paymentIntent);
    if (booking && !["captured", "partially_captured"].includes(booking.paymentStatus)) {
      const clearedADebt = booking.paymentStatus === "failed";
      booking.paymentStatus = "captured";
      await booking.save();

      // This is the one path that can take a booking out of the debt state
      // without going through settleOutstandingDebt — a capture that lands
      // late, or one completed directly in the Stripe dashboard. Without this
      // the user's stored debt would keep listing a booking that is now paid.
      if (clearedADebt) {
        await syncDebtLock(booking.user).catch((err) =>
          console.error(`syncDebtLock failed for user ${booking.user}:`, err.message),
        );
      }
    }

    console.log(`PaymentIntent captured: ${paymentIntent.id}`);
  } catch (err) {
    console.error("handlePaymentCaptured error:", err.message);
    throw err;
  }
}

async function handlePaymentFailed(paymentIntent) {
  try {
    await Payment.findOneAndUpdate(
      { stripePaymentId: paymentIntent.id },
      { status: "failed", "paymentObject.status": paymentIntent.status },
    );

    const booking = await findBookingForIntent(paymentIntent);
    if (!booking) return;

    if (paymentIntent.metadata?.purpose === "booking_horizon_authorization") {
      // Off-session charge of the vaulted card failed — start the 24h grace period
      booking.paymentStatus = "requires_payment_fix";
      booking.paymentFixDeadline = new Date(Date.now() + PAYMENT_FIX_GRACE_MS);
      await booking.save();

      sendUserNotifications({
        recipientIds: [booking.user],
        title: "Action Required: Payment Failed",
        body: `We couldn't charge your card for "${booking.target[0]?.name}". Please update your payment method within 24 hours or the booking will be cancelled.`,
        data: { type: "booking_payment_fix_required", objectType: "booking" },
        notificationType: NotificationTypes.SYSTEM,
        objectId: booking._id,
      });
    }

    console.log(`PaymentIntent failed: ${paymentIntent.id}`);
  } catch (err) {
    console.error("handlePaymentFailed error:", err.message);
    throw err;
  }
}

/**
 * Lost dispute with provider at fault: amount + Stripe's dispute fee come out
 * of the provider's future payouts. Atomic on deductionRecorded so webhook
 * retries and repeated admin calls record it once.
 */
async function recordDisputeDeduction(disputeId) {
  const claimed = await Dispute.findOneAndUpdate(
    { _id: disputeId, outcome: "lost", faultParty: "provider", deductionRecorded: false, provider: { $ne: null } },
    { $set: { deductionRecorded: true } },
    { new: true },
  );
  if (!claimed) return null;
  try {
    return await ProviderPenalty.create({
      provider: claimed.provider,
      booking: claimed.booking,
      type: "dispute",
      weight: 0,
      deductionCents: claimed.amountCents + (claimed.stripeFeeCents || 0),
      note: `Lost dispute ${claimed.stripeDisputeId}`,
    });
  } catch (err) {
    await Dispute.updateOne({ _id: claimed._id }, { $set: { deductionRecorded: false } });
    throw err;
  }
}

async function upsertDispute(dispute) {
  const intentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const payment = intentId ? await Payment.findOne({ stripePaymentId: intentId }) : null;
  const booking = payment ? await Booking.findOne({ payment: payment._id }, "user business mode").lean() : null;
  const stripeFeeCents = (dispute.balance_transactions || []).reduce((sum, bt) => sum + (bt.fee || 0), 0);
  const outcome = dispute.status === "lost" ? "lost" : dispute.status === "won" ? "won" : "open";

  const doc = await Dispute.findOneAndUpdate(
    { stripeDisputeId: dispute.id },
    {
      $set: {
        stripePaymentIntentId: intentId,
        amountCents: dispute.amount,
        stripeFeeCents,
        reason: dispute.reason,
        status: dispute.status,
        outcome,
        ...(booking && { booking: booking._id, provider: booking.business, user: booking.user }),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  // A lost dispute the platform already knows to be provider-caused (admin set fault earlier)
  if (outcome === "lost") await recordDisputeDeduction(doc._id);
  return doc;
}

/**
 * Main dispatcher.
 */
async function processWebhookEvent(event) {
  try {
    switch (event.type) {
      case "charge.dispute.created":
      case "charge.dispute.closed":
      case "charge.dispute.updated":
        await upsertDispute(event.data.object);
        break;

      case "account.updated":
        await handleAccountUpdated(event.data.object);
        break;

      case "payment_intent.amount_capturable_updated":
        await handlePaymentAuthorized(event.data.object);
        break;

      case "setup_intent.succeeded":
        await handleSetupSucceeded(event.data.object);
        break;

      case "payment_intent.succeeded":
        await handlePaymentCaptured(event.data.object);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error("processWebhookEvent error:", err.message);
    throw err;
  }
}

module.exports = {
  constructEvent,
  processWebhookEvent,
  handleAccountUpdated,
  handlePaymentAuthorized,
  handleSetupSucceeded,
  handlePaymentCaptured,
  handlePaymentFailed,
  recordDisputeDeduction,
};
