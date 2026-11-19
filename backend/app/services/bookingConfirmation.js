const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { transitionBooking } = require("./bookingStateMachine");

const confirmAuthorizedBooking = async ({ bookingId, paymentId, now }) => {
  if (!bookingId || !paymentId) throw new TypeError("bookingId and paymentId are required");
  if (now !== undefined && (!(now instanceof Date) || !Number.isFinite(now.getTime()))) {
    throw new TypeError("now must be a valid Date");
  }
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = { status: "unavailable" };
      const currentTime = now || new Date();
      const booking = await Booking.findOne({
        _id: bookingId,
        status: "accepted_awaiting_payment",
        payment: paymentId,
        paymentStatus: "authorized",
        awaitingPaymentDeadline: { $gt: currentTime },
      }).session(session).lean();
      if (!booking) return;
      const model = booking.scope === "service" ? Services : booking.scope === "package" ? Packages : null;
      const targetId = booking.target?.[0]?._id;
      if (!model || !targetId || !booking.date || !booking.slot?.open || !booking.slot?.close) {
        throw new Error("Booking is missing capacity information");
      }
      if (!Number.isSafeInteger(booking.pricing?.totalCents) || booking.pricing.totalCents <= 0 ||
          booking.pricing.heldCents !== booking.pricing.totalCents) {
        throw new Error("Booking does not have a full authorization");
      }

      // All confirmations for a listing write the same document. MongoDB
      // retries conflicting transactions before they can both claim a seat.
      const listing = await model.findOneAndUpdate(
        { _id: targetId, business: booking.business, status: "active", isAvailable: true },
        { $inc: { bookingCapacityVersion: 1 } },
        { new: true, session, projection: "concurrentClients" },
      ).lean();
      if (!listing) {
        outcome = { status: "slot_taken" };
        return;
      }
      if (!Number.isSafeInteger(listing.concurrentClients) || listing.concurrentClients < 1) {
        throw new Error("Invalid listing capacity");
      }
      const occupied = await Booking.countDocuments({
        scope: booking.scope,
        "target._id": targetId,
        date: booking.date,
        "slot.open": booking.slot.open,
        "slot.close": booking.slot.close,
        status: { $in: ["confirmed", "ongoing"] },
      }).session(session);
      if (occupied >= listing.concurrentClients) {
        outcome = { status: "slot_taken" };
        return;
      }
      const updated = await transitionBooking({
        bookingId,
        from: "accepted_awaiting_payment",
        to: "confirmed",
        guard: {
          payment: paymentId,
          paymentStatus: "authorized",
          "pricing.heldCents": booking.pricing.totalCents,
          "pricing.totalCents": booking.pricing.totalCents,
          awaitingPaymentDeadline: { $gt: currentTime },
          scope: booking.scope,
          business: booking.business,
          "target.0._id": targetId,
          date: booking.date,
          "slot.open": booking.slot.open,
          "slot.close": booking.slot.close,
        },
        set: { awaitingPaymentDeadline: null },
        session,
        now: currentTime,
      });
      if (!updated) throw new Error("Booking changed while confirming its seat");
      outcome = { status: "confirmed", booking: updated };
    });
  } finally {
    await session.endSession();
  }
  return outcome;
};

module.exports = { confirmAuthorizedBooking };
