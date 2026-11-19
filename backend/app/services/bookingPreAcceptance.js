const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { transitionBooking } = require("./bookingStateMachine");
const { emitOfferClosed } = require("@socketIo/instantOfferSocketEmitter");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

const cancelBeforeAcceptance = async ({ bookingId, userId, now = new Date() }) => {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const booking = await Booking.findOne({
        _id: bookingId,
        user: userId,
        status: { $in: ["requested", "awaiting_customer_decision"] },
        paymentStatus: "pending",
        payment: null,
        "pricing.heldCents": 0,
      }).session(session).lean();
      if (!booking) return;

      let offer = null;
      let providerUserId = null;
      if (booking.status === "requested") {
        const offerId = booking.flow?.currentOffer?.offerId;
        if (!offerId) throw new Error("Requested booking has no current offer");
        offer = await BookingOffer.findOneAndUpdate(
          { _id: offerId, booking: booking._id, business: booking.business, status: "pending" },
          { $set: { status: "closed", respondedAt: now } },
          { new: true, session, runValidators: true },
        ).lean();
        if (!offer) throw new Error("Requested booking has no matching pending offer");
        const provider = await BusinessProfile.findById(booking.business, "user").session(session).lean();
        if (!provider?.user) throw new Error("Booking provider not found");
        providerUserId = provider.user;
      }

      const updated = await transitionBooking({
        bookingId: booking._id,
        from: booking.status,
        to: "canceled",
        actor: "user",
        reason: "client",
        guard: {
          user: userId,
          paymentStatus: "pending",
          payment: null,
          "pricing.heldCents": 0,
          ...(offer && { "flow.currentOffer.offerId": offer._id }),
        },
        set: {
          offerExpiresAt: null,
          awaitingDecisionDeadline: null,
          "flow.currentOffer.offerId": null,
          "flow.currentOffer.expiresAt": null,
          "flow.currentOffer.sentAt": null,
          "flow.currentOffer.pauseAttempt": false,
        },
        session,
        now,
      });
      if (!updated) throw new Error("Booking changed while cancelling the request");
      outcome = { booking: updated, offer, providerUserId };
    });
  } finally {
    await session.endSession();
  }
  if (!outcome) return { error: "booking_cannot_cancel", status: 409 };
  if (outcome.offer) {
    const { booking, offer, providerUserId } = outcome;
    for (const recipientId of [providerUserId, userId]) {
      try {
        emitOfferClosed({ userId: recipientId, bookingId: booking._id, offerId: offer._id,
          expiresAt: offer.expiresAt, status: "closed", reason: "customer_canceled", paymentStatus: booking.paymentStatus });
      } catch (error) {
        console.error(`Cancel offer signal failed for booking ${booking._id}:`, error);
      }
    }
    sendUserNotifications({
      recipientIds: [providerUserId],
      title: "Booking request canceled",
      body: "The customer canceled the booking request.",
      data: {
        type: "booking_offer_closed",
        objectType: "booking",
        status: "closed",
        reason: "customer_canceled",
        bookingId: String(booking._id),
        offerId: String(offer._id),
        expiresAt: String(new Date(offer.expiresAt).getTime()),
        serverNow: String(Date.now()),
      },
      objectId: booking._id,
      notificationType: NotificationTypes.BOOKING_CANCELED,
    });
  }
  return { data: { bookingId: outcome.booking._id, status: "canceled", cancelReason: "client" } };
};

module.exports = { cancelBeforeAcceptance };
