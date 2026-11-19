const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { clientCancellationCaptureCents } = require("@utils/bookingPolicy");
const { quoteCancellationPenalty } = require("./penaltyService");

const PRE_ACCEPTANCE_STATUSES = ["requested", "awaiting_customer_decision"];
const ACCEPTED_STATUSES = ["accepted_awaiting_payment", "confirmed", "ongoing"];
const unavailable = () => ({ error: "booking_cannot_cancel", status: 409 });

const getCancellationQuote = async ({ bookingId, userId, businessId, userType, now = new Date() }) => {
  if (!["user", "business"].includes(userType) ||
      (userType === "business" && !businessId) || (userType === "user" && !userId)) {
    return { error: "booking_not_found", status: 404 };
  }
  const owner = userType === "business" ? { business: businessId } : { user: userId };
  const booking = await Booking.findOne({ _id: bookingId, mode: "instant", ...owner }).lean();
  if (!booking) return { error: "booking_not_found", status: 404 };

  const provider = userType === "business" || booking.status === "requested" ||
    ACCEPTED_STATUSES.includes(booking.status)
    ? await BusinessProfile.findById(booking.business, "user matchStats.cancellationCount").lean()
    : null;
  if ((userType === "business" || booking.status === "requested") && !provider?.user) return unavailable();

  if (PRE_ACCEPTANCE_STATUSES.includes(booking.status)) {
    if (booking.status === "awaiting_customer_decision" && userType === "business") return unavailable();
    if (booking.paymentStatus !== "pending" || booking.payment != null || booking.pricing?.heldCents !== 0) {
      return unavailable();
    }
    if (booking.status === "requested") {
      const offerId = booking.flow?.currentOffer?.offerId;
      if (!offerId) return unavailable();
      const offer = await BookingOffer.exists({
        _id: offerId, booking: booking._id, business: booking.business, status: "pending",
      });
      if (!offer) return unavailable();
    }
    return {
      data: {
        bookingId: booking._id,
        bookingStatus: booking.status,
        canceledBy: userType,
        currency: "usd",
        penaltyCents: 0,
        chargeCents: 0,
        depositCents: 0,
        refundableDepositCents: 0,
        warningIssued: false,
        rankingReductionApplied: false,
        authorizationRelease: "not_applicable",
      },
    };
  }

  if (!ACCEPTED_STATUSES.includes(booking.status) || !booking.authorization?.offerId) return unavailable();
  if (["confirmed", "ongoing"].includes(booking.status) &&
      (booking.paymentStatus !== "authorized" || !booking.payment || !booking.authorization.intentId ||
       !Number.isSafeInteger(booking.pricing?.heldCents) || booking.pricing.heldCents < booking.pricing.depositCents)) {
    return unavailable();
  }

  if (userType === "business") {
    const penalty = await quoteCancellationPenalty({
      providerId: booking.business,
      cancellationCount: provider?.matchStats?.cancellationCount || 0,
    });
    return {
      data: {
        bookingId: booking._id,
        bookingStatus: booking.status,
        canceledBy: userType,
        currency: "usd",
        penaltyCents: penalty.deductionCents,
        chargeCents: 0,
        depositCents: 0,
        refundableDepositCents: 0,
        providerCancellationNumber: penalty.cancellationNumber,
        warningIssued: penalty.warningIssued,
        rankingReductionApplied: penalty.rankingReductionApplied,
        suspensionHours: penalty.suspensionHours,
        authorizationRelease: "if_present",
      },
    };
  }

  let policyChargeCents;
  try {
    policyChargeCents = clientCancellationCaptureCents(booking, now);
  } catch (error) {
    if (error instanceof TypeError) return unavailable();
    throw error;
  }
  const hasAuthorizedHold = booking.paymentStatus === "authorized" && booking.payment &&
    booking.authorization.intentId && Number.isSafeInteger(booking.pricing?.heldCents) &&
    booking.pricing.heldCents >= booking.pricing.depositCents;
  const chargeCents = hasAuthorizedHold ? policyChargeCents : 0;
  return {
    data: {
      bookingId: booking._id,
      bookingStatus: booking.status,
      canceledBy: userType,
      currency: "usd",
      penaltyCents: chargeCents,
      chargeCents,
      depositCents: booking.pricing.depositCents,
      refundableDepositCents: booking.pricing.depositCents - policyChargeCents,
      warningIssued: false,
      rankingReductionApplied: false,
      authorizationRelease: "if_present",
    },
  };
};

module.exports = { getCancellationQuote };
