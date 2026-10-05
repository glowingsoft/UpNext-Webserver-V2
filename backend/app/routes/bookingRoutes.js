const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const {
  getSlots,
  createBooking,
  getUserBookings,
  getBusinessBookings,
  getBillingHistory,
  getBillingHistoryDetail,
  getBookingsCalendar,
  getBookingById,
  acceptBooking,
  startBooking,
  rejectBooking,
  cancelBooking,
  completeBooking,
  fixPayment,
  sendReminder,
} = require("../controllers/bookingController");
const { blockOutstandingDebt } = require("@middlewares/debtMiddleware");

router.use(auth);

// Dev/test only: trigger a lifecycle cron on demand instead of waiting for
// its schedule. Not registered in prod.
if (process.env.NODE_ENV !== "prod") {
  const {
    runApprovalExpiryCron,
    runHorizonChargeCron,
    runPaymentFixGraceCron,
    runStatusTransitionCron,
  } = require("../services/bookingLifecycleService");
  const testCrons = {
    "approval-expiry": runApprovalExpiryCron,
    "horizon-charge": runHorizonChargeCron,
    "payment-fix-grace": runPaymentFixGraceCron,
    "status-transition": runStatusTransitionCron,
  };
  router.post("/test/run-cron/:name", async (req, res) => {
    const fn = testCrons[req.params.name];
    if (!fn) return res.status(404).json({ message: "Unknown cron", available: Object.keys(testCrons) });
    try {
      await fn();
      res.json({ message: `Cron ${req.params.name} executed` });
    } catch (err) {
      console.error(`Test cron ${req.params.name} error:`, err);
      res.status(500).json({ message: err.message });
    }
  });
}

router.get("/slots", blockOutstandingDebt, getSlots);
router.post("/", roleMiddleware(["user"]), blockOutstandingDebt, createBooking);
router.get("/", roleMiddleware(["user"]), getUserBookings);
router.get("/business", roleMiddleware(["business"]), getBusinessBookings);
router.get("/billing-history", roleMiddleware(["business"]), getBillingHistory);
router.get("/billing-history/:id", roleMiddleware(["business"]), getBillingHistoryDetail);
router.get("/calendar", getBookingsCalendar);
router.get("/:id", getBookingById);
router.patch("/:id/accept", roleMiddleware(["business"]), acceptBooking);
router.patch("/:id/start", roleMiddleware(["business"]), startBooking);
router.patch("/:id/reject", roleMiddleware(["business"]), rejectBooking);
router.patch("/:id/cancel", cancelBooking);
router.patch("/:id/complete", roleMiddleware(["business"]), completeBooking);
router.post("/:id/fix-payment", roleMiddleware(["user"]), fixPayment);
router.post("/:id/reminder", roleMiddleware(["business"]), sendReminder);

module.exports = router;
