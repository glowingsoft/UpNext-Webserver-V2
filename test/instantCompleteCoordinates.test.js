require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let captures, notifications;
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: (data) => notifications.push(data) });
stub("../backend/app/services/instantOfferService", {});
stub("../backend/app/services/instantPaymentService", { beginCapture: async (...args) => captures.push(args) });
stub("../backend/app/services/bookingCompletionCapture", { runCompletionCapture: async (...args) => captures.push(args) });
const { complete } = require("../backend/app/services/instantBookingService");
const original = { update: Booking.findOneAndUpdate, find: Booking.findById, findOne: Booking.findOne };
let update, currentFilter;
const setup = () => {
  captures = []; notifications = []; update = undefined; currentFilter = undefined;
  Booking.findOne = (filter) => {
    currentFilter = filter;
    return { lean: async () => ({ payment: "payment", authorization: { intentId: "pi_test" },
      pricing: { totalCents: 5000, heldCents: 5000 } }) };
  };
  Booking.findOneAndUpdate = async (filter, changes) => {
    update = { filter, changes };
    return { _id: "booking", user: "customer" };
  };
  Booking.findById = () => ({ lean: async () => ({ _id: "booking", status: "completed" }) });
};

test("completion accepts omitted coordinates without writing fake coordinates", async () => {
  setup();
  const result = await complete({ id: "booking", businessId: "provider" });
  assert.equal(result.data.status, "completed");
  assert.deepEqual(Object.keys(update.changes.$set["checkIns.completed"]), ["at"]);
  assert.equal(currentFilter.business, "provider");
  assert.equal(currentFilter.status, "ongoing");
  assert.deepEqual(currentFilter["checkIns.customerArrived.at"], { $type: "date" });
  assert.deepEqual(currentFilter["noShow.status"], { $in: ["none", null] });
  assert.equal(update.changes.$set.capture.safeguarded, true);
  assert.equal(update.changes.$set.paymentStatus, "capture_retrying");
  assert.deepEqual(captures[0], ["booking"]);
});

test("completion accepts both coordinates and rejects partial or invalid coordinates", async () => {
  setup();
  await complete({ id: "booking", businessId: "provider", lat: "40", lng: "-74" });
  assert.equal(update.changes.$set["checkIns.completed"].lat, 40);
  assert.equal(update.changes.$set["checkIns.completed"].lng, -74);
  for (const coords of [{ lat: 1 }, { lng: 2 }, { lat: 91, lng: 1 }, { lat: 1, lng: NaN }]) {
    setup();
    assert.equal((await complete({ id: "booking", businessId: "provider", ...coords })).error, "location_required");
    assert.equal(update, undefined);
    assert.equal(captures.length, 0);
  }
});

test("completion rejects missing ownership, an ineligible booking, and a lost transition race", async () => {
  setup();
  assert.equal((await complete({ id: "booking" })).error, "booking_cannot_complete");
  assert.equal(currentFilter, undefined);
  Booking.findOne = () => ({ lean: async () => null });
  assert.equal((await complete({ id: "booking", businessId: "provider" })).error, "booking_cannot_complete");
  assert.equal(captures.length, 0);
  setup();
  Booking.findOneAndUpdate = async () => null;
  assert.equal((await complete({ id: "booking", businessId: "provider" })).error, "booking_cannot_complete");
  assert.equal(captures.length, 0);
});

test.after(() => {
  Booking.findOneAndUpdate = original.update;
  Booking.findById = original.find;
  Booking.findOne = original.findOne;
});
