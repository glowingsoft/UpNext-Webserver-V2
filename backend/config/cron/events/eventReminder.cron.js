/* const { Events } = require("@EventsModel");
const { TicketingBookings } = require("@TicketingBookingsModel");
const EventNotificationLogs = require("@EventNotificationLogsModel");
const { sendEventNotification } = require("../../../controllers/notificationHelper/eventNotificationService");

const MINUTE_MS = 60 * 1000;

const runEventReminderCron = async () => {
    const now = new Date();

    const windowStart = new Date(now.getTime() - MINUTE_MS);
    const windowEnd = new Date(now.getTime() + MINUTE_MS);

    try {
        await processReminder("24H", 24 * 60 * 60 * 1000, windowStart, windowEnd);
        await processReminder("2H", 2 * 60 * 60 * 1000, windowStart, windowEnd);
        await processReminder("STARTED", 0, windowStart, windowEnd);
    } catch (err) {
        console.error("Event reminder cron failed:", err);
    }
};

const processReminder = async (type, offsetMs, windowStart, windowEnd) => {
    const targetStartLower = new Date(windowStart.getTime() + offsetMs);
    const targetStartUpper = new Date(windowEnd.getTime() + offsetMs);

    const events = await Events.find({
        status: "active",
        "schedule.startDateTime": {
            $gte: targetStartLower,
            $lte: targetStartUpper,
        },
    })
        .select("_id schedule.startDateTime")
        .lean();

    for (const event of events) {

        try {
            // idempotency guard
            await EventNotificationLogs.create({
                eventId: event._id,
                type,
            });
        } catch (err) {
            // duplicate key → already sent
            continue;
        }

        // Fetch valid ticket holders
        const userIds = await TicketingBookings.find({
            "ticket.snapshot.event": event._id,
            status: "valid",
        }).distinct("user");

        if (!userIds.length) continue;

        let action;
        let context = {};

        if (type === "24H") {
            action = "EVENT_STARTING_24H";
        }

        if (type === "2H") {
            action = "EVENT_STARTING_2H";
        }

        if (type === "STARTED") {
            action = "EVENT_STARTED";
        }

        sendEventNotification({
            eventId: event._id,
            action,
            userIds,
            context,
        }).catch(err =>
            console.error("Reminder notification failed:", err)
        );
    }
};

module.exports = { runEventReminderCron };
 */