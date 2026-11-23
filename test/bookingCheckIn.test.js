require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const { recordCustomerArrival, startInstantBooking } = require("../backend/app/services/bookingCheckIn");

const original = Booking.findOneAndUpdate;
const now = new Date("2026-11-12T12:00:00Z");
let calls;
const setup = (found = true) => {
  calls = null;
  Booking.findOneAndUpdate = (filter, update, options) => {
    calls = { filter, update, options };
    return { lean: async () => found ? { _id: "booking", checkIns: {
      customerArrived: update.$set["checkIns.customerArrived"],
    } } : null };
  };
};

test("customer or assigned business records customer check-in once", async () => {
  for (const actor of ["user", "business"]) {
    setup();
    const result = await recordCustomerArrival({
      bookingId: "booking", userId: "customer", businessId: "business", actor, lat: 40, lng: -74, now,
    });
    assert.deepEqual(result.data.customerArrived, { at: now, by: actor, lat: 40, lng: -74 });
    assert.equal(calls.filter[actor === "user" ? "user" : "business"], actor === "user" ? "customer" : "business");
    assert.equal(calls.filter.mode, "instant");
    assert.deepEqual(calls.filter.status, { $in: ["confirmed", "ongoing"] });
    assert.deepEqual(calls.filter["checkIns.customerArrived.at"], { $exists: false });
  }
  setup();
  const result = await recordCustomerArrival({ bookingId: "booking", userId: "customer", actor: "user", now });
  assert.deepEqual(result.data.customerArrived, { at: now, by: "user" });
});

test("customer check-in rejects invalid coordinates, identities and unsuccessful ownership guards", async () => {
  for (const coords of [{ lat: 1 }, { lat: "", lng: 1 }, { lat: 91, lng: 1 }, { lat: 1, lng: NaN }]) {
    setup();
    assert.equal((await recordCustomerArrival({ bookingId: "booking", actor: "user", userId: "customer", ...coords })).status, 400);
    assert.equal(calls, null);
  }
  setup();
  assert.equal((await recordCustomerArrival({ bookingId: "booking", actor: "business", userId: "customer" })).status, 409);
  assert.equal(calls, null);
  setup(false);
  assert.equal((await recordCustomerArrival({ bookingId: "booking", actor: "user", userId: "other" })).status, 409);
});

test("manual start atomically requires the assigned business, confirmation and customer check-in", async () => {
  Booking.findOneAndUpdate = async (filter, update, options) => {
    calls = { filter, update, options };
    return { _id: "booking", status: "ongoing" };
  };
  const result = await startInstantBooking({ bookingId: "booking", businessId: "business", now });
  assert.deepEqual(result.data, { bookingId: "booking", status: "ongoing" });
  assert.deepEqual(calls.filter.$and, [
    { _id: "booking", status: "confirmed" },
    { mode: "instant", business: "business", "checkIns.customerArrived.at": { $type: "date" } },
  ]);
  assert.equal(calls.update.$set.status, "ongoing");
  assert.equal(calls.update.$push.statusHistory.by, "business");
  Booking.findOneAndUpdate = async () => null;
  assert.equal((await startInstantBooking({ bookingId: "booking", businessId: "other", now })).status, 409);
  assert.equal((await startInstantBooking({ bookingId: "booking", now })).status, 409);
});

test.after(() => { Booking.findOneAndUpdate = original; });
