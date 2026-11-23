const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const c = require("../controllers/instantController");

router.use(auth, roleMiddleware(["admin"]));

router.get("/settings", c.getSettings);
router.put("/settings", c.updateSettings);
router.patch("/bookings/:id/no-show", c.resolveNoShowHandler);
router.get("/disputes", c.listDisputes);
router.patch("/disputes/:id/fault", c.setDisputeFault);
router.get("/penalties", c.listPenalties);

module.exports = router;
