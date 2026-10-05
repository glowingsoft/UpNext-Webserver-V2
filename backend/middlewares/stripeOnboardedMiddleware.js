const { sendResponse } = require("@utils/responseUtil");

/**
 * Gate for business create routes (services / packages / promotions).
 * Lifecycle order: business profile must be active, then Stripe Connect
 * onboarding must be complete, before the business can sell anything.
 */
const stripeOnboarded = (req, res, next) => {
  // authMiddleware attaches businessId only when an active BusinessProfile exists
  if (!req.user?.businessId) {
    return sendResponse({
      res,
      statusCode: 403,
      translationKey: "business_profile_incomplete",
    });
  }

  // Opt-in bypass for quick local testing — same flag as getAccountStatus
  if (process.env.STRIPE_ONBOARDING_BYPASS === "true") {
    return next();
  }

  if (!req.user?.stripe?.onboardingComplete) {
    return sendResponse({
      res,
      statusCode: 403,
      translationKey: "stripe_onboarding_required",
    });
  }

  next();
};

module.exports = { stripeOnboarded };
