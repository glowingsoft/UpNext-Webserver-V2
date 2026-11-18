const Booking = require("@models/Bookings");
const { transitionBooking } = require("./bookingStateMachine");

const BATCH_SIZE = 50;

const runDecisionSweeper = async (now = new Date()) => {
  const rows = await Booking.find(
    {
      status: "awaiting_customer_decision",
      "flow.attemptExpiresAt": { $type: "date", $lte: now },
    },
    "flow.attemptExpiresAt",
  ).sort({ "flow.attemptExpiresAt": 1 }).limit(BATCH_SIZE).lean();

  for (const row of rows) {
    try {
      const attemptDeadline = row.flow.attemptExpiresAt;
      await transitionBooking({
        bookingId: row._id,
        from: "awaiting_customer_decision",
        to: "canceled",
        reason: "no_match",
        guard: { "flow.attemptExpiresAt": { $eq: attemptDeadline, $lte: now } },
        set: { awaitingDecisionDeadline: null },
        now,
      });
    } catch (error) {
      console.error(`Decision timeout failed for booking ${row._id}:`, error);
    }
  }
};

module.exports = { runDecisionSweeper };
