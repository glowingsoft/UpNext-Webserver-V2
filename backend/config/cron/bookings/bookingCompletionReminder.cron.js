const Booking = require("@models/Bookings");
const { sendUserNotifications } = require("../../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");

const sessionEndedAt = (booking) => {
  const end = new Date(booking.date);
  const [h, m] = booking.slot.close.split(":").map(Number);
  end.setHours(h, m, 0, 0);
  if (booking.slot.isOverNight && h < 12) end.setDate(end.getDate() + 1);
  return end;
};

const runBookingCompletionReminderCron = async () => {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Bookings eligible for reminder:
  // - Still scheduled
  // - Booking date is today or in the past (session may have ended)
  // - Either first reminder not sent, or second reminder due (24h after first)
  const bookings = await Booking.find({
    status: "scheduled",
    date: { $lte: now },
    $or: [
      { "completionReminder.sentCount": 0 },
      { "completionReminder.sentCount": { $exists: false } },
      {
        "completionReminder.sentCount": 1,
        "completionReminder.lastSentAt": { $lte: oneDayAgo },
      },
    ],
  }).select("target slot date business completionReminder");

  const eligible = bookings.filter((b) => sessionEndedAt(b) <= now);
  if (!eligible.length) return;

  const messages = [
    {
      title: "Session Ended — Mark as Complete",
      body: (name) => `The session for "${name}" has ended. Please mark the booking as completed.`,
    },
    {
      title: "Reminder: Booking Still Pending",
      body: (name) =>
        `Friendly reminder: the booking for "${name}" is still not marked as completed. Please update it.`,
    },
  ];

  const updates = eligible.map(async (booking) => {
    const sentCount = booking.completionReminder?.sentCount ?? 0;
    const { title, body } = messages[sentCount] ?? messages[1];
    const name = booking.target[0]?.name ?? "a session";

    sendUserNotifications({
      recipientIds: [booking.business],
      title,
      body: body(name),
      data: { type: "booking_completion_reminder", objectType: "booking" },
      notificationType: NotificationTypes.REMINDER,
      objectId: booking._id,
    });

    return Booking.updateOne(
      { _id: booking._id },
      {
        $inc: { "completionReminder.sentCount": 1 },
        $set: { "completionReminder.lastSentAt": now },
      }
    );
  });

  await Promise.all(updates);
  logger.info(`[BookingCompletionCron] Reminders sent: ${eligible.length}`);
};

module.exports = { runBookingCompletionReminderCron };
