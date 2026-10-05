const express = require("express");
const router = express.Router();
const {
  createPackage,
  getPackage,
  updatePackage,
  deletePackage,
  getAllPackages,
} = require("../controllers/packageController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { stripeOnboarded } = require("@middlewares/stripeOnboardedMiddleware");

router.use(auth);

router.get("/", getAllPackages); // GET /packages - Get all packages

// ─── Create Package ───────────────────────────────────────────────
router.post("/", roleMiddleware(["business"]), stripeOnboarded, createPackage); // POST /packages

// ─── Get Package by ID ────────────────────────────────────────────
router.get("/:packageId", getPackage); // GET /packages/:packageId

// ─── Update Package by ID ─────────────────────────────────────────
router.put("/:packageId", roleMiddleware(["business"]), updatePackage); // PUT /packages/:packageId

// ─── Delete Package by ID ─────────────────────────────────────────
router.delete("/:packageId", roleMiddleware(["business"]), deletePackage); // DELETE /packages/:packageId

module.exports = router;
