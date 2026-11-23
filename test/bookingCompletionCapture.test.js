require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let state, intent, captures, payouts, failPaymentSave, captureStarted, releaseCapture;
const stripe = { paymentIntents: {
  retrieve: async () => ({ ...intent }),
  capture: async (_id, params, options) => {
    captures.push({ params, options });
    if (captureStarted) {
      captureStarted();
      await new Promise((resolve) => { releaseCapture = resolve; });
    }
    intent = { ...intent, status: "succeeded", amount_received: 5000,
      latest_charge: { id: "ch_test", balance_transaction: { fee: 175 } } };
    return { ...intent };
  },
} };
stub("@config/stripe", stripe);
stub("../backend/app/services/paymentService", { syncDebtLock: async () => {} });
stub("../backend/app/services/instantPaymentService", { payProvider: async () => { payouts++; } });
const { runCompletionCapture } = require("../backend/app/services/bookingCompletionCapture");
const originalEnv = { nodeEnv: process.env.NODE_ENV, stripeKey: process.env.STRIPE_SECRET_KEY };
const original = { claim: Booking.findOneAndUpdate, update: Booking.updateOne,
  payment: Payment.findById, savePayment: Payment.updateOne };

const setup = () => {
  process.env.NODE_ENV = "dev";
  process.env.STRIPE_SECRET_KEY = "sk_test_mock";
  captures = []; payouts = 0; failPaymentSave = false; captureStarted = null; releaseCapture = null;
  state = { _id: "booking", bookingId: "B1", mode: "instant", status: "completed", user: "user",
    business: "business", payment: "payment", authorization: { intentId: "pi_test", customerId: "cus_test" },
    pricing: { totalCents: 5000 }, paymentStatus: "capture_retrying",
    capture: { safeguarded: true, status: "retrying", amountCents: 5000, nextAttemptAt: new Date(0) } };
  intent = { id: "pi_test", amount: 5000, amount_capturable: 5000, currency: "usd", customer: "cus_test",
    metadata: { bookingId: "booking" }, capture_method: "manual", status: "requires_capture" };
  Booking.findOneAndUpdate = async (_filter, update) => {
    if (state.capture.status !== "retrying" || state.capture.nextAttemptAt > new Date() ||
        (state.capture.leaseUntil && state.capture.leaseUntil > new Date())) return null;
    state.capture.leaseToken = update.$set["capture.leaseToken"];
    state.capture.leaseUntil = update.$set["capture.leaseUntil"];
    return structuredClone(state);
  };
  Booking.updateOne = async (filter, update) => {
    if (filter["capture.leaseToken"] !== state.capture.leaseToken || state.capture.status !== "retrying") {
      return { matchedCount: 0 };
    }
    for (const [key, value] of Object.entries(update.$set || {})) {
      if (key.startsWith("capture.")) state.capture[key.slice(8)] = value;
      else state[key] = value;
    }
    for (const key of Object.keys(update.$unset || {})) {
      if (key.startsWith("capture.")) delete state.capture[key.slice(8)];
    }
    return { matchedCount: 1 };
  };
  Payment.findById = async () => ({ _id: "payment", stripePaymentId: "pi_test",
    user: "user", business: "business", status: "authorized" });
  Payment.updateOne = async () => {
    if (failPaymentSave) throw new Error("database unavailable");
    return { matchedCount: 1 };
  };
};

test("completion capture claims once and uses a stable Stripe idempotency key", async () => {
  setup();
  const started = new Promise((resolve) => { captureStarted = resolve; });
  const first = runCompletionCapture("booking");
  await started;
  assert.equal(await runCompletionCapture("booking"), null);
  releaseCapture();
  assert.equal(await first, true);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].options.idempotencyKey, "booking-completion-capture-booking");
  assert.equal(state.paymentStatus, "captured");
  assert.equal(state.capture.status, "captured");
  assert.equal(payouts, 1);
});

test("a successful Stripe capture is reconciled after a database failure without charging again", async () => {
  setup();
  failPaymentSave = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await runCompletionCapture("booking"), null);
    assert.equal(state.paymentStatus, "payment_due");
    assert.equal(captures.length, 1);
    assert.equal(payouts, 0);
    failPaymentSave = false;
    state.capture.nextAttemptAt = new Date(0);
    assert.equal(await runCompletionCapture("booking"), true);
    assert.equal(captures.length, 1);
    assert.equal(state.paymentStatus, "captured");
    assert.equal(payouts, 1);
  } finally { console.error = originalError; }
});

test("a mismatched Stripe authorization is not captured", async () => {
  setup();
  intent.amount = 4000;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await runCompletionCapture("booking"), null);
    assert.equal(captures.length, 0);
    assert.equal(payouts, 0);
    assert.equal(state.paymentStatus, "payment_due");
  } finally { console.error = originalError; }
});

test("an uncertain Stripe response is reconciled on retry without a second capture", async () => {
  setup();
  const originalCapture = stripe.paymentIntents.capture;
  stripe.paymentIntents.capture = async (_id, params, options) => {
    captures.push({ params, options });
    intent = { ...intent, status: "succeeded", amount_received: 5000,
      latest_charge: { id: "ch_test", balance_transaction: { fee: 175 } } };
    throw new Error("connection lost after capture");
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await runCompletionCapture("booking"), null);
    assert.equal(state.paymentStatus, "payment_due");
    assert.equal(payouts, 0);
    state.capture.nextAttemptAt = new Date(0);
    assert.equal(await runCompletionCapture("booking"), true);
    assert.equal(captures.length, 1);
    assert.equal(payouts, 1);
  } finally {
    console.error = originalError;
    stripe.paymentIntents.capture = originalCapture;
  }
});

test("an expired worker lease can be reclaimed", async () => {
  setup();
  state.capture.leaseToken = "crashed-worker";
  state.capture.leaseUntil = new Date(0);
  assert.equal(await runCompletionCapture("booking"), true);
  assert.equal(captures.length, 1);
});

test("completion capture cannot run with a live Stripe key", async () => {
  setup();
  process.env.STRIPE_SECRET_KEY = "sk_live_example";
  await assert.rejects(runCompletionCapture("booking"), /requires a non-production Stripe test key/);
  assert.equal(captures.length, 0);
});

test.after(() => {
  if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv.nodeEnv;
  if (originalEnv.stripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalEnv.stripeKey;
  Booking.findOneAndUpdate = original.claim;
  Booking.updateOne = original.update;
  Payment.findById = original.payment;
  Payment.updateOne = original.savePayment;
});
