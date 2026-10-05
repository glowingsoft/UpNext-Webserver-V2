const express = require("express");
const {
  getTermsAndConditionsAdmin,
  getAboutUsAdmin,
  getPrivacyPolicyAdmin,
  updateAdminSettings,
  createAdminSettings,
  getFaqs,
} = require("../../commonModules/controllers/settingsController");
const auth = require("@middlewares/authMiddleware");
const createRateLimiter = require("@utils/rateLimiter");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { createFaq, updateFaq, deleteFaq } = require("../controllers/adminPanelController");

const router = express.Router();

// Create a rate limiter for Admin Settings
const apiRateLimiter = createRateLimiter("AdminSettings");

// Route to fetch terms and conditions with rate limiting
router.get("/terms-conditions", apiRateLimiter, getTermsAndConditionsAdmin);

// Route to fetch about us with rate limiting
router.get("/about-us", apiRateLimiter, getAboutUsAdmin);

// Route to fetch privacy policy with rate limiting
router.get("/privacy-policy", apiRateLimiter, getPrivacyPolicyAdmin);

// Route to fetch privacy policy with rate limiting
router.get("/faqs", auth, roleMiddleware(["admin"]), apiRateLimiter, getFaqs);
router.post("/faqs", auth, roleMiddleware(["admin"]), apiRateLimiter, createFaq);
router.put("/faqs/:id", auth, roleMiddleware(["admin"]), apiRateLimiter, updateFaq);
router.delete("/faqs/:id", auth, roleMiddleware(["admin"]), apiRateLimiter, deleteFaq);

// Route to create admin settings (requires auth and admin privileges)
router.post("/create", auth, roleMiddleware(["admin"]), createAdminSettings);

// Route to update all settings at once (requires auth and admin privileges)
router.put("/update/:id", auth, roleMiddleware(["admin"]), updateAdminSettings);

module.exports = router;
