const express = require("express");
const auth = require("@middlewares/authMiddleware");
const { getTags } = require("../../admin/controllers/tagController");

const router = express.Router();
router.use(auth);
router.get("/", getTags);

module.exports = router;
