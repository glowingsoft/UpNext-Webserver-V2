const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { transitionBooking } = require("./bookingStateMachine");
const { emitOfferClosed } = require("@socketIo/instantOfferSocketEmitter");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

const expirePendingAttempt = async ({ bookingId, now }) => {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const booking = await Booking.findOne({
        _id: bookingId,
        status: "requested",
        "flow.currentOffer.pauseAttempt": { $ne: true },
        "flow.currentOffer.offerId": { $exists: true, $ne: null },
        "flow.attemptExpiresAt": { $type: "date", $lte: now },
        offerExpiresAt: { $type: "date" },
        $expr: { $lt: ["$flow.attemptExpiresAt", "$offerExpiresAt"] },
      }).session(session).lean();
      if (!booking) return;

      const offer = await BookingOffer.findOneAndUpdate(
        {
          _id: booking.flow.currentOffer.offerId,
          booking: booking._id,
          business: booking.business,
          status: "pending",
        },
        { $set: { status: "closed", respondedAt: booking.flow.attemptExpiresAt } },
        { new: true, session, runValidators: true },
      ).lean();
      if (!offer) throw new Error("Pending booking offer not found while expiring attempt");

      const updated = await transitionBooking({
        bookingId: booking._id,
        from: "requested",
        to: "canceled",
        reason: "no_match",
        guard: {
          business: booking.business,
          "flow.currentOffer.offerId": offer._id,
          "flow.currentOffer.pauseAttempt": { $ne: true },
          "flow.attemptExpiresAt": booking.flow.attemptExpiresAt,
          offerExpiresAt: booking.offerExpiresAt,
        },
        set: {
          offerExpiresAt: null,
          "flow.currentOffer.offerId": null,
          "flow.currentOffer.expiresAt": null,
          "flow.currentOffer.sentAt": null,
        },
        session,
        now: booking.flow.attemptExpiresAt,
      });
      if (!updated) throw new Error("Booking changed while expiring attempt");
      const profile = await BusinessProfile.findById(booking.business, "user").session(session).lean();
      if (!profile) throw new Error("Offer provider not found while expiring attempt");
      outcome = { booking, offer, providerUserId: profile.user, paymentStatus: updated.paymentStatus };
    });
  } finally {
    await session.endSession();
  }
  if (!outcome) return false;

  const { booking, offer, providerUserId, paymentStatus } = outcome;
  for (const userId of [providerUserId, booking.user]) {
    try {
      emitOfferClosed({ userId, bookingId: booking._id, offerId: offer._id,
        expiresAt: booking.flow.attemptExpiresAt, status: "closed", reason: "attempt_expired", paymentStatus });
    } catch (error) {
      console.error(`Attempt-expiry signal failed for booking ${booking._id}:`, error);
    }
  }
  sendUserNotifications({
    recipientIds: [booking.user],
    title: "No provider matched",
    body: "Your booking attempt ended. You have not been charged.",
    data: {
      type: "booking_attempt_expired",
      objectType: "booking",
      status: "closed",
      reason: "attempt_expired",
      bookingId: String(booking._id),
      offerId: String(offer._id),
      expiresAt: String(booking.flow.attemptExpiresAt.getTime()),
      serverNow: String(Date.now()),
    },
    objectId: booking._id,
    notificationType: NotificationTypes.BOOKING_CANCELED,
  });
  return true;
};

const runAttemptSweeper = async (now = new Date()) => {
  // Case 1: Instant bookings with pending offer (attempt expires before offer)
  const instantRows = await Booking.find({
    status: "requested",
    "flow.currentOffer.pauseAttempt": { $ne: true },
    "flow.currentOffer.offerId": { $exists: true, $ne: null },
    "flow.attemptExpiresAt": { $type: "date", $lte: now },
    offerExpiresAt: { $type: "date" },
    $expr: { $lt: ["$flow.attemptExpiresAt", "$offerExpiresAt"] },
  }, "_id").sort({ "flow.attemptExpiresAt": 1 }).limit(50).lean();
  
  for (const row of instantRows) {
    try {
      await expirePendingAttempt({ bookingId: row._id, now });
    } catch (error) {
      console.error(`Attempt expiry failed for booking ${row._id}:`, error);
    }
  }

};

module.exports = { expirePendingAttempt, runAttemptSweeper };
