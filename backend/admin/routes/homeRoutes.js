const express = require("express");
const { getHome } = require("../controllers/homeController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// Dashboard — GET /admin/home?usersYear=2026&comparisonYear=2025
// The two years are independent: each chart has its own dropdown.
router.get("/", getHome);

module.exports = router;
