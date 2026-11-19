const express = require("express");
const router = express.Router();
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { blockOutstandingDebt } = require("@middlewares/debtMiddleware");
const c = require("../controllers/instantController");
const { getSlots, getInstantUserBookings } = require("../controllers/bookingController");

router.use(auth);

// Dev/test only: run the background jobs on demand. Not registered in prod.
if (process.env.NODE_ENV !== "prod") {
  router.post("/test/run-sweeper", c.runSweeper);
  router.post("/test/run-payments-cron", c.runPaymentsCron);
}

// Client
router.get("/quote", roleMiddleware(["user"]), c.quote);
router.post("/bookings", roleMiddleware(["user"]), blockOutstandingDebt, c.createBooking);
router.get("/bookings", roleMiddleware(["user"]), getInstantUserBookings);
router.get("/bookings/:id/next-providers", roleMiddleware(["user"]), c.nextProviders);
router.post("/bookings/:id/send-again", roleMiddleware(["user"]), c.sendAgain);
router.post("/bookings/:id/send-next", roleMiddleware(["user"]), c.sendNext);
router.post("/bookings/:id/fix-payment", roleMiddleware(["user"]), c.fixPayment);
router.post("/bookings/:id/cancel", roleMiddleware(["user"]), c.cancelPendingBooking);
router.patch("/bookings/:id/cancel", roleMiddleware(["user"]), c.cancelBooking);
router.post("/bookings/:id/no-show", roleMiddleware(["user"]), c.reportNoShow);
router.get("/bookings/slots", blockOutstandingDebt, getSlots);

// Provider
router.get("/offers", roleMiddleware(["business"]), c.providerOffers);
router.get("/offers/current", roleMiddleware(["business"]), c.currentOffer);
router.patch("/offers/:offerId/accept", roleMiddleware(["business"]), c.acceptOffer);
router.patch("/offers/:offerId/decline", roleMiddleware(["business"]), c.declineOffer);
router.post("/bookings/:id/decline", roleMiddleware(["business"]), c.declineBooking);
router.patch("/bookings/:id/start", roleMiddleware(["business"]), c.start);
router.patch("/bookings/:id/complete", roleMiddleware(["business"]), c.complete);
router.patch("/bookings/:id/provider-cancel", roleMiddleware(["business"]), c.providerCancel);
router.post("/bookings/:id/no-show/contest", roleMiddleware(["business"]), c.contestNoShow);

// Both parties
router.post("/bookings/:id/customer-arrived", roleMiddleware(["user", "business"]), c.customerArrived);
router.get("/bookings/:id/quote/cancel", roleMiddleware(["user", "business"]), c.cancellationQuote);
router.get("/bookings/:id", roleMiddleware(["user", "business"]), c.getBooking);

module.exports = router;
