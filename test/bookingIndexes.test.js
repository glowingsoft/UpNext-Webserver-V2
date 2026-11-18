require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");

test("booking index enforces one active attempt per customer", () => {
  const [keys, options] = Booking.schema.indexes().find(([, opts]) =>
    opts.name === "one_active_booking_attempt_per_customer");
  assert.deepEqual(keys, { user: 1 });
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, {
    status: { $in: ["requested", "awaiting_customer_decision", "accepted_awaiting_payment"] },
  });
});

test("offer index permits only one pending offer per booking, not per provider", () => {
  const [keys, options] = BookingOffer.schema.indexes().find(([, opts]) =>
    opts.name === "one_pending_offer_per_booking");
  assert.deepEqual(keys, { booking: 1 });
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, { status: "pending" });
});

test("attempt deadline is indexed for the decision sweeper", () => {
  const index = Booking.schema.indexes().find(([keys]) =>
    keys.status === 1 && keys["flow.attemptExpiresAt"] === 1);
  assert.ok(index);
});
