const express = require("express");
const router = express.Router();

const {
    getIceServers,
} = require("./iceServersController");

// Add your auth middleware if required
const auth = require("@middlewares/authMiddleware");

router.get(
    "/",
    auth,
    getIceServers
);

module.exports = router;