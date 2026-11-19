const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { clientCancellationCaptureCents } = require("@utils/bookingPolicy");
const { transitionBooking } = require("./bookingStateMachine");
const { cancelBeforeAcceptance } = require("./bookingPreAcceptance");
const { closeOffer } = require("./bookingOfferResponse");
const { recordPenalty } = require("./penaltyService");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

const PRE_ACCEPTANCE_STATUSES = ["requested", "awaiting_customer_decision"];
const ACCEPTED_STATUSES = ["accepted_awaiting_payment", "confirmed", "ongoing"];
const unavailable = () => ({ error: "booking_cannot_cancel", status: 409 });

const cancelAfterAcceptance = async ({ bookingId, userId, businessId, userType, reason, now }) => {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const owner = userType === "business" ? { business: businessId } : { user: userId };
      const booking = await Booking.findOne({
        _id: bookingId,
        mode: "instant",
        ...owner,
        status: { $in: ACCEPTED_STATUSES },
      }).session(session).lean();
      if (!booking) return;
      if (!booking.authorization?.offerId) {
        outcome = { error: "booking_cannot_cancel", status: 409 };
        return;
      }

      const depositCents = booking.pricing?.depositCents;
      if (!Number.isSafeInteger(depositCents) || depositCents < 0) {
        outcome = { error: "booking_cannot_cancel", status: 409 };
        return;
      }

      const hasAuthorizedHold = booking.paymentStatus === "authorized" && booking.payment &&
        booking.authorization?.intentId && Number.isSafeInteger(booking.pricing?.heldCents) &&
        booking.pricing.heldCents >= depositCents;
      if (["confirmed", "ongoing"].includes(booking.status) && !hasAuthorizedHold) {
        outcome = { error: "booking_cannot_cancel", status: 409 };
        return;
      }

      let policyChargeCents = 0;
      if (userType === "user") {
        try {
          policyChargeCents = clientCancellationCaptureCents(booking, now);
        } catch (error) {
          if (error instanceof TypeError) {
            outcome = { error: "booking_cannot_cancel", status: 409 };
            return;
          }
          throw error;
        }
      }
      const chargeCents = hasAuthorizedHold ? policyChargeCents : 0;
      const reasonCode = userType === "business" ? "provider" : "client";
      const cancellation = {
        actor: userType,
        reason: reason || null,
        canceledAt: now,
        policy: booking.cancellationPolicySnapshot?.policy,
        depositCents,
        chargeCents,
        refundableDepositCents: userType === "user" ? depositCents - policyChargeCents : 0,
      };
      const set = {
        cancellation,
        ...(chargeCents > 0
          ? {
              paymentStatus: "capture_retrying",
              "authorization.cleanupPending": false,
              "capture.kind": "cancellation",
              "capture.amountCents": chargeCents,
              "capture.status": "retrying",
              "capture.attempts": 0,
              "capture.nextAttemptAt": now,
              "capture.lastError": null,
            }
          : { "authorization.cleanupPending": true }),
      };
      const captureStatus = booking.capture?.status === undefined || booking.capture?.status === null
        ? { $in: [null, "none"] }
        : booking.capture.status;
      const updated = await transitionBooking({
        bookingId: booking._id,
        from: booking.status,
        to: "canceled",
        actor: userType,
        reason: reasonCode,
        note: reason,
        guard: {
          ...owner,
          paymentStatus: booking.paymentStatus,
          payment: booking.payment,
          "authorization.offerId": booking.authorization?.offerId,
          "capture.status": captureStatus,
        },
        set,
        session,
        now,
      });
      if (!updated) return;

      let providerUserId;
      let penalty;
      if (userType === "business") {
        const provider = await BusinessProfile.findById(booking.business, "user").session(session).lean();
        if (!provider?.user) throw new Error("Booking provider not found");
        providerUserId = provider.user;
        penalty = await recordPenalty({
          providerId: booking.business,
          bookingId: booking._id,
          type: "cancellation",
          note: reason,
          session,
          now,
        });
        if (penalty.duplicate) throw new Error("Provider cancellation penalty was already recorded");
        await Booking.updateOne(
          { _id: booking._id, status: "canceled", "cancellation.actor": "business" },
          {
            $set: {
              "cancellation.providerPenalty": penalty.penalty._id,
              "cancellation.providerCancellationNumber": penalty.cancellationNumber,
              "cancellation.warningIssued": penalty.warningOnly,
              "cancellation.rankingReductionApplied": penalty.rankingReductionApplied,
              "cancellation.suspendedUntil": penalty.suspendedUntil,
            },
          },
          { session },
        );
      }
      outcome = { booking: updated, chargeCents, cancellation, providerUserId, penalty, userType };
    });
  } finally {
    await session.endSession();
  }
  if (!outcome) return unavailable();
  if (outcome.error) return outcome;

  if (outcome.chargeCents > 0) {
    await require("./instantPaymentService").runCapture(bookingId);
  } else {
    await require("./bookingAuthorization").cleanupAuthorization(bookingId);
  }

  const recipientId = userType === "business" ? outcome.booking.user : outcome.providerUserId;
  if (recipientId) {
    sendUserNotifications({
      recipientIds: [recipientId],
      title: "Booking canceled",
      body: userType === "business"
        ? "The provider canceled the booking. You were not charged."
        : "The customer canceled the booking.",
      data: {
        type: "instant_booking_canceled",
        objectType: "booking",
        bookingId: String(bookingId),
        canceledBy: userType,
        chargeCents: String(outcome.chargeCents),
      },
      objectId: bookingId,
      notificationType: NotificationTypes.BOOKING_CANCELED,
    });
  }
  if (outcome.penalty?.penalty) {
    sendUserNotifications({
      recipientIds: [outcome.providerUserId],
      title: outcome.penalty.warningOnly ? "Cancellation warning" : "Provider cancellation penalty",
      body: outcome.penalty.warningOnly
        ? "This is your first cancellation warning. No financial penalty was applied."
        : `A $${(outcome.penalty.deductionCents / 100).toFixed(2)} penalty will be deducted from your next payout.` +
          `${outcome.penalty.rankingReductionApplied ? " Your booking ranking was reduced." : ""}` +
          `${outcome.penalty.suspendedUntil ? ` Your availability is suspended until ${outcome.penalty.suspendedUntil.toISOString()}.` : ""}`,
      data: {
        type: "provider_cancellation_penalty",
        objectType: "booking",
        bookingId: String(bookingId),
        cancellationNumber: String(outcome.penalty.cancellationNumber),
        penaltyCents: String(outcome.penalty.deductionCents),
        rankingReductionApplied: String(outcome.penalty.rankingReductionApplied),
        suspendedUntil: outcome.penalty.suspendedUntil?.toISOString() || "",
      },
      objectId: bookingId,
      notificationType: NotificationTypes.SYSTEM,
    });
  }

  const finalBooking = await Booking.findById(bookingId).lean();
  return {
    data: {
      bookingId,
      status: "canceled",
      cancelReason: userType === "business" ? "provider" : "client",
      paymentStatus: finalBooking?.paymentStatus,
      chargeCents: outcome.chargeCents,
      refundableDepositCents: outcome.cancellation.refundableDepositCents,
      providerPenaltyCents: outcome.penalty?.deductionCents || 0,
      providerCancellationNumber: outcome.penalty?.cancellationNumber,
      warningIssued: outcome.penalty?.warningOnly || false,
      rankingReductionApplied: outcome.penalty?.rankingReductionApplied || false,
      suspendedUntil: outcome.penalty?.suspendedUntil || null,
    },
  };
};

