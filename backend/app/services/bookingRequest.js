const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const Card = require("@models/Card");
const { User } = require("@models/UserModel");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { providerDeadline } = require("@utils/bookingDeadlines");
const { savedCardIsValid, resolveScheduledSlot } = require("@utils/bookingEligibility");
const { validateBookingRequest } = require("./bookingRequestValidation");
const { emitOfferReceived } = require("@socketIo/instantOfferSocketEmitter");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

class RequestConflict extends Error {
  constructor(key) {
    super(key);
    this.key = key;
  }
}

const validateCandidateInTransaction = async ({ userId, body, validation, session, now }) => {
  const { entity, profile, settings } = validation.data;
  const model = body.scope === "service" ? Services : Packages;
  const card = await Card.findOne({ user: userId, paymentMethodId: body.stripePaymentMethodId }).session(session).lean();
  if (!savedCardIsValid(card, now)) throw new RequestConflict("booking_saved_card_required");
  const currentEntity = await model.findOne({
    _id: entity._id, business: profile._id, status: "active", isAvailable: true,
    updatedAt: entity.updatedAt,
  }).session(session).lean();
  if (!currentEntity) throw new RequestConflict("booking_entity_not_found");
  const currentProfile = await BusinessProfile.findOneAndUpdate(
    {
      _id: profile._id, user: profile.user, status: "active", isAvailable: true,
      updatedAt: profile.updatedAt,
      $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
    },
    { $inc: { "matchStats.offersReceived": 1 }, $set: { "matchStats.lastOfferAt": now } },
    { new: true, session },
  ).lean();
  if (!currentProfile) throw new RequestConflict("instant_provider_unavailable");
  const owner = await User.findOne({
    _id: profile.user, "accountState.status": "active",
  }, "timezone").session(session).lean();
  const schedule = owner && resolveScheduledSlot({
    date: body.date, slot: body.slot, timezone: owner.timezone, slots: currentEntity.slots,
    operatingHours: currentProfile.operatingHours, now, maxAdvanceDays: settings.maxAdvanceDays,
  });
  if (!schedule || (schedule.isAvailableNow && !validation.data.schedule.isAvailableNow)) {
    throw new RequestConflict("booking_slot_invalid");
  }
  const occupied = await Booking.countDocuments({
    scope: body.scope, "target._id": currentEntity._id, date: schedule.date,
    "slot.open": schedule.slot.open, "slot.close": schedule.slot.close, status: { $in: ["confirmed", "ongoing"] },
  }).session(session);
  if (occupied >= currentEntity.concurrentClients) throw new RequestConflict("booking_slot_full");
  return schedule;
};

const createBookingRequest = async ({ userId, body }) => {
  const validation = await validateBookingRequest({ userId, body });
  if (validation.error) return validation;
  const { entity, profile, origin, settings, pricing, agreement, cancellationPolicySnapshot } = validation.data;
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const now = new Date();
      const schedule = await validateCandidateInTransaction({ userId, body, validation, session, now });

      const bookingId = new mongoose.Types.ObjectId();
      const offerId = new mongoose.Types.ObjectId();
      const attemptExpiresAt = new Date(now.getTime() + settings.maxAttemptMinutes * 60000);
      const offerExpiresAt = providerDeadline({
        now, appointmentStart: schedule.appointmentStart, isAvailableNow: schedule.isAvailableNow, settings,
      });
      
      // Offer should NEVER expire after attempt expires
      const finalOfferExpiresAt = offerExpiresAt < attemptExpiresAt ? offerExpiresAt : attemptExpiresAt;
      
      await Booking.create([{
        _id: bookingId,
        bookingId: `IB-${randomUUID()}`,
        scope: body.scope,
        target: [{ _id: entity._id, name: entity.name, price: entity.price }],
        date: schedule.date,
        slot: schedule.slot,
        user: userId,
        business: profile._id,
        status: "requested",
        paymentStatus: "pending",
        statusHistory: [{ status: "requested", at: now, by: "user" }],
        offerExpiresAt: finalOfferExpiresAt,
        flow: {
          requestedAt: now,
          appointmentStart: schedule.appointmentStart,
          isAvailableNow: schedule.isAvailableNow,
          location: { type: "Point", coordinates: origin },
          categoryId: entity.category,
          subcategoryId: entity.subcategory || null,
          preferredServiceType: entity.preferredServiceType,
          attemptStartedAt: now,
          attemptExpiresAt,
          currentOffer: { offerId, sentAt: now, expiresAt: finalOfferExpiresAt, pauseAttempt: !schedule.isAvailableNow },
        },
        pricing,
        agreement: { ...agreement, agreedAt: now },
        cancellationPolicySnapshot,
        stripePaymentMethodId: body.stripePaymentMethodId,
      }], { session });
      await BookingOffer.create([{
        _id: offerId,
        booking: bookingId,
        business: profile._id,
        serviceId: entity._id,
        servicePriceCents: pricing.servicePriceCents,
        sentAt: now,
        expiresAt: finalOfferExpiresAt,
      }], { session });
      outcome = { data: { bookingId, offerId, status: "requested", expiresAt: finalOfferExpiresAt, serverNow: now, pricing } };
    });
  } catch (error) {
    if (error instanceof RequestConflict) return { error: error.key, status: 409 };
    if (error.code === 11000 && error.keyPattern?.user === 1) {
      return { error: "instant_booking_in_progress", status: 409 };
    }
    throw error;
  } finally {
    await session.endSession();
  }
  if (outcome?.data) {
    const { bookingId, offerId, expiresAt } = outcome.data;
    try {
      emitOfferReceived({ userId: profile.user, bookingId, offerId, expiresAt, paymentStatus: "pending" });
    } catch (error) {
      console.error(`Offer signal failed for booking ${bookingId}:`, error);
    }
    sendUserNotifications({
      recipientIds: [profile.user],
      title: "New booking request",
      body: "You have a new booking request.",
      data: { type: "booking_offer_received", objectType: "booking", status: "pending", bookingId: String(bookingId),
        offerId: String(offerId), expiresAt: String(expiresAt.getTime()), serverNow: String(Date.now()) },
      objectId: bookingId,
      notificationType: NotificationTypes.SYSTEM,
    });
  }
  return outcome;
};

module.exports = { createBookingRequest, validateCandidateInTransaction, RequestConflict };
