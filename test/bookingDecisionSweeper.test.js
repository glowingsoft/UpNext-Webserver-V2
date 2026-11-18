require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const { runDecisionSweeper } = require("../backend/app/services/bookingDecisionSweeper");

const now = new Date("2026-11-11T12:15:00Z");
const at = (seconds) => new Date(now.getTime() + seconds * 1000);

test("sweeper cancels only expired attempts and guards against concurrent changes", async () => {
  const originalFind = Booking.find;
  const originalUpdate = Booking.findOneAndUpdate;
  const rows = [
    { _id: "attempt", awaitingDecisionDeadline: at(-200), flow: { attemptExpiresAt: at(-10) } },
    { _id: "tie", awaitingDecisionDeadline: at(-10), flow: { attemptExpiresAt: at(-10) } },
  ];
  const calls = [];
  let query;
  Booking.find = (filter) => {
    query = filter;
    return { sort: () => ({ limit: () => ({ lean: async () => rows }) }) };
  };
  Booking.findOneAndUpdate = async (...args) => { calls.push(args); return null; };
  try {
    await runDecisionSweeper(now);
    assert.equal(query.status, "awaiting_customer_decision");
    assert.deepEqual(query["flow.attemptExpiresAt"], { $type: "date", $lte: now });
    assert.equal(query.awaitingDecisionDeadline, undefined);
    assert.deepEqual(calls.map((args) => args[1].$set.cancelReason), ["no_match", "no_match"]);
    assert.deepEqual(calls[0][0].$and[0], { _id: "attempt", status: "awaiting_customer_decision" });
    assert.deepEqual(calls[0][0].$and[1], { "flow.attemptExpiresAt": { $eq: at(-10), $lte: now } });
    assert.equal(calls[0][1].$push.statusHistory.status, "canceled");
  } finally {
    Booking.find = originalFind;
    Booking.findOneAndUpdate = originalUpdate;
  }
});

test("one failed booking does not prevent other expired decisions from being handled", async () => {
  const originalFind = Booking.find;
  const originalUpdate = Booking.findOneAndUpdate;
  const originalError = console.error;
  let errors = 0;
  let updates = 0;
  Booking.find = () => ({
    sort: () => ({
      limit: () => ({
        lean: async () => [
          { _id: "first", awaitingDecisionDeadline: at(-2), flow: { attemptExpiresAt: at(1) } },
          { _id: "second", awaitingDecisionDeadline: at(-2), flow: { attemptExpiresAt: at(1) } },
        ],
      }),
    }),
  });
  Booking.findOneAndUpdate = async () => {
    updates++;
    if (updates === 1) throw new Error("database error");
    return null;
  };
  console.error = () => { errors++; };
  try {
    await runDecisionSweeper(now);
    assert.equal(updates, 2);
    assert.equal(errors, 1);
  } finally {
    Booking.find = originalFind;
    Booking.findOneAndUpdate = originalUpdate;
    console.error = originalError;
  }
});
