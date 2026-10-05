const express = require("express");
const {
  getSupportRequests,
  getSupportRequest,
  updateSupportRequestStatus,
  deleteSupportRequest,
} = require("../controllers/adminPanelController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// GET /admin/support?page=1&limit=10&status=&keyword= - paginated list
router.get("/", getSupportRequests);

// GET /admin/support/:id - single support request
router.get("/:id", getSupportRequest);

// PATCH /admin/support/:id/status - update status
router.patch("/:id/status", updateSupportRequestStatus);

// DELETE /admin/support/:id
router.delete("/:id", deleteSupportRequest);

module.exports = router;
