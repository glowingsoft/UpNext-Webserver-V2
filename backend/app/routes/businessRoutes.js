const express = require("express");
const {
  getBusinessOverview,
  getBusinessServicesTab,
  getBusinessPackagesTab,
  getBusinessPromotionsTab,
  getOperatingHours,
  getBookings,
  getReviews,
  getBusinessPortfolios,
} = require("../controllers/businessController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["user"]));

// Overview tab — business profile fields + a top-3 rated services preview
router.get("/:businessId/overview", getBusinessOverview);

// Services / Packages tabs
router.get("/:businessId/services", getBusinessServicesTab);
router.get("/:businessId/packages", getBusinessPackagesTab);

// Promotions tab — businessId is a query param here (not path), since the
// response is paginated targets (services/packages) with promotion data
// attached, not a business-scoped sub-resource list
router.get("/promotions", getBusinessPromotionsTab);

// Operating Hours tab (read only — only the business itself can update its hours)
router.get("/:businessId/operating-hours", getOperatingHours);

// Bookings tab — only the caller's own bookings with this business
router.get("/:businessId/bookings", getBookings);

// Reviews tab
router.get("/:businessId/reviews", getReviews);

// Portfolios tab
router.get("/:businessId/portfolios", getBusinessPortfolios);

module.exports = router;
