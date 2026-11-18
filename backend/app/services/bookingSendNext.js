const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const { providerDeadline } = require("@utils/bookingDeadlines");
const { validateBookingRequest } = require("./bookingRequestValidation");
const { validateCandidateInTransaction, RequestConflict } = require("./bookingRequest");
const { transitionBooking } = require("./bookingStateMachine");
const { findCustomerDecisionBooking } = require("./bookingCustomerDecision");
const { emitOfferReceived } = require("@socketIo/instantOfferSocketEmitter");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const { profileSimilarity, firstProviderProfile } = require("./bookingProviderMatching");

const unavailable = () => ({ error: "booking_offer_unavailable", status: 409 });
const sameId = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));

const sendNextOffer = async ({ bookingId, userId, body, resend = false }) => {
  const now = new Date();
  const booking = await findCustomerDecisionBooking({
    bookingId, userId, now,
    paymentGuard: { paymentStatus: "pending", payment: null, "pricing.heldCents": 0 },
  });
  if (!booking) return unavailable();
  if (!body || typeof body !== "object" || !Number.isSafeInteger(body.expectedTotalCents)) {
    return { error: "invalid_request", status: 400 };
  }
  if (!booking.flow?.categoryId || !booking.flow?.location?.coordinates || !booking.date || !booking.target?.[0]?._id) {
    throw new Error("Booking is missing data needed to send another offer");
  }
  const request = {
    scope: resend ? booking.scope : body.scope,
    targetId: resend ? String(booking.target[0]._id) : body.targetId,
    providerId: resend ? String(booking.business) : body.providerId,
    date: new Date(booking.date).toISOString().slice(0, 10),
    slot: booking.slot,
    lng: booking.flow.location.coordinates[0],
    lat: booking.flow.location.coordinates[1],
    stripePaymentMethodId: booking.stripePaymentMethodId,
    agreedNonRefundable: body.agreedNonRefundable,
    agreementVersion: body.agreementVersion,
    promotionId: body.promotionId,
  };
  const validation = await validateBookingRequest({ userId, body: request });
  if (validation.error) return validation;
  const { entity, profile, settings, pricing, agreement, cancellationPolicySnapshot } = validation.data;
  if (pricing.totalCents !== body.expectedTotalCents) {
    return { error: "instant_price_changed", status: 409, data: { pricing } };
  }

  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const currentTime = new Date();
      const current = await Booking.findOne({
        _id: bookingId,
        user: userId,
        status: "awaiting_customer_decision",
        updatedAt: booking.updatedAt,
        "flow.attemptExpiresAt": { $gt: currentTime },
        paymentStatus: "pending",
        payment: null,
        "pricing.heldCents": 0,
      })
        .session(session)
        .lean();
      if (!current) return;
      const offers = await BookingOffer.find({ booking: bookingId }, "business status sentAt").session(session).lean();
      const tried = offers.filter((offer) => sameId(offer.business, profile._id));
      const distinctProviders = new Set(offers.map((offer) => String(offer.business)));
      if (resend) {
        if (
          tried.length !== 1 ||
          !["declined", "expired"].includes(tried[0].status) ||
          !sameId(current.business, profile._id)
        )
          throw new RequestConflict("instant_resend_unavailable");
      } else {
        if (tried.length) throw new RequestConflict("instant_provider_already_tried");
        if (distinctProviders.size >= settings.maxProviders) throw new RequestConflict("instant_provider_limit");
      }
      if (!sameId(entity.category, current.flow.categoryId) || !sameId(entity.subcategory, current.flow.subcategoryId)) {
        const original = await firstProviderProfile(offers, session);
        if (profileSimilarity(original, profile) === 0) throw new RequestConflict("instant_category_mismatch");
      }
      const schedule = await validateCandidateInTransaction({
        userId,
        body: request,
        validation,
        session,
        now: currentTime,
      });
      const offerId = new mongoose.Types.ObjectId();
      const expiresAt = providerDeadline({
        now: currentTime,
        appointmentStart: schedule.appointmentStart,
        isAvailableNow: schedule.isAvailableNow,
        settings,
      });
      const updated = await transitionBooking({
        bookingId,
        from: "awaiting_customer_decision",
        to: "requested",
        actor: "user",
        guard: {
          user: userId,
          updatedAt: current.updatedAt,
          "flow.attemptExpiresAt": { $eq: current.flow.attemptExpiresAt, $gt: currentTime },
          paymentStatus: "pending",
          payment: null,
          "pricing.heldCents": 0,
        },
        set: {
          business: profile._id,
          scope: request.scope,
          target: [{ _id: entity._id, name: entity.name, price: entity.price }],
          date: schedule.date,
          slot: schedule.slot,
          pricing,
          agreement: { ...agreement, agreedAt: currentTime },
          cancellationPolicySnapshot,
          offerExpiresAt: expiresAt,
          awaitingDecisionDeadline: null,
          "flow.appointmentStart": schedule.appointmentStart,
          "flow.isAvailableNow": schedule.isAvailableNow,
          "flow.currentOffer": { offerId, sentAt: currentTime, expiresAt, pauseAttempt: !schedule.isAvailableNow },
        },
        session,
        now: currentTime,
      });
      if (!updated) throw new Error("Booking changed while sending the next offer");
      await BookingOffer.create(
        [
          {
            _id: offerId,
            booking: bookingId,
            business: profile._id,
            serviceId: entity._id,
            servicePriceCents: pricing.servicePriceCents,
            sendCount: tried.length + 1,
            sentAt: currentTime,
            expiresAt,
          },
        ],
        { session },
      );
      outcome = { bookingId, offerId, status: "requested", expiresAt, serverNow: currentTime, pricing };
    });
  } catch (error) {
    if (error instanceof RequestConflict) return { error: error.key, status: 409 };
    throw error;
  } finally {
    await session.endSession();
  }
  if (!outcome) return unavailable();
  try {
    emitOfferReceived({ userId: profile.user, bookingId, offerId: outcome.offerId, expiresAt: outcome.expiresAt,
      paymentStatus: "pending" });
  } catch (error) {
    console.error(`Offer signal failed for booking ${bookingId}:`, error);
  }
  sendUserNotifications({
    recipientIds: [profile.user],
    title: "New booking request",
    body: "You have a new booking request.",
    data: {
      type: "booking_offer_received",
      objectType: "booking",
      status: "pending",
      bookingId: String(bookingId),
      offerId: String(outcome.offerId),
      expiresAt: String(outcome.expiresAt.getTime()),
      serverNow: String(Date.now()),
    },
    objectId: bookingId,
    notificationType: NotificationTypes.SYSTEM,
  });
  return { data: outcome };
};

module.exports = { sendNextOffer };
