const express = require("express");
const { getHelpCenterItems, getHelpCenterItem } = require("../../commonModules/controllers/helpCenterController");
const createRateLimiter = require("@utils/rateLimiter");

const router = express.Router();
const helpCenterRateLimiter = createRateLimiter("helpCenter");

// Public — no auth required
router.get("/", helpCenterRateLimiter, getHelpCenterItems);
router.get("/:id", helpCenterRateLimiter, getHelpCenterItem);

module.exports = router;
