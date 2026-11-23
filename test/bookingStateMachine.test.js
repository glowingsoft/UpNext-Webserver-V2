require("module-alias/register");

const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const { transitionBooking } = require("../backend/app/services/bookingStateMachine");

test("transition atomically guards status and appends history", async () => {
  const original = Booking.findOneAndUpdate;
  const now = new Date("2026-11-11T00:00:00Z");
  const session = {};
  const expected = { status: "accepted_awaiting_payment" };
  let call;
  Booking.findOneAndUpdate = async (...args) => {
    call = args;
    return expected;
  };

  try {
    const result = await transitionBooking({
      bookingId: "booking",
      from: "requested",
      to: "accepted_awaiting_payment",
      actor: "business",
      guard: { offerExpiresAt: { $gt: now } },
      set: { awaitingPaymentDeadline: new Date(now.getTime() + 300000) },
      session,
      now,
    });
    assert.equal(result, expected);
    assert.deepEqual(call[0], {
      $and: [{ _id: "booking", status: "requested" }, { offerExpiresAt: { $gt: now } }],
    });
    assert.equal(call[1].$set.status, "accepted_awaiting_payment");
    assert.deepEqual(call[1].$push.statusHistory, { status: "accepted_awaiting_payment", at: now, by: "business" });
    assert.equal(call[2].session, session);
    assert.equal(call[2].runValidators, true);
  } finally {
    Booking.findOneAndUpdate = original;
  }
});

test("a lost compare-and-swap returns null", async () => {
  const original = Booking.findOneAndUpdate;
  Booking.findOneAndUpdate = async () => null;
  try {
    assert.equal(
      await transitionBooking({ bookingId: "booking", from: "requested", to: "awaiting_customer_decision" }),
      null,
    );
  } finally {
    Booking.findOneAndUpdate = original;
  }
});

test("cancellation records its reason and rejects invalid transitions", async () => {
  const original = Booking.findOneAndUpdate;
  let update;
  Booking.findOneAndUpdate = async (_, value) => {
    update = value;
    return {};
  };
  try {
    await transitionBooking({
      bookingId: "booking",
      from: "accepted_awaiting_payment",
      to: "canceled",
      reason: "payment_timeout",
    });
    assert.equal(update.$set.cancelReason, "payment_timeout");
    await assert.rejects(transitionBooking({ bookingId: "booking", from: "completed", to: "confirmed" }), TypeError);
    await assert.rejects(transitionBooking({ bookingId: "booking", from: "requested", to: "canceled" }), TypeError);
    await assert.rejects(
      transitionBooking({ bookingId: "booking", from: "requested", to: "canceled", reason: "unknown" }),
      TypeError,
    );
    await assert.rejects(
      transitionBooking({
        bookingId: "booking",
        from: "requested",
        to: "awaiting_customer_decision",
        set: { status: "confirmed" },
      }),
      TypeError,
    );
  } finally {
    Booking.findOneAndUpdate = original;
  }
});
