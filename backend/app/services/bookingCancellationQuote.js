const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const getCancellationQuote = async ({ bookingId, userId, businessId, userType }) => {
  if (!["user", "business"].includes(userType) ||
      (userType === "business" && !businessId) || (userType === "user" && !userId)) {
    return { error: "booking_not_found", status: 404 };
  }
  const owner = userType === "business" ? { business: businessId } : { user: userId };
  const booking = await Booking.findOne({ _id: bookingId, mode: "instant", ...owner }).lean();
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (userType !== "user") return { error: "booking_cannot_cancel", status: 409 };

  if (["requested", "awaiting_customer_decision"].includes(booking.status)) {
    if (booking.paymentStatus !== "pending" || booking.payment != null || booking.pricing?.heldCents !== 0) {
      return { error: "booking_cannot_cancel", status: 409 };
    }
    if (booking.status === "requested") {
      const offerId = booking.flow?.currentOffer?.offerId;
      if (!offerId) return { error: "booking_cannot_cancel", status: 409 };
      const [offer, provider] = await Promise.all([
        BookingOffer.exists({ _id: offerId, booking: booking._id, business: booking.business, status: "pending" }),
        BusinessProfile.findById(booking.business, "user").lean(),
      ]);
      if (!offer || !provider?.user) return { error: "booking_cannot_cancel", status: 409 };
    }
  } else if (booking.status !== "accepted_awaiting_payment" || !booking.authorization?.offerId) {
    return { error: "booking_cannot_cancel", status: 409 };
  }

  return {
    data: {
      bookingId: booking._id,
      bookingStatus: booking.status,
      canceledBy: "user",
      currency: "usd",
      penaltyCents: 0,
      chargeCents: 0,
      authorizationRelease: booking.status === "accepted_awaiting_payment" ? "if_present" : "not_applicable",
    },
  };
};

module.exports = { getCancellationQuote };
