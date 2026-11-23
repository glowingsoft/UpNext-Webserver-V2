require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let response;
let calls = 0;
const oldEnv = process.env.NODE_ENV;
const oldKey = process.env.STRIPE_SECRET_KEY;
stub("@utils/responseUtil", { sendResponse: (value) => { response = value; }, validateParams: () => true });
stub("../backend/app/services/instantBookingService", { createInstantBooking: () => { calls++; } });
stub("../backend/app/services/instantOfferService", {});
stub("../backend/app/services/bookingCheckIn", {});
stub("../backend/app/services/bookingOfferResponse", {});
stub("../backend/app/services/bookingPreAcceptance", {});
stub("../backend/app/services/bookingNextProviders", {});
stub("../backend/app/services/bookingSendNext", {});
stub("../backend/app/services/bookingNoShowContest", {});
stub("../backend/app/services/bookingRequest", {
  createBookingRequest: async () => { calls++; return { data: { status: "requested" } }; },
});
stub("../backend/app/services/bookingAcceptance", {
  acceptBookingOffer: async () => ({ data: { bookingId: "booking" } }),
});
stub("../backend/app/services/bookingAuthorization", {
  resolveAuthorization: async () => ({ data: { status: "confirmed" } }),
});

const controller = require("../backend/app/controllers/instantController");

test("live requests are gated until completion and settlement are ready", async () => {
  process.env.NODE_ENV = "prod";
  process.env.STRIPE_SECRET_KEY = "sk_live_example";
  await controller.createBooking({ user: { _id: "customer" }, body: {} }, {});
  assert.equal(response.statusCode, 503);
  assert.equal(response.translationKey, "instant_request_unavailable");
  assert.equal(calls, 0);
});

test("test-mode requests and acceptance use the new flow", async () => {
  process.env.NODE_ENV = "dev";
  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  await controller.createBooking({ user: { _id: "customer" }, body: {} }, {});
  assert.equal(response.statusCode, 200);
  assert.equal(response.data.status, "requested");
  assert.equal(calls, 1);
  await controller.acceptOffer({ user: { businessId: "business" }, params: { offerId: "507f1f77bcf86cd799439011" } }, {});
  assert.equal(response.statusCode, 200);
  assert.equal(response.data.status, "confirmed");
});

test.after(() => {
  if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
});
