const express = require("express");
const auth = require("@middlewares/authMiddleware");
const createRateLimiter = require("@utils/rateLimiter");
const { search } = require("../controllers/searchController");

const router = express.Router();
const searchLimiter = createRateLimiter("unified-search", 10, 5);

router.use(auth);

// GET /search?query=soft glam&types=services,portfolios — or imageUrl=<upload key>
router.get("/", searchLimiter, search);

module.exports = router;
