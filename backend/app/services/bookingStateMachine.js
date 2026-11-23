const Booking = require("@models/Bookings");

const TRANSITIONS = {
  requested: ["awaiting_customer_decision", "accepted_awaiting_payment", "canceled"],
  awaiting_customer_decision: ["requested", "canceled"],
  accepted_awaiting_payment: ["confirmed", "canceled"],
  confirmed: ["ongoing", "completed", "canceled"],
  ongoing: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

const CANCEL_REASONS = new Set([
  "no_match",
  "customer_timeout",
  "payment_timeout",
  "slot_taken",
  "client",
  "provider",
  "no_show",
  "system",
]);
const ACTORS = new Set(["user", "business", "system", "admin"]);
const PROTECTED_FIELDS = new Set(["_id", "status", "statusHistory", "cancelReason"]);

const assertMutableFields = (fields) => {
  for (const key of Object.keys(fields)) {
    if (key.startsWith("$") || PROTECTED_FIELDS.has(key.split(".")[0])) {
      throw new TypeError(`Cannot update protected booking field: ${key}`);
    }
  }
};

/**
 * Transitions one booking only if its current status and caller-provided
 * guards still match. A null result means another operation won the race.
 */
const transitionBooking = async ({
  bookingId,
  from,
  to,
  actor = "system",
  reason,
  note,
  guard = {},
  set = {},
  unset = {},
  session,
  now = new Date(),
}) => {
  if (!bookingId) throw new TypeError("bookingId is required");
  if (!TRANSITIONS[from]?.includes(to)) throw new TypeError(`Invalid booking transition: ${from} -> ${to}`);
  if (!ACTORS.has(actor)) throw new TypeError(`Invalid booking transition actor: ${actor}`);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Invalid transition time");
  if (to === "canceled" ? !CANCEL_REASONS.has(reason) : reason !== undefined) {
    throw new TypeError("A valid cancellation reason is required only when canceling");
  }
  assertMutableFields(set);
  assertMutableFields(unset);

  const historyEntry = { status: to, at: now, by: actor };
  if (note) historyEntry.note = note;
  const update = {
    $set: { ...set, status: to, ...(to === "canceled" && { cancelReason: reason }) },
    $push: { statusHistory: historyEntry },
  };
  if (Object.keys(unset).length) update.$unset = unset;

  return Booking.findOneAndUpdate(
    { $and: [{ _id: bookingId, status: from }, guard] },
    update,
    { new: true, runValidators: true, ...(session && { session }) },
  );
};

module.exports = { transitionBooking };
