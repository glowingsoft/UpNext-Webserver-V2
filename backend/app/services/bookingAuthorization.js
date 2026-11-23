const mongoose = require("mongoose");
const stripe = require("@config/stripe");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");
const Card = require("@models/Card");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const { savedCardIsValid } = require("@utils/bookingEligibility");
const { transitionBooking } = require("./bookingStateMachine");
const { confirmAuthorizedBooking } = require("./bookingConfirmation");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const { emitBookingPaymentUpdated } = require("@socketIo/instantOfferSocketEmitter");

const unavailable = () => ({ error: "booking_offer_unavailable", status: 409 });
const signalPaymentUpdate = async (booking) => {
  const emit = (userId) => {
    try {
      emitBookingPaymentUpdated({ userId, bookingId: booking._id, offerId: booking.authorization.offerId,
        bookingStatus: booking.status, paymentStatus: booking.paymentStatus });
    } catch (error) {
      console.error(`Payment status signal failed for booking ${booking._id}:`, error);
    }
  };
  emit(booking.user);
  try {
    const profile = await BusinessProfile.findById(booking.business, "user").lean();
    if (!profile?.user) throw new Error("Booking provider not found");
    emit(profile.user);
  } catch (error) {
    console.error(`Payment status provider lookup failed for booking ${booking._id}:`, error);
  }
};
const notifyPaymentFix = (booking) => sendUserNotifications({
  recipientIds: [booking.user], title: "Payment needs attention",
  body: "Your provider accepted. Update or authenticate your card to confirm the booking.",
  data: { type: "booking_payment_fix", objectType: "booking", bookingId: String(booking._id),
    offerId: String(booking.authorization.offerId), expiresAt: String(booking.awaitingPaymentDeadline.getTime()),
    serverNow: String(Date.now()) },
  objectId: booking._id, notificationType: NotificationTypes.SYSTEM,
});
const createIntent = (booking) => stripe.paymentIntents.create({
  amount: booking.pricing.totalCents,
  currency: "usd",
  capture_method: "manual",
  customer: booking.authorization.customerId,
  payment_method: booking.authorization.initialPaymentMethodId,
  automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  transfer_group: `booking_${booking._id}`,
  metadata: { bookingId: String(booking._id), offerId: String(booking.authorization.offerId) },
}, { idempotencyKey: `booking-intent-${booking.authorization.offerId}` });

const cancelIntent = async (intentId) => {
  let intent;
  try {
    intent = await stripe.paymentIntents.cancel(intentId);
  } catch (error) {
    intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status !== "canceled") throw error;
  }
  if (intent.status !== "canceled") throw new Error("Authorization was not canceled");
};

const cleanupAuthorization = async (bookingId) => {
  const booking = await Booking.findOne({
    _id: bookingId, status: "canceled", "authorization.cleanupPending": true,
  }).lean();
  if (!booking) return;
  let intentId = booking.authorization.intentId;
  if (!intentId && booking.authorization.customerId) {
    intentId = (await createIntent(booking)).id;
  }
  if (intentId) await cancelIntent(intentId);
  if (intentId) {
    await Payment.updateOne(
      { _id: booking.authorization.offerId, stripePaymentId: intentId, status: { $in: ["pending", "authorized", "released"] } },
      { $set: { status: "released" } },
    );
  }
  await Booking.updateOne(
    { _id: bookingId, status: "canceled", "authorization.offerId": booking.authorization.offerId,
      "authorization.cleanupPending": true },
    { $set: { "authorization.cleanupPending": false, paymentStatus: "released", "pricing.heldCents": 0 } },
  );
};

const cancelAwaitingPayment = async ({ booking, reason, actor = "system", userId, now = new Date() }) => {
  const canceled = await transitionBooking({
    bookingId: booking._id, from: "accepted_awaiting_payment", to: "canceled", actor, reason,
    guard: { "authorization.offerId": booking.authorization.offerId, ...(userId && { user: userId }),
      ...(reason === "payment_timeout" && { awaitingPaymentDeadline: { $lte: now } }) },
    set: { awaitingPaymentDeadline: null, "authorization.cleanupPending": true },
    now,
  });
  if (!canceled) return false;
  const profile = await BusinessProfile.findById(booking.business, "user").lean();
  const recipient = reason === "slot_taken" ? booking.user : profile?.user;
  if (recipient) {
    sendUserNotifications({
      recipientIds: [recipient],
      title: reason === "slot_taken" ? "Slot no longer available" :
        reason === "client" ? "Booking request canceled" : "Booking payment expired",
      body: reason === "slot_taken" ? "The slot is no longer available. You will not be charged." :
        reason === "client" ? "The customer canceled the booking request." :
          "The customer did not complete payment in time.",
      data: { type: "booking_payment_closed", objectType: "booking", bookingId: String(booking._id),
        offerId: String(booking.authorization.offerId), expiresAt: String(now.getTime()), serverNow: String(Date.now()) },
      objectId: booking._id, notificationType: NotificationTypes.BOOKING_CANCELED,
    });
  }
  await cleanupAuthorization(booking._id);
  return true;
};

