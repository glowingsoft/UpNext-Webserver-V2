const express = require("express");
const {
  getHelpCenterItemsAdmin,
  getHelpCenterItemAdmin,
  createHelpCenterItem,
  updateHelpCenterItem,
  deleteHelpCenterItem,
} = require("../../commonModules/controllers/helpCenterController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// GET /admin/help-center?page=1&limit=10&status=&keyword= — always every language
router.get("/", getHelpCenterItemsAdmin);

// GET /admin/help-center/:id — always every language
router.get("/:id", getHelpCenterItemAdmin);

router.post("/", createHelpCenterItem);
router.put("/:id", updateHelpCenterItem);
router.delete("/:id", deleteHelpCenterItem);

module.exports = router;
