const express = require("express");
const { getCustomers, getCustomer, getCustomerBookings } = require("../controllers/customerController");
const auth = require("@middlewares/authMiddleware");
const roleMiddleware = require("@middlewares/roleMiddleware");

const router = express.Router();
router.use(auth, roleMiddleware(["admin"]));

// GET /admin/customers?page=1&limit=10&status=&keyword=
router.get("/", getCustomers);

// GET /admin/customers/:userId — Profile tab
router.get("/:userId", getCustomer);

// GET /admin/customers/:userId/bookings — Bookings tab, separate endpoint
router.get("/:userId/bookings", getCustomerBookings);

module.exports = router;
