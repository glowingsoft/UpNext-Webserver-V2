const express = require("express");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const createRateLimiter = require("@utils/rateLimiter");

const {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getSingleCategory,
} = require("../controllers/categoryController");

const router = express.Router();
router.use(auth);

const apiRateLimiter = createRateLimiter("Categories", 10, 80);

// Public category routes
router.get("/", apiRateLimiter, getAllCategories);
router.get("/:categoryId", apiRateLimiter, getSingleCategory);

// Admin-only category routes
router.use(roleMiddleware(["admin"]));

router.post("/", apiRateLimiter, createCategory);
router.put("/:categoryId", apiRateLimiter, updateCategory);
router.delete("/:categoryId", apiRateLimiter, deleteCategory);

module.exports = router;