const resolveAuthorization = async (bookingId) => {
  let booking = await Booking.findOne({ _id: bookingId, status: "accepted_awaiting_payment" }).lean();
  if (!booking) return unavailable();
  if (booking.awaitingPaymentDeadline <= new Date()) {
    await cancelAwaitingPayment({ booking, reason: "payment_timeout" });
    return unavailable();
  }
  if (!booking.authorization?.offerId || !booking.authorization.initialPaymentMethodId) {
    throw new Error("Booking authorization is missing its operation details");
  }
  if (!booking.authorization.customerId) {
    const user = await User.findById(booking.user, "stripe.customerId").lean();
    if (!user?.stripe?.customerId) {
      const updated = await Booking.findOneAndUpdate(
        { _id: bookingId, status: "accepted_awaiting_payment", "authorization.offerId": booking.authorization.offerId,
          "authorization.needsFix": false },
        { $set: { paymentStatus: "requires_payment_fix", "authorization.needsFix": true } },
        { new: true },
      ).lean();
      if (updated) {
        notifyPaymentFix(updated);
        await signalPaymentUpdate(updated);
      }
      return { data: { bookingId, status: "accepted_awaiting_payment", paymentStatus: "requires_payment_fix",
        awaitingPaymentDeadline: booking.awaitingPaymentDeadline } };
    }
    const updated = await Booking.findOneAndUpdate({
      _id: bookingId, status: "accepted_awaiting_payment",
      "authorization.offerId": booking.authorization.offerId, "authorization.customerId": null,
    }, { $set: { "authorization.customerId": user.stripe.customerId } }, { new: true }).lean();
    if (!updated) return unavailable();
    booking = updated;
  }
  let intent;
  if (!booking.authorization.intentId) {
    intent = await createIntent(booking);
    await Booking.updateOne(
      { _id: bookingId, "authorization.offerId": booking.authorization.offerId, "authorization.intentId": null },
      { $set: { "authorization.intentId": intent.id } },
    );
  } else {
    intent = await stripe.paymentIntents.retrieve(booking.authorization.intentId);
  }
  booking = await Booking.findOne({
    _id: bookingId, status: "accepted_awaiting_payment", "authorization.offerId": booking.authorization.offerId,
    "authorization.intentId": intent.id, awaitingPaymentDeadline: { $gt: new Date() },
  }).lean();
  if (!booking) return unavailable();
  if (!booking.authorization.needsFix && ["requires_confirmation", "requires_payment_method"].includes(intent.status)) {
    try {
      intent = await stripe.paymentIntents.confirm(intent.id, {
        payment_method: booking.authorization.paymentMethodId,
        off_session: booking.authorization.confirmMode === "off_session",
      }, { idempotencyKey: booking.authorization.confirmKey });
    } catch (error) {
      if (error.type !== "StripeCardError") throw error;
      intent = await stripe.paymentIntents.retrieve(intent.id);
    }
  }
  if (intent.status === "requires_capture") {
    if (intent.amount !== booking.pricing.totalCents || intent.amount_capturable !== booking.pricing.totalCents ||
        intent.currency !== "usd" || intent.customer !== booking.authorization.customerId) {
      throw new Error("Stripe authorization does not match the booking");
    }
    const paymentId = booking.authorization.offerId;
    await Payment.updateOne(
      { _id: paymentId, stripePaymentId: intent.id },
      { $setOnInsert: { user: booking.user, business: booking.business, amount: intent.amount / 100, currency: "usd",
        stripePaymentId: intent.id, status: "authorized", type: "booking_payment",
        paymentObject: { customer: intent.customer, paymentMethod: intent.payment_method, status: intent.status } } },
      { upsert: true },
    );
    const updated = await Booking.findOneAndUpdate({
      _id: bookingId, status: "accepted_awaiting_payment", "authorization.offerId": paymentId,
      "authorization.intentId": intent.id, awaitingPaymentDeadline: { $gt: new Date() },
    }, { $set: { payment: paymentId, paymentStatus: "authorized", "pricing.heldCents": intent.amount } }, { new: true }).lean();
    if (!updated) {
      const canceled = await Booking.findOne({
        _id: bookingId, status: "canceled", "authorization.offerId": paymentId,
        "authorization.intentId": intent.id, "authorization.cleanupPending": false, paymentStatus: "released",
      }).lean();
      if (canceled) {
        await Payment.updateOne(
          { _id: paymentId, stripePaymentId: intent.id, status: "authorized" },
          { $set: { status: "released" } },
        );
      }
      return unavailable();
    }
    const confirmation = await confirmAuthorizedBooking({ bookingId, paymentId });
    if (confirmation.status === "slot_taken") {
      if (!await cancelAwaitingPayment({ booking: updated, reason: "slot_taken" })) return unavailable();
      return { data: { bookingId, status: "canceled", cancelReason: "slot_taken" } };
    }
    if (confirmation.status === "confirmed") {
      await signalPaymentUpdate(confirmation.booking);
      return { data: { bookingId, status: "confirmed", paymentStatus: "authorized" } };
    }
    return unavailable();
  }
  if (["requires_action", "requires_payment_method", "requires_confirmation"].includes(intent.status)) {
    const updated = await Booking.findOneAndUpdate({
      _id: bookingId, status: "accepted_awaiting_payment", "authorization.offerId": booking.authorization.offerId,
      "authorization.confirmKey": booking.authorization.confirmKey, "authorization.needsFix": false,
    }, { $set: { paymentStatus: "requires_payment_fix", "authorization.needsFix": true } }, { new: true }).lean();
    if (updated) {
      notifyPaymentFix(updated);
      await signalPaymentUpdate(updated);
    }
    return { data: { bookingId, status: "accepted_awaiting_payment", paymentStatus: "requires_payment_fix",
      awaitingPaymentDeadline: booking.awaitingPaymentDeadline } };
  }
  throw new Error(`Unexpected Stripe authorization status: ${intent.status}`);
};

