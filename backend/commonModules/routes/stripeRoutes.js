const express = require("express");
const router = express.Router();
const webhookService = require("../../services/stripeWebhook");
const { WEB_BASE_URL, generateOnboardingLink, syncOnboardingStatusByAccountId } = require("../../services/stripeAccount");
const { sendResponse } = require("@utils/responseUtil");

// Mobile listens for this via InAppBrowser.openAuth(url, redirectUrl) and
// re-fetches status itself once it fires — no query params needed here.
const MOBILE_REDIRECT_URL = "upnext://stripe-onboarding-complete";
const WEB_HOME_URL = `${WEB_BASE_URL}/dashboard`;

// Fallback page for the (rare) case the mobile JS redirect doesn't fire —
// e.g. the app isn't installed, or openAuth's URL watcher missed it.
function renderOnboardingStatusPage({ title, message, redirectUrl }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  ${redirectUrl ? `<script>window.location.href = ${JSON.stringify(redirectUrl)};</script>` : ""}
  <style>
    body { font-family: -apple-system, Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #222; text-align: center; padding: 24px; box-sizing: border-box; }
    div { max-width: 360px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { font-size: 15px; color: #555; }
  </style>
</head>
<body>
  <div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
router.post(
  "/webhook",
  express.raw({ type: "application/json" }), // raw body required
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;
    try {
      event = webhookService.constructEvent(req.body, signature); // 👈 HERE
      console.log("Stripe webhook event received:", event.type);
    } catch (err) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "stripe_webhook_invalid_signature",
      });
    }

    try {
      await webhookService.processWebhookEvent(event); // then dispatch
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "stripe_webhook_received",
      });
    } catch (err) {
      return sendResponse({
        res,
        statusCode: 500,
        translationKey: "stripe_webhook_processing_error",
      });
    }
  },
);
// Stripe hits this when an account link expires or is otherwise invalid
// mid-flow — hand back a fresh link and let Stripe continue the session.
router.get("/onboarding/refresh", async (req, res) => {
  const { accountId, deviceType } = req.query;
  if (!accountId) {
    return res
      .status(400)
      .send(renderOnboardingStatusPage({ title: "Link expired", message: "This onboarding link is missing information. Please close this window and restart onboarding from the app." }));
  }

  try {
    const url = await generateOnboardingLink(accountId, deviceType);
    return res.redirect(url);
  } catch (err) {
    console.error("onboarding refresh error:", err.message);
    return res
      .status(500)
      .send(renderOnboardingStatusPage({ title: "Something went wrong", message: "We couldn't refresh your onboarding link. Please close this window and try again from the app." }));
  }
});

// Stripe redirects here when the user exits the flow, whether or not they
// actually finished it — re-check the account with Stripe rather than
// trusting the redirect itself. Web goes straight to the dashboard; mobile
// bounces through the app's custom-scheme redirect for openAuth to catch.
router.get("/onboarding/return", async (req, res) => {
  const { accountId, deviceType } = req.query;
  const isMobile = deviceType === "android" || deviceType === "ios";

  try {
    if (accountId) {
      await syncOnboardingStatusByAccountId(accountId);
    }
  } catch (err) {
    console.error("onboarding return status check error:", err.message);
  }

  if (!isMobile) {
    return res.redirect(WEB_HOME_URL);
  }

  return res.status(200).send(
    renderOnboardingStatusPage({
      title: "You're all set!",
      message: "You can close this window and return to the app.",
      redirectUrl: MOBILE_REDIRECT_URL,
    }),
  );
});

router.get("/test", (req, res) => {
  return sendResponse({
    res,
    statusCode: 200,
    translationKey: "stripe_test_success",
  });
});

module.exports = router;
