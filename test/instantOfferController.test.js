require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let declined, provider, nextOffer, canceled, contested, arrival, started, completed, response, legacyAcceptCalls = 0;
stub("@utils/responseUtil", {
  sendResponse: (result) => { response = result; },
  validateParams: () => true,
  parsePaginationParams: () => ({ page: 2, limit: 5 }),
});
stub("../backend/app/services/instantBookingService", {
  complete: async (args) => { completed = args; return { data: { status: "completed" } }; },
});
stub("../backend/app/services/instantOfferService", { acceptOffer: () => { legacyAcceptCalls++; } });
stub("../backend/app/services/bookingCheckIn", {
  recordCustomerArrival: async (args) => { arrival = args; return { data: { customerArrived: {} } }; },
  startInstantBooking: async (args) => { started = args; return { data: { status: "ongoing" } }; },
});
stub("../backend/app/services/bookingCancellation", {
  cancelInstantBooking: async (args) => { canceled = args; return { data: { status: "canceled" } }; },
});
stub("../backend/app/services/bookingNoShowContest", {
  contestNoShow: async (args) => { contested = args; return { data: { noShow: { status: "contested" } } }; },
});
stub("../backend/app/services/bookingNextProviders", {});
stub("../backend/app/services/bookingRequest", {});
stub("../backend/app/services/bookingAcceptance", {});
stub("../backend/app/services/bookingAuthorization", {});
stub("../backend/app/services/bookingSendNext", {
  sendNextOffer: async (args) => { nextOffer = args; return { data: { status: "requested" } }; },
});
stub("../backend/app/services/bookingOfferResponse", {
  closeOffer: async (args) => { declined = args; return { data: { status: "awaiting_customer_decision" } }; },
});
stub("../backend/app/services/bookingProviderOffers", {
  getProviderOffers: async (args) => { provider = args; return {
    data: [{ offerId: "first" }, { offerId: "second" }], meta: { totalRecords: 2 },
  }; },
});
const controller = require("../backend/app/controllers/instantController");

test("offer-ID decline uses the current provider and new state machine", async () => {
  const offerId = new mongoose.Types.ObjectId().toString();
  await controller.declineOffer({ params: { offerId }, user: { businessId: "business" } }, {});
  assert.deepEqual(declined, { offerId, businessId: "business" });
  assert.equal(response.data.status, "awaiting_customer_decision");
});

test("offer list uses authenticated business, returns metadata, and current returns the first", async () => {
  const req = { params: {}, query: { status: "expired", keyword: "cut", businessId: "other" }, user: { businessId: "business" } };
  await controller.providerOffers(req, {});
  assert.deepEqual(provider, { businessId: "business", page: 2, limit: 5, status: "expired", keyword: "cut" });
  assert.deepEqual(response.data, [{ offerId: "first" }, { offerId: "second" }]);
  assert.deepEqual(response.meta, { totalRecords: 2 });
  await controller.currentOffer(req, {});
  assert.deepEqual(provider, { businessId: "business", limit: 1 });
  assert.deepEqual(response.data, { offerId: "first" });
});

test("send-again and send-next dispatch under the authenticated customer", async () => {
  const bookingId = new mongoose.Types.ObjectId().toString();
  const req = { params: { id: bookingId }, user: { _id: "customer" }, body: { expectedTotalCents: 5700 } };
  await controller.sendAgain(req, {});
  assert.deepEqual(nextOffer, { bookingId, userId: "customer", body: req.body, resend: true });
  assert.equal(response.data.status, "requested");
  await controller.sendNext(req, {});
  assert.deepEqual(nextOffer, { bookingId, userId: "customer", body: req.body });
});

test("acceptance remains gated without closing an offer through the legacy engine", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "prod";
  try {
    await controller.acceptOffer({ params: { offerId: new mongoose.Types.ObjectId().toString() } }, {});
    assert.equal(response.statusCode, 503);
    assert.equal(response.translationKey, "instant_payment_unavailable");
    assert.equal(legacyAcceptCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test("cancel and contest use the v2 services and authenticated identities", async () => {
  const bookingId = new mongoose.Types.ObjectId().toString();
  await controller.cancelBooking({ params: { id: bookingId }, user: { _id: "customer", userType: "user" }, body: {} }, {});
  assert.deepEqual(canceled, {
    bookingId, userId: "customer", businessId: undefined, userType: "user", reason: undefined,
  });
  await controller.providerCancel({ params: { id: bookingId },
    user: { _id: "provider", businessId: "business", userType: "business" }, body: { reason: "unavailable" } }, {});
  assert.deepEqual(canceled, {
    bookingId, userId: "provider", businessId: "business", userType: "business", reason: "unavailable",
  });
  await controller.contestNoShow({ params: { id: bookingId }, user: { businessId: "provider" }, body: { note: "Arrived" } }, {});
  assert.deepEqual(contested, { bookingId, businessId: "provider", note: "Arrived" });
});

test("customer check-in and manual start use authenticated roles and identities", async () => {
  const id = new mongoose.Types.ObjectId().toString();
  await controller.customerArrived({ params: { id }, user: { _id: "customer", userType: "user" } }, {});
  assert.deepEqual(arrival, { bookingId: id, userId: "customer", businessId: undefined, actor: "user", lat: undefined, lng: undefined });
  await controller.customerArrived({ params: { id }, user: { _id: "provider", businessId: "business", userType: "business" },
    body: { lat: 1, lng: 2 } }, {});
  assert.deepEqual(arrival, { bookingId: id, userId: "provider", businessId: "business", actor: "business", lat: 1, lng: 2 });
  await controller.start({ params: { id }, user: { businessId: "business" } }, {});
  assert.deepEqual(started, { bookingId: id, businessId: "business" });
});

test("completion passes omitted coordinates without requiring a request body", async () => {
  const oldEnv = process.env.NODE_ENV;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  process.env.NODE_ENV = "dev";
  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  const id = new mongoose.Types.ObjectId().toString();
  try {
    await controller.complete({ params: { id }, user: { businessId: "business" } }, {});
    assert.deepEqual(completed, { id, businessId: "business", lat: undefined, lng: undefined });
    process.env.NODE_ENV = "prod";
    completed = undefined;
    await controller.complete({ params: { id }, user: { businessId: "business" } }, {});
    assert.equal(response.statusCode, 503);
    assert.equal(completed, undefined);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
  }
});
