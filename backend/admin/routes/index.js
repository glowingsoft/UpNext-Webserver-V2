const express = require("express");
const router = express.Router();

// const bulkInsertRoutes = require("./dbRoutes.js");
const adminSettingsRoutes = require("./settingsRoutes.js");
const userRoutes = require("./userRoutes.js");
const languageRoutes = require("./languageRoutes.js");
const supportRoutes = require("./supportRoutes.js");
const helpCenterRoutes = require("./helpCenterRoutes.js");
const customerRoutes = require("./customerRoutes.js");
const bookingRoutes = require("./bookingRoutes.js");
const businessRoutes = require("./businessRoutes.js");
const badgeRoutes = require("./badgeRoutes.js");
const homeRoutes = require("./homeRoutes.js");
const tagRoutes = require("./tagRoutes.js");
router.use("/home", homeRoutes);
router.use("/settings", adminSettingsRoutes);
//db utils routes
// router.use("/util", bulkInsertRoutes);
router.use("/users", userRoutes);
router.use("/languages", languageRoutes);
router.use("/support", supportRoutes);
router.use("/help-center", helpCenterRoutes);
router.use("/customers", customerRoutes);
router.use("/bookings", bookingRoutes);
router.use("/businesses", businessRoutes);
router.use("/badges", badgeRoutes);
router.use("/tags", tagRoutes);

module.exports = router;
