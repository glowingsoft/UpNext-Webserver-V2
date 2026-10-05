// Local-only Stripe Elements checkout tester.
// Paste a clientSecret from a booking response, type a test card, confirm --
// mirrors what the mobile app does when it confirms a Payment/SetupIntent.
//
// Usage:
//   node scratchpad/stripe-checkout/serve.js
//   open http://127.0.0.1:4242
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const express = require("express");
const app = express();
const PORT = 4242;

const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  console.error("STRIPE_PUBLISHABLE_KEY is not set in .env — aborting.");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Stripe Checkout Tester</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; }
    h3 { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 24px; }
    label { display: block; margin-top: 16px; font-weight: 600; }
    input, .card-element { width: 100%; padding: 10px; margin-top: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
    button { margin-top: 20px; padding: 10px 16px; cursor: pointer; }
    .result { margin-top: 16px; padding: 12px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
    .ok { background: #e6ffed; border: 1px solid #2ea44f; }
    .err { background: #ffeef0; border: 1px solid #d73a49; }
    .hint { color: #666; font-size: 13px; margin-top: 4px; }
  </style>
</head>
<body>
  <h2>Stripe Checkout Tester</h2>

  <h3>1. Create a PaymentMethod (for createBooking / fix-payment)</h3>
  <p class="hint">
    Enter a card and click Create. This mints a <code>pm_..._</code> id via
    <code>stripe.createPaymentMethod()</code> — exactly what the mobile app's
    CardField does. Copy the resulting <code>pm_...</code> id into the
    <code>stripePaymentMethodId</code> field of your <code>createBooking</code>
    or <code>fix-payment</code> request.
    Test cards: 4242 4242 4242 4242 (succeeds), 4000 0025 0000 3155 (3DS on charge),
    4000 0000 0000 0341 (vaults/attaches fine, all charges fail),
    4000 0000 0000 9995 (declined immediately).
  </p>

  <label>Card</label>
  <div id="pm-card-element" class="card-element"></div>

  <button id="create-pm">Create PaymentMethod</button>
  <div id="pm-result" class="result"></div>

  <h3>2. Confirm a clientSecret (complete a 3DS challenge)</h3>
  <p class="hint">
    Paste the <code>clientSecret</code> returned by <code>createBooking</code> /
    <code>fix-payment</code> when a challenge is required. A
    <code>pi_..._secret_...</code> confirms a PaymentIntent (auth-hold branch);
    a <code>seti_..._secret_...</code> confirms a SetupIntent (vaulting branch).
    This mirrors the app's <code>handleNextAction</code> /
    <code>handleNextActionForSetup</code> call — the PaymentMethod was already
    attached server-side, so no card input is needed here.
  </p>

  <label for="secret">Client Secret</label>
  <input id="secret" type="text" placeholder="pi_..._secret_... or seti_..._secret_..." />

  <button id="confirm-secret">Handle Next Action</button>
  <div id="secret-result" class="result"></div>

  <h3>3. Create a payout token (for POST /business-profile/payout-methods)</h3>
  <p class="hint">
    Bank-account tokens for a connected account must be minted in that
    account's context, so paste the business's Connect account id
    (<code>acct_...</code> — from <code>user.stripe.accountId</code>) first.
    The resulting <code>btok_...</code> id is what you pass as
    <code>token</code> to <code>addPayoutMethod</code>.
    Test routing/account numbers (US): routing <code>110000000</code>,
    account <code>000123456789</code> (succeeds).
  </p>

  <label for="connect-account">Connect Account Id</label>
  <input id="connect-account" type="text" placeholder="acct_..." />

  <label for="account-holder-name">Account Holder Name</label>
  <input id="account-holder-name" type="text" value="Jane Business" />

  <label for="routing-number">Routing Number</label>
  <input id="routing-number" type="text" value="110000000" />

  <label for="account-number">Account Number</label>
  <input id="account-number" type="text" value="000123456789" />

  <button id="create-token">Create Payout Token</button>
  <div id="token-result" class="result"></div>

  <script>
    const stripe = Stripe("${PUBLISHABLE_KEY}");
    const elements = stripe.elements();
    const pmCard = elements.create("card");
    pmCard.mount("#pm-card-element");

    const showResult = (el, ok, payload) => {
      el.className = "result " + (ok ? "ok" : "err");
      el.textContent = JSON.stringify(payload, null, 2);
    };

    const pmResultEl = document.getElementById("pm-result");
    document.getElementById("create-pm").addEventListener("click", async () => {
      const { error, paymentMethod } = await stripe.createPaymentMethod({
        type: "card",
        card: pmCard,
      });

      if (error) return showResult(pmResultEl, false, { error: error.message, code: error.code, type: error.type });

      showResult(pmResultEl, true, {
        stripePaymentMethodId: paymentMethod.id,
        brand: paymentMethod.card.brand,
        last4: paymentMethod.card.last4,
      });
    });

    const secretResultEl = document.getElementById("secret-result");
    document.getElementById("confirm-secret").addEventListener("click", async () => {
      const clientSecret = document.getElementById("secret").value.trim();
      if (!clientSecret) return showResult(secretResultEl, false, { error: "Paste a clientSecret first" });

      const isSetupIntent = clientSecret.startsWith("seti_");
      const { error, paymentIntent, setupIntent } = isSetupIntent
        ? await stripe.handleNextActionForSetup({ clientSecret })
        : await stripe.handleNextAction({ clientSecret });

      if (error) return showResult(secretResultEl, false, { error: error.message, code: error.code, type: error.type });

      const intent = paymentIntent || setupIntent;
      showResult(secretResultEl, true, { id: intent.id, status: intent.status });
    });

    const tokenResultEl = document.getElementById("token-result");
    document.getElementById("create-token").addEventListener("click", async () => {
      const accountId = document.getElementById("connect-account").value.trim();
      if (!accountId) return showResult(tokenResultEl, false, { error: "Paste the business's Connect account id first" });

      const connectStripe = Stripe("${PUBLISHABLE_KEY}", { stripeAccount: accountId });

      const { error, token } = await connectStripe.createToken("bank_account", {
        country: "US",
        currency: "usd",
        account_holder_name: document.getElementById("account-holder-name").value.trim(),
        account_holder_type: "individual",
        routing_number: document.getElementById("routing-number").value.trim(),
        account_number: document.getElementById("account-number").value.trim(),
      });

      if (error) return showResult(tokenResultEl, false, { error: error.message, code: error.code, type: error.type });

      showResult(tokenResultEl, true, { token: token.id, bankName: token.bank_account?.bank_name, last4: token.bank_account?.last4 });
    });
  </script>
</body>
</html>`);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Stripe checkout tester running at http://127.0.0.1:${PORT}`);
});
