const express = require("express");
const { getBadgesList } = require("@controllersCommonModules/badgeController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// GET /admin/badges?page=1&limit=100&scope=business&status=&keyword=
router.get("/", getBadgesList);

module.exports = router;
