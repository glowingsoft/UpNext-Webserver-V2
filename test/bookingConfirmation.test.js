require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { confirmAuthorizedBooking } = require("../backend/app/services/bookingConfirmation");

const original = {
  startSession: mongoose.startSession,
  findOne: Booking.findOne,
  transition: Booking.findOneAndUpdate,
  count: Booking.countDocuments,
  service: Services.findOneAndUpdate,
  package: Packages.findOneAndUpdate,
};
const now = new Date("2026-11-12T12:00:00Z");
const booking = {
  _id: "booking", scope: "service", business: "business", payment: "payment",
  target: [{ _id: "target" }], date: new Date("2026-11-13T00:00:00Z"),
  slot: { open: "09:00", close: "10:00" },
  pricing: { totalCents: 5700, heldCents: 5700 },
};

const setup = ({ found = true, listingFound = true, occupied = 0, capacity = 1, updated = true, scope = "service" } = {}) => {
  const calls = {};
  const session = {
    withTransaction: async (fn) => { await fn(); calls.committed = true; },
    endSession: async () => { calls.ended = true; },
  };
  mongoose.startSession = async () => session;
  Booking.findOne = (filter) => {
    calls.bookingFilter = filter;
    return { session: (value) => {
      assert.equal(value, session);
      return { lean: async () => found ? { ...booking, scope } : null };
    } };
  };
  const listingUpdate = (filter, update, options) => {
    calls.listing = { filter, update, options };
    return { lean: async () => listingFound ? { concurrentClients: capacity } : null };
  };
  Services.findOneAndUpdate = listingUpdate;
  Packages.findOneAndUpdate = listingUpdate;
  Booking.countDocuments = (filter) => {
    calls.count = filter;
    return { session: async (value) => { assert.equal(value, session); return occupied; } };
  };
  Booking.findOneAndUpdate = async (filter, update, options) => {
    calls.transition = { filter, update, options };
    return updated ? { ...booking, status: "confirmed" } : null;
  };
  return calls;
};

test("authorized booking confirms only after serializing and rechecking confirmed capacity", async () => {
  const calls = setup();
  const result = await confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now });
  assert.equal(result.status, "confirmed");
  assert.equal(calls.bookingFilter.paymentStatus, "authorized");
  assert.deepEqual(calls.bookingFilter.awaitingPaymentDeadline, { $gt: now });
  assert.deepEqual(calls.listing.update, { $inc: { bookingCapacityVersion: 1 } });
  assert.deepEqual(calls.count.status, { $in: ["confirmed", "ongoing"] });
  assert.equal(calls.count.scope, "service");
  assert.equal(calls.count["target._id"], "target");
  assert.equal(calls.transition.update.$set.status, "confirmed");
  assert.equal(calls.transition.filter.$and[1]["pricing.heldCents"], 5700);
  assert.equal(calls.transition.update.$push.statusHistory.status, "confirmed");
  assert.equal(calls.listing.options.session, calls.transition.options.session);
  assert.equal(calls.committed, true);
  assert.equal(calls.ended, true);
});

test("full slot or unavailable listing never confirms", async () => {
  for (const options of [{ occupied: 1 }, { listingFound: false }]) {
    const calls = setup(options);
    const result = await confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now });
    assert.equal(result.status, "slot_taken");
    assert.equal(calls.transition, undefined);
  }
});

test("booking with expired deadline or changed payment is not processed", async () => {
  const calls = setup({ found: false });
  const result = await confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now });
  assert.equal(result.status, "unavailable");
  assert.equal(calls.listing, undefined);
});

test("package capacity uses the same seat rule", async () => {
  const calls = setup({ scope: "package", capacity: 2, occupied: 1 });
  const result = await confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now });
  assert.equal(result.status, "confirmed");
  assert.equal(calls.count.scope, "package");
});

test("invalid capacity or lost transition aborts the transaction", async () => {
  for (const options of [{ capacity: 0 }, { updated: false }]) {
    const calls = setup(options);
    await assert.rejects(confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now }));
    assert.equal(calls.committed, undefined);
    assert.equal(calls.ended, true);
  }
});

test("a partial authorization cannot confirm a seat", async () => {
  const calls = setup();
  Booking.findOne = () => ({
    session: () => ({ lean: async () => ({ ...booking, pricing: { totalCents: 5700, heldCents: 700 } }) }),
  });
  await assert.rejects(confirmAuthorizedBooking({ bookingId: "booking", paymentId: "payment", now }), /full authorization/);
  assert.equal(calls.listing, undefined);
  assert.equal(calls.committed, undefined);
});

test.after(() => {
  mongoose.startSession = original.startSession;
  Booking.findOne = original.findOne;
  Booking.findOneAndUpdate = original.transition;
  Booking.countDocuments = original.count;
  Services.findOneAndUpdate = original.service;
  Packages.findOneAndUpdate = original.package;
});
