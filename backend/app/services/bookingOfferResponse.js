const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { getInstantSettings } = require("@utils/instantPricing");
const { transitionBooking } = require("./bookingStateMachine");
const { emitOfferClosed } = require("@socketIo/instantOfferSocketEmitter");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

const unavailable = () => ({ error: "booking_offer_unavailable", status: 409 });

const closeOffer = async ({ bookingId, offerId, businessId, userId, expired = false, now }) => {
  if ((!bookingId && !offerId) || (!expired && !businessId)) return unavailable();
  const settings = await getInstantSettings();
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const transitionTime = now || new Date();
      const filter = {
        ...(bookingId && { _id: bookingId }),
        status: "requested",
        "flow.currentOffer.offerId": offerId || { $exists: true, $ne: null },
        "flow.attemptExpiresAt": { $type: "date" },
        offerExpiresAt: expired ? { $lte: transitionTime } : { $gt: transitionTime },
        $or: expired
          ? [{ "flow.currentOffer.pauseAttempt": true }, { $expr: { $lte: ["$offerExpiresAt", "$flow.attemptExpiresAt"] } }]
          : [{ "flow.currentOffer.pauseAttempt": true }, { "flow.attemptExpiresAt": { $gt: transitionTime } }],
      };
      if (businessId) filter.business = businessId;
      if (userId) filter.user = userId;
      const booking = await Booking.findOne(filter).session(session).lean();
      if (!booking) return;

      const offer = await BookingOffer.findOneAndUpdate(
        {
          _id: booking.flow.currentOffer.offerId,
          booking: booking._id,
          business: booking.business,
          status: "pending",
          expiresAt: { $eq: booking.offerExpiresAt, ...(expired ? { $lte: transitionTime } : { $gt: transitionTime }) },
        },
        { $set: { status: expired ? "expired" : "declined", respondedAt: expired ? booking.offerExpiresAt : transitionTime } },
        { new: true, session, runValidators: true },
      ).lean();
      if (!offer) return;

      const decisionStartedAt = expired ? offer.expiresAt : transitionTime;
      const previousOffers = await BookingOffer.find({ booking: booking._id }, "business").session(session).lean();
      const providerCount = new Set(previousOffers.map((row) => String(row.business))).size;
      const sendsToProvider = previousOffers.filter((row) => String(row.business) === String(offer.business)).length;
      const noMatch = providerCount >= settings.maxProviders && sendsToProvider >= 2;
      let attemptExpiresAt = new Date(booking.flow.attemptExpiresAt);
      if (booking.flow.currentOffer.pauseAttempt) {
        const sentAt = new Date(offer.sentAt);
        if (!Number.isFinite(sentAt.getTime()) || sentAt > decisionStartedAt) {
          throw new Error("Offer has an invalid attempt pause interval");
        }
        attemptExpiresAt = new Date(attemptExpiresAt.getTime() + decisionStartedAt.getTime() - sentAt.getTime());
      }
      const decisionDeadline = noMatch ? null : attemptExpiresAt;
      const updated = await transitionBooking({
        bookingId: booking._id,
        from: "requested",
        to: noMatch ? "canceled" : "awaiting_customer_decision",
        ...(noMatch && { reason: "no_match" }),
        actor: expired ? "system" : "business",
        note: expired ? "offer_expired" : "offer_declined",
        guard: {
          business: booking.business,
          offerExpiresAt: booking.offerExpiresAt,
          "flow.currentOffer.offerId": offer._id,
        },
        set: {
          offerExpiresAt: null,
          awaitingDecisionDeadline: decisionDeadline,
          "flow.attemptExpiresAt": attemptExpiresAt,
          "flow.currentOffer.offerId": null,
          "flow.currentOffer.expiresAt": null,
          "flow.currentOffer.sentAt": null,
          "flow.currentOffer.pauseAttempt": false,
        },
        session,
        now: decisionStartedAt,
      });
      if (!updated) throw new Error("Booking changed while closing its offer");

      const responseSeconds = Math.max(0, Math.round((decisionStartedAt - offer.sentAt) / 1000));
      const profile = await BusinessProfile.findOneAndUpdate(
        { _id: offer.business },
        expired
          ? [
              { $set: {
                "matchStats.offersExpired": { $add: [{ $ifNull: ["$matchStats.offersExpired", 0] }, 1] },
                "matchStats.consecutiveTimeouts": { $add: [{ $ifNull: ["$matchStats.consecutiveTimeouts", 0] }, 1] },
              } },
              { $set: { isAvailable: { $cond: [
                { $gte: ["$matchStats.consecutiveTimeouts", settings.timeoutStreakLimit] }, false, "$isAvailable",
              ] } } },
            ]
          : {
              $inc: {
                "matchStats.offersDeclined": 1,
                "matchStats.responseCount": 1,
                "matchStats.responseSecTotal": responseSeconds,
              },
              $set: { "matchStats.consecutiveTimeouts": 0 },
            },
        { new: true, session, projection: "user isAvailable matchStats.consecutiveTimeouts" },
      ).lean();
      if (!profile) throw new Error("Offer provider no longer exists");
      outcome = { booking: updated, offer, profile, decisionDeadline, attemptExpiresAt, noMatch };
    });
  } finally {
    await session.endSession();
  }
  if (!outcome) return unavailable();

  const { booking, offer, profile, decisionDeadline, attemptExpiresAt, noMatch } = outcome;
  try {
    const status = expired ? "expired" : "declined";
    emitOfferClosed({ userId: profile.user, bookingId: booking._id, offerId: offer._id, expiresAt: offer.expiresAt,
      status, paymentStatus: booking.paymentStatus });
    emitOfferClosed({
      userId: booking.user,
      bookingId: booking._id,
      offerId: offer._id,
      status,
      paymentStatus: booking.paymentStatus,
      expiresAt: noMatch ? null : new Date(Math.min(decisionDeadline.getTime(), attemptExpiresAt.getTime())),
    });
  } catch (error) {
    console.error(`Offer-closed signal failed for booking ${booking._id}:`, error);
  }
  sendUserNotifications({
    recipientIds: [booking.user],
    title: noMatch ? "No provider matched" : "Provider unavailable",
    body: noMatch ? "Your booking attempt ended. You have not been charged." : "Review another provider or send the request again.",
    data: {
      type: "booking_offer_closed",
      objectType: "booking",
      status: expired ? "expired" : "declined",
      bookingId: String(booking._id),
      offerId: String(offer._id),
      expiresAt: noMatch ? "" : String(Math.min(decisionDeadline.getTime(), attemptExpiresAt.getTime())),
      serverNow: String(Date.now()),
    },
    objectId: booking._id,
    notificationType: noMatch ? NotificationTypes.BOOKING_CANCELED : NotificationTypes.BOOKING_REJECTED,
  });
  if (expired && profile.matchStats.consecutiveTimeouts === settings.timeoutStreakLimit) {
    sendUserNotifications({
      recipientIds: [profile.user],
      title: "Availability turned off",
      body: "Your availability was turned off after repeated missed booking requests.",
      data: { type: "booking_offer_timeout", objectType: "booking", bookingId: String(booking._id),
        offerId: String(offer._id), expiresAt: String(offer.expiresAt.getTime()), serverNow: String(Date.now()) },
      objectId: booking._id,
      notificationType: NotificationTypes.SYSTEM,
    });
  }
  return { data: { bookingId: booking._id, offerId: offer._id, status: booking.status } };
};

const runBookingOfferExpiry = async (now = new Date()) => {
  const rows = await Booking.find({
    status: "requested",
    offerExpiresAt: { $type: "date", $lte: now },
    "flow.currentOffer.offerId": { $exists: true, $ne: null },
    "flow.attemptExpiresAt": { $type: "date" },
    $or: [
      { "flow.currentOffer.pauseAttempt": true },
      { $expr: { $lte: ["$offerExpiresAt", "$flow.attemptExpiresAt"] } },
    ],
  }, "_id").sort({ offerExpiresAt: 1 }).limit(50).lean();
  for (const row of rows) {
    try {
      await closeOffer({ bookingId: row._id, expired: true, now });
    } catch (error) {
      console.error(`Offer timeout failed for booking ${row._id}:`, error);
    }
  }
};

module.exports = { closeOffer, runBookingOfferExpiry };
