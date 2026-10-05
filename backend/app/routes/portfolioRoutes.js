const express = require("express");
const router = express.Router();
const {
  createPortfolio,
  getPortfolio,
  getAllPortfolios,
  searchPortfolios,
  updatePortfolio,
  deletePortfolio,
} = require("../controllers/portfolioController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const createRateLimiter = require("@utils/rateLimiter");
const searchPortfoliosLimiter = createRateLimiter("search-portfolios", 10, 5);

router.use(auth);

router.get("/", getAllPortfolios);

// ─── AI: Natural-Language Portfolio Search ──────────────────────────
router.get("/search", searchPortfoliosLimiter, searchPortfolios); // GET /portfolios/search?query=soft glam highlights

router.post("/", roleMiddleware(["business"]), searchPortfoliosLimiter, createPortfolio);

router.get("/:portfolioId", getPortfolio);

router.put("/:portfolioId", roleMiddleware(["business"]), updatePortfolio);

router.delete("/:portfolioId", roleMiddleware(["business"]), deletePortfolio);

module.exports = router;
