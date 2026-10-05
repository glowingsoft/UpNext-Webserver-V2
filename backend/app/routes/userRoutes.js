const express = require("express");
const auth = require("@middlewares/authMiddleware");

const {
  blockUser,
  reportUser,
  addOrUpdateSubscription,
  removeSubscription,
  getSubscriptions,
  getUserProfile,
  updateUserProfile,
  getOtherUserProfile,
  createOrUpdateUserProfile,
  createOrUpdateBusinessProfile,
  suggestBusinessProfileDescription,
  submitCertifications,
  updateOperatingHours,
  updateAvailability,
  getUserBusinesses,
  getSelectedCategories,
  getNotificationPreferences,
  updateNotificationPreferences,
  updateTwoFactorAuth,
  switchAccount,
} = require("../controllers/userController");
const { addCard, getCards, updateCard, deleteCard } = require("../controllers/cardController");
const {
  getAnalytics,
  getRevenue,
  getRevenueClients,
  getPayoutMethods,
  addPayoutMethod,
  deletePayoutMethod,
  withdrawFunds,
} = require("../controllers/businessFinanceController");
const roleMiddleware = require("@middlewares/roleMiddleware");
const router = express.Router();
const createRateLimiter = require("@utils/rateLimiter");
const suggestBusinessProfileDescriptionLimiter = createRateLimiter("suggest-business-profile-description", 10, 5);
// Apply auth middleware to the router
router.use(auth);

// // Specify the fields you want to populate dynamically
// const fieldsToPopulate = [
//   "profileIcon",
//   "age",
// ];

router.get("/businesses", getUserBusinesses);
router.get("/categories", roleMiddleware(["user", "business"]), getSelectedCategories);
router.get("/notification-preferences", roleMiddleware(["user", "business"]), getNotificationPreferences);
router.put("/notification-preferences", roleMiddleware(["user", "business"]), updateNotificationPreferences);
router.patch("/2fa", roleMiddleware(["user", "business", "admin"]), updateTwoFactorAuth);

router.get("/profile", (req, res, next) => {
  getUserProfile(req, res, next);
});

router.get("/profile/:userId", (req, res, next) => {
  getOtherUserProfile(req, res, next);
});

router.put("/profile", updateUserProfile);
router.post("/:userIdToBlock/block", blockUser);
router.post("/:userIdToReport/report", reportUser);
router.post("/add-update-subscription", addOrUpdateSubscription);
router.patch("/switch-account", roleMiddleware(["user", "business"]), switchAccount);
router.post("/user-profile", roleMiddleware(["user"]), createOrUpdateUserProfile);
router.post(
  "/business-profile/suggest-description",
  roleMiddleware(["business"]),
  suggestBusinessProfileDescriptionLimiter,
  suggestBusinessProfileDescription,
);
router.post("/business-profile", roleMiddleware(["business"]), createOrUpdateBusinessProfile);
router.patch("/business-profile/certifications", roleMiddleware(["business"]), submitCertifications);
router.patch("/business-profile/operating-hours", roleMiddleware(["business"]), updateOperatingHours);
router.patch("/business-profile/availability", roleMiddleware(["business"]), updateAvailability);
router.get("/business-profile/analytics", roleMiddleware(["business"]), getAnalytics);
router.get("/business-profile/revenue", roleMiddleware(["business"]), getRevenue);
router.get("/business-profile/revenue/clients", roleMiddleware(["business"]), getRevenueClients);
router.get("/business-profile/payout-methods", roleMiddleware(["business"]), getPayoutMethods);
router.post("/business-profile/payout-methods", roleMiddleware(["business"]), addPayoutMethod);
router.delete("/business-profile/payout-methods/:id", roleMiddleware(["business"]), deletePayoutMethod);
router.post("/business-profile/withdraw", roleMiddleware(["business"]), withdrawFunds);
router.post("/remove-subscription/:subscriptionId", removeSubscription);
router.get("/subscriptions", getSubscriptions);
router.post("/cards", roleMiddleware(["user"]), addCard);
router.get("/cards", roleMiddleware(["user"]), getCards);
router.patch("/cards/:id", roleMiddleware(["user"]), updateCard);
router.delete("/cards/:id", roleMiddleware(["user"]), deleteCard);

module.exports = router;
