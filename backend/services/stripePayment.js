// services/stripePayment.service.js
const stripe = require("../config/stripe");

/**
 * Authorize a booking payment (manual capture).
 * amount & applicationFee are in the smallest currency unit (e.g. cents).
 */
async function createStripePayment({
  amount,
  applicationFee,
  destinationAccountId,
  transferGroup,
  currency = "usd",
  customerId,
  paymentMethodId,
  metadata = {},
  capture_method = "manual",
  off_session = true,
}) {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      capture_method, // authorize now, capture later
      ...(applicationFee && destinationAccountId ? { application_fee_amount: applicationFee } : {}),
      ...(destinationAccountId ? { transfer_data: { destination: destinationAccountId } } : {}),
      ...(transferGroup ? { transfer_group: transferGroup } : {}),
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: Boolean(paymentMethodId),
      automatic_payment_methods: paymentMethodId
        ? { enabled: true, allow_redirects: "never" }
        : { enabled: true },
      // Without this, Stripe charges/authorizes the card but never attaches it
      // to the Customer — any later attach() call (e.g. POST /cards saving the
      // same card, or a future booking reusing it) is permanently rejected.
      ...(customerId ? { setup_future_usage: "off_session" } : {}),
      metadata,
      off_session,
    });

    return paymentIntent;
  } catch (err) {
    console.error("createPayment error:", err.message);
    const wrapped = new Error(`Failed to create payment: ${err.message}`);
    // Callers need to tell a declined card from an outage
    wrapped.stripeType = err.type;
    wrapped.code = err.code;
    throw wrapped;
  }
}

/**
 * Create a SetupIntent to vault a card for later off-session use
 * (bookings more than 4 days out — no funds are held).
 */
async function createStripeSetupIntent({ customerId, paymentMethodId, metadata = {} }) {
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      ...(paymentMethodId ? { payment_method: paymentMethodId, confirm: true } : {}),
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata,
    });

    return setupIntent;
  } catch (err) {
    console.error("createSetupIntent error:", err.message);
    throw new Error(`Failed to create setup intent: ${err.message}`);
  }
}

/**
 * Capture a previously authorized payment after the booking is completed.
 * Pass amountToCapture to capture a partial amount (optional).
 */
async function captureStripePayment(paymentIntentId, amountToCapture = null) {
  try {
    const params = {};
    if (amountToCapture != null) {
      params.amount_to_capture = amountToCapture;
    }

    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, params);

    return paymentIntent;
  } catch (err) {
    console.error("capturePayment error:", err.message);
    throw new Error(`Failed to capture payment: ${err.message}`);
  }
}

/**
 * Cancel an authorization (e.g. booking rejected before capture).
 */
async function cancelStripePayment(paymentIntentId) {
  try {
    return await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (err) {
    console.error("cancelPayment error:", err.message);
    throw new Error(`Failed to cancel payment: ${err.message}`);
  }
}

module.exports = {
  createStripePayment,
  createStripeSetupIntent,
  captureStripePayment,
  cancelStripePayment,
};
