const express = require("express");
const router = express.Router();
const {
  createPromotion,
  updatePromotion,
  deletePromotion,
  getAllPromotions,
  getPromotionById,
  validatePromoCode,
} = require("../controllers/promotionController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { stripeOnboarded } = require("@middlewares/stripeOnboardedMiddleware");

router.use(auth); // Middleware to authenticate the user
// ─── Get All Promotions ───────────────────────────────────────────
router.get("/", getAllPromotions); // GET /promotions - Get all promotions

// ─── Create Promotion ─────────────────────────────────────────────
router.post("/", roleMiddleware(["business"]), stripeOnboarded, createPromotion); // POST /promotions - Only business can create promotions

// ─── Validate a promo code (checkout "Apply Promo Code") ───────────
router.post("/check-promo-code", roleMiddleware(["user"]), validatePromoCode); // POST /promotions/check-promo-code

// ─── Get Promotion by ID ───────────────────────────────────────────
router.get("/:promotionId", getPromotionById); // GET /promotions/:promotionId - Get promotion by ID

// ─── Update Promotion by ID ───────────────────────────────────────
router.put("/:promotionId", roleMiddleware(["business"]), updatePromotion); // PUT /promotions/:promotionId - Only business can update promotion

// ─── Delete Promotion by ID ───────────────────────────────────────
router.delete("/:promotionId", roleMiddleware(["business"]), deletePromotion); // DELETE /promotions/:promotionId - Only business can delete promotion

module.exports = router;
