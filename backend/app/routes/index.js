const express = require("express");
const router = express.Router();

const homeRoutes = require("./homeRoutes");
const usersRoutes = require("./userRoutes");
const notificationsRoutes = require("./notificationsRoutes");
const settingsRoutes = require("./settingsRoutes");
const supportRoutes = require("./supportRoutes");
const contactUsRoutes = require("./contactUsRoutes");
const serviceRoutes = require("./serviceRoutes");
const packageRoutes = require("./packageRoutes");
const promotionRoutes = require("./promotionRoutes");
const bookingRoutes = require("./bookingRoutes");
const reviewRoutes = require("./reviewRoutes");
const paymentRoutes = require("./paymentRoutes");
const portfolioRoutes = require("./portfolioRoutes");
const helpCenterRoutes = require("./helpCenterRoutes");
const businessRoutes = require("./businessRoutes");
const publicRoutes = require("./publicRoutes");


router.use("/public", publicRoutes);
router.use("/support", supportRoutes);
router.use("/help-center", helpCenterRoutes);
router.use("/contact-us", contactUsRoutes);
router.use("/settings", settingsRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/home", homeRoutes);
router.use("/users", usersRoutes);
router.use("/services", serviceRoutes);
router.use("/packages", packageRoutes);
router.use("/promotions", promotionRoutes);
router.use("/bookings", bookingRoutes);
router.use("/reviews", reviewRoutes);
router.use("/payments", paymentRoutes);
router.use("/portfolios", portfolioRoutes);
router.use("/businesses", businessRoutes);
router.use("/conversations",require("../../commonModules/chatModule/routes/messageRoutes"));
router.use("/webrtc/ice-servers", require("../../../webrtc/icServersRoutes"))

module.exports = router;
