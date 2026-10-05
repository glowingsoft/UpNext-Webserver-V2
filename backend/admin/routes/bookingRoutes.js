const express = require("express");
const { getAllBookings, getBooking } = require("../controllers/bookingController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// GET /admin/bookings?page=1&limit=10&status=&scope=&date=&businessId=&userId=&keyword=
router.get("/", getAllBookings);

// GET /admin/bookings/:bookingId
router.get("/:bookingId", getBooking);

module.exports = router;
