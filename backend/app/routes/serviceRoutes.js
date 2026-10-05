const express = require("express");
const router = express.Router();
const {
  createService,
  getService,
  updateService,
  deleteService,
  getAllServices,
  getServiceCategories,
  createServiceCategory,
  updateServiceCategory,
  suggestServiceCategoryForService,
} = require("../controllers/serviceController"); // Import your controller functions
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { stripeOnboarded } = require("@middlewares/stripeOnboardedMiddleware");
const createRateLimiter = require("@utils/rateLimiter");
const suggestCategoryLimiter = createRateLimiter("suggest-category", 10, 5);

router.use(auth);

router.get("/", getAllServices); // GET /services - Get all services
// ─── Create Service ───────────────────────────────────────────────
router.post("/", roleMiddleware(["business"]), stripeOnboarded, createService); // POST /services

// ─── My Service Categories (ahead of /:serviceId to avoid collision) ──
router.get("/categories", roleMiddleware(["business"]), getServiceCategories); // GET /services/categories
router.post("/categories", roleMiddleware(["business"]), createServiceCategory); // POST /services/categories
router.put("/categories/:categoryId", roleMiddleware(["business"]), updateServiceCategory); // PUT /services/categories/:categoryId

// ─── AI: Suggest Service Category (from name/description) ─────────
router.post(
  "/suggest-category",
  roleMiddleware(["business"]),
  suggestCategoryLimiter,
  suggestServiceCategoryForService,
); // POST /services/suggest-category

// ─── Get Service by ID ────────────────────────────────────────────
router.get("/:serviceId", getService); // GET /services/:serviceId

// ─── Update Service by ID ──────────────────────────────────────────
router.put("/:serviceId", roleMiddleware(["business"]), updateService); // PUT /services/:serviceId

// ─── Delete Service by ID ──────────────────────────────────────────
router.delete("/:serviceId", roleMiddleware(["business"]), deleteService); // DELETE /services/:serviceId

module.exports = router;
