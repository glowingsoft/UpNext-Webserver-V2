const Booking = require("@models/Bookings");
const { closeOffer } = require("./bookingOfferResponse");

const findCustomerDecisionBooking = async ({ bookingId, userId, now, paymentGuard = {} }) => {
  const filter = {
    _id: bookingId,
    user: userId,
    status: "awaiting_customer_decision",
    "flow.attemptExpiresAt": { $gt: now },
    ...paymentGuard,
  };
  let booking = await Booking.findOne(filter).lean();
  if (booking) return booking;

  const expiredOffer = await Booking.exists({
    _id: bookingId,
    user: userId,
    status: "requested",
    offerExpiresAt: { $type: "date", $lte: now },
    "flow.currentOffer.offerId": { $exists: true, $ne: null },
  });
  if (expiredOffer) await closeOffer({ bookingId, userId, expired: true, now });

  // The expiry worker may have finished between the first lookup and this one.
  booking = await Booking.findOne(filter).lean();
  return booking;
};

module.exports = { findCustomerDecisionBooking };