const cancelInstantBooking = async ({ bookingId, userId, businessId, userType, reason, now = new Date() }) => {
  if (!["user", "business"].includes(userType) ||
      (userType === "user" && !userId) || (userType === "business" && !businessId)) {
    return { error: "booking_not_found", status: 404 };
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  const owner = userType === "business" ? { business: businessId } : { user: userId };
  const booking = await Booking.findOne({ _id: bookingId, mode: "instant", ...owner }, "status").lean();
  if (!booking) return { error: "booking_not_found", status: 404 };

  if (userType === "user" && PRE_ACCEPTANCE_STATUSES.includes(booking.status)) {
    const result = await cancelBeforeAcceptance({ bookingId, userId, now });
    if (!result.error || result.error !== "booking_cannot_cancel") return result;
  }
  if (userType === "business" && booking.status === "requested") {
    const result = await closeOffer({ bookingId, businessId, now });
    if (!result.error || result.error !== "booking_offer_unavailable") return result;
  }
  const current = await Booking.findOne({ _id: bookingId, mode: "instant", ...owner }, "status").lean();
  if (!current) return { error: "booking_not_found", status: 404 };
  if (!ACCEPTED_STATUSES.includes(current.status)) return unavailable();
  return cancelAfterAcceptance({ bookingId, userId, businessId, userType, reason, now });
};

module.exports = { cancelInstantBooking, cancelAfterAcceptance };