const fixBookingPayment = async ({ bookingId, userId, paymentMethodId }) => {
  const booking = await Booking.findOne({
    _id: bookingId, user: userId, status: "accepted_awaiting_payment",
    awaitingPaymentDeadline: { $gt: new Date() }, "authorization.needsFix": true,
  }).lean();
  if (!booking) return unavailable();
  if (paymentMethodId) {
    const card = await Card.findOne({ user: userId, paymentMethodId }).lean();
    if (!savedCardIsValid(card)) return { error: "booking_saved_card_required", status: 400 };
    if (booking.authorization.intentId) {
      const currentIntent = await stripe.paymentIntents.retrieve(booking.authorization.intentId);
      if (currentIntent.status === "requires_action") {
        if (paymentMethodId !== booking.authorization.paymentMethodId) {
          return { error: "instant_authentication_in_progress", status: 409 };
        }
        return { data: { bookingId, status: "accepted_awaiting_payment",
          paymentStatus: "requires_payment_fix", awaitingPaymentDeadline: booking.awaitingPaymentDeadline,
          clientSecret: currentIntent.client_secret } };
      }
    }
    const confirmKey = `booking-fix-${new mongoose.Types.ObjectId()}`;
    const updated = await Booking.findOneAndUpdate({
      _id: bookingId, user: userId, status: "accepted_awaiting_payment", "authorization.needsFix": true,
      "authorization.confirmKey": booking.authorization.confirmKey, awaitingPaymentDeadline: { $gt: new Date() },
    }, { $set: { "authorization.paymentMethodId": paymentMethodId, "authorization.confirmKey": confirmKey,
      "authorization.confirmMode": "on_session", "authorization.needsFix": false } }, { new: true }).lean();
    if (!updated) return unavailable();
  }
  const result = await resolveAuthorization(bookingId);
  if (result.data?.status === "accepted_awaiting_payment") {
    const current = await Booking.findOne({
      _id: bookingId, user: userId, status: "accepted_awaiting_payment", awaitingPaymentDeadline: { $gt: new Date() },
    }).lean();
    if (!current?.authorization?.intentId) return unavailable();
    const intent = await stripe.paymentIntents.retrieve(current.authorization.intentId);
    if (intent.status === "requires_action") result.data.clientSecret = intent.client_secret;
  }
  return result;
};

const runAuthorizationSweeper = async () => {
  const now = new Date();
  const rows = await Booking.find({
    $or: [
      { status: "accepted_awaiting_payment", awaitingPaymentDeadline: { $lte: now } },
      { status: "accepted_awaiting_payment", awaitingPaymentDeadline: { $gt: now }, "authorization.needsFix": false },
      { status: "canceled", "authorization.cleanupPending": true },
    ],
  }).limit(50).lean();
  for (const booking of rows) {
    try {
      if (booking.status === "canceled") await cleanupAuthorization(booking._id);
      else if (booking.awaitingPaymentDeadline <= new Date()) await cancelAwaitingPayment({ booking, reason: "payment_timeout" });
      else if (!["prod", "production"].includes(process.env.NODE_ENV) &&
          /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || "")) {
        await resolveAuthorization(booking._id);
      }
    } catch (error) {
      console.error(`Authorization recovery failed for booking ${booking._id}:`, error);
    }
  }
};

const cancelPaymentWindow = async ({ bookingId, userId }) => {
  const booking = await Booking.findOne({ _id: bookingId, user: userId, status: "accepted_awaiting_payment" }).lean();
  if (!booking) return { error: "booking_cannot_cancel", status: 409 };
  const canceled = await cancelAwaitingPayment({ booking, reason: "client", actor: "user", userId });
  return canceled ? { data: { bookingId, status: "canceled", cancelReason: "client" } } :
    { error: "booking_cannot_cancel", status: 409 };
};

module.exports = { resolveAuthorization, fixBookingPayment, runAuthorizationSweeper, cleanupAuthorization, cancelPaymentWindow };
