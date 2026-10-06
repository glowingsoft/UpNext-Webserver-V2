const express = require("express");
const auth = require("@middlewares/authMiddleware");
const uploadSearchImage = require("@middlewares/uploadSearchImageMw");
const createRateLimiter = require("@utils/rateLimiter");
const { searchByImage } = require("../controllers/imageSearchController");

const router = express.Router();
// Every request is a paid vision call, so this gets its own, tighter limit.
const imageSearchLimiter = createRateLimiter("image-search", 10, 5);

// router.use(auth);

// POST /image-search — multipart `image`, or JSON { imageUrl, keyword? }
router.post("/", imageSearchLimiter, uploadSearchImage, searchByImage);

module.exports = router;
