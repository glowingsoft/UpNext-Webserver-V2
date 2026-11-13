const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { blockOutstandingDebt } = require("@middlewares/debtMiddleware");
const c = require("../controllers/instantController");

router.use(auth);

// Dev/test only: run the background jobs on demand. Not registered in prod.
if (process.env.NODE_ENV !== "prod") {
  router.post("/test/run-sweeper", c.runSweeper);
  router.post("/test/run-payments-cron", c.runPaymentsCron);
}

// Client
router.get("/quote", roleMiddleware(["user"]), c.quote);
router.post("/bookings", roleMiddleware(["user"]), blockOutstandingDebt, c.createBooking);
router.patch("/bookings/:id/cancel", roleMiddleware(["user"]), c.cancelBooking);
router.post("/bookings/:id/no-show", roleMiddleware(["user"]), c.reportNoShow);

// Provider
router.get("/offers/current", roleMiddleware(["business"]), c.currentOffer);
router.patch("/offers/:offerId/accept", roleMiddleware(["business"]), c.acceptOffer);
router.patch("/offers/:offerId/decline", roleMiddleware(["business"]), c.declineOffer);
router.patch("/bookings/:id/arrived", roleMiddleware(["business"]), c.arrived);
router.patch("/bookings/:id/complete", roleMiddleware(["business"]), c.complete);
router.patch("/bookings/:id/provider-cancel", roleMiddleware(["business"]), c.providerCancel);
router.post("/bookings/:id/no-show/contest", roleMiddleware(["business"]), c.contestNoShow);

// Both parties
router.get("/bookings/:id", roleMiddleware(["user", "business"]), c.getBooking);

module.exports = router;
