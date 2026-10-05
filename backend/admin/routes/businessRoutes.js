const express = require("express");
const {
  getAllBusinessesAdmin,
  getBusinessOverview,
  getBusinessServices,
  getBusinessPackages,
  getBusinessPromotions,
  getOperatingHours,
  updateOperatingHours,
  getBookings,
  getReviews,
  moderateBusinessReview,
  deleteBusinessReview,
  getAllProductReviews,
} = require("../controllers/businessController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// List — GET /admin/businesses?page=1&limit=10&status=&keyword=...
router.get("/", getAllBusinessesAdmin);

// Overview tab — single business, same shape as a list item
router.get("/:businessId/overview", getBusinessOverview);

// Services / Packages / Promotions tabs
router.get("/:businessId/services", getBusinessServices);
router.get("/:businessId/packages", getBusinessPackages);
router.get("/:businessId/promotions", getBusinessPromotions);

// Operating Hours tab
router.get("/:businessId/operating-hours", getOperatingHours);
router.put("/:businessId/operating-hours", updateOperatingHours);

// Bookings tab
router.get("/:businessId/bookings", getBookings);

// Reviews tab
router.get("/reviews", getAllProductReviews);
router.get("/:businessId/reviews", getReviews);
router.patch("/:businessId/reviews/:reviewId/status", moderateBusinessReview);
router.delete("/:businessId/reviews/:reviewId", deleteBusinessReview);

module.exports = router;
