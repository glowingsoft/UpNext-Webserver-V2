require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("../backend/app/services/paymentService", {});
stub("@services/stripePayment", {});
stub("@redisCache", {});
stub("../backend/commonModules/chatModule/services/conversationGateService", { TERMINAL_BOOKING_STATUSES: [] });
const { getUserBookings } = require("../backend/app/services/bookingService");
const original = { aggregate: Booking.aggregate, count: Booking.countDocuments };

test("instant customer list filters by owner and mode and excludes payment authorization fields", async () => {
  const userId = new mongoose.Types.ObjectId();
  const pipelines = [];
  let countFilter;
  Booking.aggregate = async (pipeline) => { pipelines.push(pipeline); return []; };
  Booking.countDocuments = async (filter) => { countFilter = filter; return 0; };
  try {
    const result = await getUserBookings({ userId, mode: "instant", status: "confirmed", page: "1", limit: "10" });
    const pipeline = pipelines.find((value) => value.some((stage) => stage.$unset === "business"));
    assert.equal(String(pipeline[0].$match.user), String(userId));
    assert.equal(pipeline[0].$match.mode, "instant");
    assert.equal(pipeline[0].$match.status, "confirmed");
    assert.equal(countFilter.mode, "instant");
    assert.ok(pipeline.some((stage) => Array.isArray(stage.$unset) &&
      stage.$unset.includes("authorization") && stage.$unset.includes("stripePaymentMethodId")));
    assert.ok(pipeline.some((stage) => stage.$limit === 10));
    assert.equal(result.meta.total, 0);
  } finally {
    Booking.aggregate = original.aggregate;
    Booking.countDocuments = original.count;
  }
});
