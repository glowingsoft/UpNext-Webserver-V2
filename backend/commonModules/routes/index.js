const express = require("express");
const router = express.Router();

const authRoutes = require("./authRoutes.js");
const badgeRoutes = require("./badgeRoutes.js");
const categoryRoutes = require("./categoryRoutes.js");
const tagRoutes = require("./tagRoutes.js");

const communicationRoutes = require("./communicationRoutes.js");
const uploadRoutes = require("./uploadRoutes.js");
const uploads3Routes = require("./uploadAWSRoutes.js");
const iceServersRoutes = require("../../../webrtc/icServersRoutes");

router.use("/upload", uploadRoutes);
router.use("/upload/s3", uploads3Routes);

router.use("/auth", authRoutes);
router.use("/badges", badgeRoutes);
router.use("/categories", categoryRoutes);
router.use("/tags", tagRoutes);
router.use("/communications", communicationRoutes);
router.use("/ice-servers", iceServersRoutes);

module.exports = router;
