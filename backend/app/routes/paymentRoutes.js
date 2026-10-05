const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { settleOutstandingDebt } = require("../controllers/paymentController");

router.use(auth);

// "Complete Payment" button — settle outstanding debt after a failed capture
router.post("/booking/:bookingId", roleMiddleware(["user"]), settleOutstandingDebt);

module.exports = router;
