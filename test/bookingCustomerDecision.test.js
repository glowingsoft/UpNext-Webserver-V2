require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");

const responsePath = require.resolve("../backend/app/services/bookingOfferResponse");
let closeCalls;
let closeResult;
require.cache[responsePath] = {
  id: responsePath, filename: responsePath, loaded: true,
  exports: { closeOffer: async (args) => { closeCalls.push(args); return closeResult(); } },
};
const { findCustomerDecisionBooking } = require("../backend/app/services/bookingCustomerDecision");
const original = { findOne: Booking.findOne, exists: Booking.exists };
const now = new Date();
const args = { bookingId: "booking", userId: "customer", now };
const decision = { status: "awaiting_customer_decision", flow: { attemptExpiresAt: new Date(now.getTime() + 600000) } };
let lookups, expiredOffer, calls;

const setup = (results) => {
  lookups = [...results]; expiredOffer = false; closeCalls = []; calls = [];
  closeResult = async () => ({ data: {} });
  Booking.findOne = (filter) => {
    calls.push(filter);
    return { lean: async () => lookups.shift() || null };
  };
  Booking.exists = async (filter) => { calls.push(filter); return expiredOffer; };
};

test("closes an expired offer on demand and returns the open decision", async () => {
  setup([null, decision]);
  expiredOffer = true;
  assert.equal(await findCustomerDecisionBooking(args), decision);
  assert.deepEqual(closeCalls, [{ ...args, expired: true }]);
  assert.equal(calls[1].user, "customer");
  assert.deepEqual(calls[1].offerExpiresAt, { $type: "date", $lte: now });
  assert.equal(calls[2]["flow.attemptExpiresAt"].$gt, now);
});

test("rechecks if the expiry worker won the race", async () => {
  setup([null, decision]);
  assert.equal(await findCustomerDecisionBooking(args), decision);
  assert.equal(closeCalls.length, 0);
});

test("does not close a live or non-owned offer and propagates expiry failures", async () => {
  setup([null, null]);
  assert.equal(await findCustomerDecisionBooking(args), null);
  assert.equal(closeCalls.length, 0);
  setup([null]);
  expiredOffer = true;
  closeResult = async () => { throw new Error("database error"); };
  await assert.rejects(findCustomerDecisionBooking(args), /database error/);
});

test.after(() => { Booking.findOne = original.findOne; Booking.exists = original.exists; });
