const express = require("express");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { sendNotificationControllerForTesting } = require("@controllersCommonModules/communicationController");

const router = express.Router();

// POST /api/v1/communications/send-notification
// Body: { recipients: [{ deviceId, deviceType }], title, body, data }
//
// Pushes straight to the FCM device tokens given in the body — it does not
// look up users, honour notification preferences, or save an in-app
// notification row. That's what makes it useful for verifying device
// registration, and also why it's admin-only: anyone who can call it can push
// arbitrary content to any device token they know.
router.post("/send-notification", auth, roleMiddleware(["admin"]), sendNotificationControllerForTesting);

module.exports = router;
