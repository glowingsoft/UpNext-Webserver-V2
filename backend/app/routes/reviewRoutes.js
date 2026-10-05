const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { getReviews, submitReview, updateReview } = require("../controllers/reviewController");

router.use(auth);

router.get("/", getReviews);
router.post("/", roleMiddleware(["user"]), submitReview);
router.put("/:reviewId", roleMiddleware(["user"]), updateReview);

module.exports = router;
