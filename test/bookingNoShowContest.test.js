require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const pricing = require("@utils/instantPricing");
const original = { update: Booking.findOneAndUpdate, settings: pricing.getInstantSettings };
pricing.getInstantSettings = async () => ({ noShowContestWindowHours: 24 });
const { contestNoShow } = require("../backend/app/services/bookingNoShowContest");
const now = new Date("2026-11-17T12:00:00Z");
let calls, found;
const setup = () => {
  calls = null; found = true;
  Booking.findOneAndUpdate = (filter, update, options) => {
    calls = { filter, update, options };
    return { lean: async () => found ? {
      _id: "booking", noShow: { status: "contested", contestedAt: now },
      checkIns: { arrived: { at: new Date("2026-11-17T11:00:00Z") } },
    } : null };
  };
};

test("records one provider contest within the 24-hour window and includes arrival evidence", async () => {
  setup();
  const result = await contestNoShow({ bookingId: "booking", businessId: "provider", note: "I arrived", now });
  assert.equal(calls.filter.business, "provider");
  assert.equal(calls.filter["noShow.status"], "reported");
  assert.equal(calls.filter["noShow.reportedAt"].$gte.getTime(), now.getTime() - 86400000);
  assert.equal(calls.filter["noShow.reportedAt"].$lte, now);
  assert.equal(calls.update.$set["noShow.status"], "contested");
  assert.equal(result.data.arrived.at.toISOString(), "2026-11-17T11:00:00.000Z");
});

test("rejects missing provider, invalid note, and expired or already contested reports", async () => {
  setup();
  assert.equal((await contestNoShow({ bookingId: "booking", now })).status, 409);
  assert.equal((await contestNoShow({ bookingId: "booking", businessId: "provider", note: {}, now })).status, 400);
  assert.equal(calls, null);
  found = false;
  assert.equal((await contestNoShow({ bookingId: "booking", businessId: "provider", now })).status, 409);
});

test.after(() => { Booking.findOneAndUpdate = original.update; pricing.getInstantSettings = original.settings; });
