const express = require("express");
const auth = require("../../middlewares/authMiddleware");
const createRateLimiter = require("../../helperUtils/rateLimiter");

const {
    getNotifications,
    readNotification,
} = require("../controllers/notificationsController");

const router = express.Router();
const notificationsRateLimiter = createRateLimiter("notifications", 10, 50);

// Route to get all notifications with pagination
router.get("/", notificationsRateLimiter, auth, getNotifications);

// Route to mark notifications as read. Optional { ids: [...] } in the body
// marks just those; omit it and the caller's whole list is marked read.
router.put("/read", notificationsRateLimiter, auth, readNotification);

module.exports = router;
