const express = require("express");
const { getHome, getEvents } = require("../controllers/homeController");
const auth = require("@middlewares/authMiddleware");

const router = express.Router();
router.use(auth);

// Get all homes with pagination
router.get("/", getHome);
router.get("/events", getEvents);

module.exports = router;
