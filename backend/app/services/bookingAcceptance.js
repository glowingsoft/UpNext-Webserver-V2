const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { getInstantSettings } = require("@utils/instantPricing");
const { transitionBooking } = require("./bookingStateMachine");
const { emitOfferClosed } = require("@socketIo/instantOfferSocketEmitter");

const acceptBookingOffer = async ({ offerId, businessId, now }) => {
  if (!offerId || !businessId) return { error: "booking_offer_unavailable", status: 409 };
  const settings = await getInstantSettings();
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const currentTime = now || new Date();
      const booking = await Booking.findOne({
        business: businessId,
        status: "requested",
        "flow.currentOffer.offerId": offerId,
        offerExpiresAt: { $gt: currentTime },
        $or: [{ "flow.currentOffer.pauseAttempt": true }, { "flow.attemptExpiresAt": { $gt: currentTime } }],
      }).session(session).lean();
      if (!booking) return;
      const offer = await BookingOffer.findOneAndUpdate({
        _id: offerId, booking: booking._id, business: businessId, status: "pending",
        expiresAt: { $eq: booking.offerExpiresAt, $gt: currentTime },
      }, {
        $set: { status: "accepted", respondedAt: currentTime },
      }, { new: true, session, runValidators: true }).lean();
      if (!offer) return;
      const paymentDeadline = new Date(currentTime.getTime() + settings.paymentSec * 1000);
      const updated = await transitionBooking({
        bookingId: booking._id,
        from: "requested",
        to: "accepted_awaiting_payment",
        actor: "business",
        guard: {
          business: businessId,
          offerExpiresAt: { $eq: booking.offerExpiresAt, $gt: currentTime },
          "flow.currentOffer.offerId": offerId,
        },
        set: {
          offerExpiresAt: null,
          awaitingPaymentDeadline: paymentDeadline,
          authorization: {
            offerId: offer._id,
            initialPaymentMethodId: booking.stripePaymentMethodId,
            paymentMethodId: booking.stripePaymentMethodId,
            confirmKey: `booking-auth-${offer._id}`,
            confirmMode: "off_session",
            needsFix: false,
            cleanupPending: false,
          },
          "flow.currentOffer.offerId": null,
          "flow.currentOffer.sentAt": null,
          "flow.currentOffer.expiresAt": null,
          "flow.currentOffer.pauseAttempt": false,
        },
        session,
        now: currentTime,
      });
      if (!updated) throw new Error("Booking changed while accepting offer");
      const responseSeconds = Math.max(0, Math.round((currentTime - offer.sentAt) / 1000));
      const profile = await BusinessProfile.findOneAndUpdate(
        { _id: businessId },
        { $inc: { "matchStats.offersAccepted": 1, "matchStats.responseCount": 1,
          "matchStats.responseSecTotal": responseSeconds }, $set: { "matchStats.consecutiveTimeouts": 0 } },
        { new: true, session, projection: "user" },
      ).lean();
      if (!profile?.user) throw new Error("Offer provider not found");
      outcome = { booking: updated, offer, providerUserId: profile.user, paymentDeadline };
    });
  } finally {
    await session.endSession();
  }
  if (!outcome) return { error: "booking_offer_unavailable", status: 409 };
  for (const userId of [outcome.providerUserId, outcome.booking.user]) {
    try {
      emitOfferClosed({ userId, bookingId: outcome.booking._id, offerId, expiresAt: outcome.offer.expiresAt,
        status: "accepted", paymentStatus: outcome.booking.paymentStatus });
    } catch (error) {
      console.error(`Accepted offer signal failed for booking ${outcome.booking._id}:`, error);
    }
  }
  return { data: { bookingId: outcome.booking._id, offerId, status: "accepted_awaiting_payment",
    awaitingPaymentDeadline: outcome.paymentDeadline } };
};

module.exports = { acceptBookingOffer };
