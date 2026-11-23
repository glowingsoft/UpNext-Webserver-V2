const Booking = require("@models/Bookings");
const BookingDraft = require("@models/BookingDraft");
const { User } = require("@models/UserModel");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const { authorizeVaultedPayment } = require("./paymentService");
const { cancelStripePayment } = require("@services/stripePayment");
const { closeConversationIfNoActiveBookings } = require("../../commonModules/chatModule/services/conversationGateService");
const {
  releaseBookingPayment,
  routeBookingAfterPaymentSecured,
  resolveEntity,
  slotStartDate,
} = require("./bookingService");

const HORIZON_MS = 96 * 60 * 60 * 1000; // 4 days
const PAYMENT_FIX_GRACE_MS = 24 * 60 * 60 * 1000;
const PRE_START_REMINDER_MS = 30 * 60 * 1000;
const CHECKOUT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Charge (authorize, manual capture) one vaulted booking. Shared by the
 * horizon cron (offSession: true, default — nobody's present) and the
 * fix-payment "retry same card" path (offSession: false — customer is
 * actively in the app, so a required 3DS challenge can be completed instead
 * of hard-failing).
 */
const chargeVaultedBooking = async (booking, { offSession = true } = {}) => {
  const user = await User.findById(booking.user).lean();
  if (!user) throw new Error("Booking user not found");

  const { entity } = await resolveEntity(booking.scope, booking.target[0]._id);

  const { paymentDoc, stripeStatus, clientSecret } = await authorizeVaultedPayment({
    booking,
    user,
    entityStripe: entity?.stripe,
    offSession,
  });

  booking.payment = paymentDoc._id;
  if (stripeStatus === "requires_capture") {
    booking.paymentStatus = "authorized";
    booking.paymentFixDeadline = undefined;
  }
  await booking.save();
  return { booking, stripeStatus, clientSecret };
};

/**
 * Customer vaulted a new card while in requires_payment_fix — retry the
 * authorization immediately. offSession defaults to true (webhook path —
 * async, no guaranteed active session); the synchronous fix-payment path
 * passes offSession: false since the customer is right there in the request.
 * Returns { booking, stripeStatus, clientSecret, error } — stripeStatus/
 * clientSecret are null and error is set when the retry throws (declined).
 */
const retryHorizonAuthorization = async (booking, { offSession = true } = {}) => {
  try {
    return await chargeVaultedBooking(booking, { offSession });
  } catch (err) {
    console.error(`retryHorizonAuthorization failed for ${booking.bookingId}:`, err.message);
    return { booking, stripeStatus: null, clientSecret: null, error: err.message };
  }
};

/**
 * Cron: pending-approval bookings — remind the provider as the deadline
 * approaches, expire (and release payment) once it passes.
 */
const runApprovalExpiryCron = async () => {
  const now = new Date();

  // 1) Expire overdue approvals
  const overdue = await Booking.find({
    status: "requested",
    expiresAt: { $lte: now },
    paymentStatus: { $in: ["authorized", "vaulted"] },
  });

  for (const booking of overdue) {
    booking.status = "expired";
    await releaseBookingPayment(booking);

    closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
      console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
    );

    sendUserNotifications({
      recipientIds: [booking.user],
      title: "Booking Expired",
      body: `The provider did not respond to your booking for "${booking.target[0]?.name}". You have not been charged.`,
      data: { type: "booking_expired", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
    sendUserNotifications({
      recipientIds: [booking.business],
      title: "Booking Request Expired",
      body: `The booking request for "${booking.target[0]?.name}" expired without a response.`,
      data: { type: "booking_expired", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
  }

  // 2) Remind providers about approvals expiring within 6 hours (max 2 reminders)
  const sixHoursOut = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const nearing = await Booking.find({
    status: "requested",
    expiresAt: { $gt: now, $lte: sixHoursOut },
    paymentStatus: { $in: ["authorized", "vaulted"] },
    $or: [
      { "approvalReminder.sentCount": { $lt: 2 } },
      { "approvalReminder.sentCount": { $exists: false } },
    ],
  });

  for (const booking of nearing) {
    const last = booking.approvalReminder?.lastSentAt;
    if (last && now.getTime() - new Date(last).getTime() < 3 * 60 * 60 * 1000) continue;

    sendUserNotifications({
      recipientIds: [booking.business],
      title: "Booking Request Awaiting Response",
      body: `The booking request for "${booking.target[0]?.name}" expires soon. Please accept or reject it.`,
      data: { type: "booking_approval_reminder", objectType: "booking" },
      notificationType: NotificationTypes.REMINDER,
      objectId: booking._id,
    });

    await Booking.updateOne(
      { _id: booking._id },
      { $inc: { "approvalReminder.sentCount": 1 }, $set: { "approvalReminder.lastSentAt": now } },
    );
  }

  if (overdue.length || nearing.length) {
    logger.info(`[ApprovalExpiryCron] expired=${overdue.length} reminded=${nearing.length}`);
  }
};

/**
 * Cron: 4-day horizon — vaulted bookings whose slot is now within 96h get an
 * off-session authorization hold from the stored card.
 */
const runHorizonChargeCron = async () => {
  const now = Date.now();
  const candidates = await Booking.find({
    paymentStatus: "vaulted",
    status: { $in: ["requested", "scheduled"] },
    stripePaymentMethodId: { $exists: true, $ne: null },
    date: { $lte: new Date(now + HORIZON_MS + 24 * 60 * 60 * 1000) }, // coarse date filter
  });

  let charged = 0;
  let failed = 0;
  for (const booking of candidates) {
    const slotStart = slotStartDate(booking.date, booking.slot).getTime();
    if (slotStart - now > HORIZON_MS) continue; // still outside the horizon

    try {
      await chargeVaultedBooking(booking);
      charged++;
    } catch (err) {
      // Insufficient funds / declined — enter the 24h grace period
      failed++;
      booking.paymentStatus = "requires_payment_fix";
      booking.paymentFixDeadline = new Date(now + PAYMENT_FIX_GRACE_MS);
      await booking.save();

      sendUserNotifications({
        recipientIds: [booking.user],
        title: "Action Required: Payment Failed",
        body: `We couldn't charge your card for "${booking.target[0]?.name}". Please update your payment method within 24 hours or the booking will be cancelled.`,
        data: { type: "booking_payment_fix_required", objectType: "booking" },
        notificationType: NotificationTypes.SYSTEM,
        objectId: booking._id,
      });
    }
  }

  if (charged || failed) logger.info(`[HorizonChargeCron] charged=${charged} failed=${failed}`);
};

/**
 * Cron: requires_payment_fix bookings past their 24h grace deadline are
 * cancelled, the slot freed, and the business informed.
 */
const runPaymentFixGraceCron = async () => {
  const now = new Date();
  const expired = await Booking.find({
    paymentStatus: "requires_payment_fix",
    paymentFixDeadline: { $lte: now },
    status: { $in: ["requested", "scheduled"] },
  });

  for (const booking of expired) {
    booking.status = "canceled";
    booking.cancel = { reason: "Payment could not be completed", by: "user" };
    await releaseBookingPayment(booking);

    closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
      console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
    );

    sendUserNotifications({
      recipientIds: [booking.user],
      title: "Booking Cancelled",
      body: `Your booking for "${booking.target[0]?.name}" was cancelled because the payment could not be completed.`,
      data: { type: "booking_cancelled", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
    sendUserNotifications({
      recipientIds: [booking.business],
      title: "Booking Cancelled",
      body: `The booking for "${booking.target[0]?.name}" was cancelled due to a failed customer payment.`,
      data: { type: "booking_cancelled", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_CANCELED,
      objectId: booking._id,
    });
  }

  if (expired.length) logger.info(`[PaymentFixGraceCron] cancelled=${expired.length}`);
};

/**
 * Cron: 30-min pre-session reminder + abandoned checkouts.
 * scheduled → ongoing is no longer automatic — the provider starts the
 * session manually via POST /bookings/:id/start (see startBooking).
 */
const runStatusTransitionCron = async () => {
  const now = new Date();
  const { start, end } = { start: new Date(now.getTime() - 36 * 60 * 60 * 1000), end: new Date(now.getTime() + 60 * 60 * 1000) };

  // 1) 30-minute pre-session reminder (once)
  const scheduled = await Booking.find({
    mode: "scheduled",
    status: "scheduled",
    date: { $gte: start, $lte: end },
    preStartReminderSentAt: null,
  });

  let reminded = 0;
  for (const booking of scheduled) {
    const slotStart = slotStartDate(booking.date, booking.slot);

    if (slotStart.getTime() - now.getTime() <= PRE_START_REMINDER_MS) {
      const time = booking.slot?.open ?? "";
      const name = booking.target[0]?.name ?? "your session";
      sendUserNotifications({
        recipientIds: [booking.user, booking.business],
        title: "Upcoming Session Reminder",
        body: `Reminder: the session for "${name}" starts at ${time}. See you soon!`,
        data: { type: "booking_reminder_slot", objectType: "booking" },
        notificationType: NotificationTypes.REMINDER,
        objectId: booking._id,
      });
      booking.preStartReminderSentAt = now;
      await booking.save();
      reminded++;
    }
  }

  // 2) Abandoned checkouts: payment never confirmed — no Booking was ever
  // created, so just cancel the Stripe intent (best effort) and drop the draft.
  const staleDrafts = await BookingDraft.find({
    createdAt: { $lte: new Date(now.getTime() - CHECKOUT_TIMEOUT_MS) },
  });

  for (const draft of staleDrafts) {
    if (draft.stripePaymentIntentId) {
      try {
        await cancelStripePayment(draft.stripePaymentIntentId);
      } catch (err) {
        console.error(`abandoned checkout cleanup failed for draft ${draft._id}:`, err.message);
      }
    }
    await BookingDraft.deleteOne({ _id: draft._id });
  }

  if (reminded || staleDrafts.length) {
    logger.info(`[StatusTransitionCron] reminded=${reminded} abandonedCheckouts=${staleDrafts.length}`);
  }
};

module.exports = {
  chargeVaultedBooking,
  retryHorizonAuthorization,
  runApprovalExpiryCron,
  runHorizonChargeCron,
  runPaymentFixGraceCron,
  runStatusTransitionCron,
};
