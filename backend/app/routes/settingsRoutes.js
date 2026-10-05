const express = require("express");
const {
  getTermsAndConditions,
  getAboutUs,
  getPrivacyPolicy,
  getFaqs
} = require("../../commonModules/controllers/settingsController");
const createRateLimiter = require("@utils/rateLimiter");

const router = express.Router();

// Create a rate limiter for Admin Settings
const apiRateLimiter = createRateLimiter("AdminSettings");

// Route to fetch terms and conditions with rate limiting
router.get("/terms-conditions", apiRateLimiter, getTermsAndConditions);

// Route to fetch about us with rate limiting
router.get("/about-us", apiRateLimiter, getAboutUs);

// Route to fetch privacy policy with rate limiting
router.get("/privacy-policy", apiRateLimiter, getPrivacyPolicy);

// Route to fetch FAQs with rate limiting
router.get("/faqs", apiRateLimiter, getFaqs);

module.exports = router;
