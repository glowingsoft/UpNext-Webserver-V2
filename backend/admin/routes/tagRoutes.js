const express = require("express");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { getTags, getTag, createTag, updateTag, deleteTag } = require("../controllers/tagController");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));
router.get("/", getTags);
router.get("/:tagId", getTag);
router.post("/", createTag);
router.put("/:tagId", updateTag);
router.delete("/:tagId", deleteTag);
module.exports = router;
