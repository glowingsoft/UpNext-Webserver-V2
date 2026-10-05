const express = require("express");
const {
  addBadge,
  getBadges,
  getBadgeByName,
  updateBadge,
  deleteBadge,
  addBadgeOption,
  updateBadgeOption,
  deleteBadgeOption,
} = require("../controllers/badgeController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const createRateLimiter = require("@utils/rateLimiter");

const router = express.Router();
router.use(auth);

// Create a rate limiter for Badge operations
const apiRateLimiter = createRateLimiter("Badge");

// Get all badges (public access)
router.get("/", apiRateLimiter, getBadges);

// Get badge by name (public access)
router.get("/:name", apiRateLimiter, getBadgeByName);

// Add badge (admin only)
router.use(roleMiddleware(["admin"]));
router.post("/", apiRateLimiter, addBadge);

// Update badge (admin only)
router.put("/:badgeId", apiRateLimiter, updateBadge);

// Delete badge (admin only)
router.delete("/:badgeId", apiRateLimiter, deleteBadge);

// Add badge option (admin only)
router.post("/:badgeId/option", apiRateLimiter, addBadgeOption);

// Update badge option (admin only)
router.put("/:badgeId/option/:optionId", apiRateLimiter, updateBadgeOption);

// Delete badge option (admin only)
router.delete("/:badgeId/option/:optionId", apiRateLimiter, deleteBadgeOption);

module.exports = router;
