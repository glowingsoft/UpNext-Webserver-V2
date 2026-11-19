require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let received, response, allowed;
stub("@utils/responseUtil", {
  validateParams: (req, res, options) => {
    allowed = options.enumFields.status;
    return !req.query.status || allowed.includes(req.query.status);
  },
  sendResponse: (value) => { response = value; },
});
stub("../backend/app/services/bookingService", {
  getUserBookings: async (args) => {
    received = args;
    return { data: [{ status: "confirmed" }], meta: { total: 1 } };
  },
});
const { getInstantUserBookings, getUserBookings } = require("../backend/app/controllers/bookingController");

test("instant booking list supports current statuses and preserves pagination metadata", async () => {
  const req = { query: { status: "confirmed", page: "1", limit: "10" }, user: { _id: "customer" } };
  await getInstantUserBookings(req, {});
  assert.ok(allowed.includes("awaiting_customer_decision"));
  assert.equal(received.mode, "instant");
  assert.equal(received.userId, "customer");
  assert.equal(received.status, "confirmed");
  assert.equal(received.page, "1");
  assert.deepEqual(response.meta, { total: 1 });
});

test("legacy booking list keeps its previous statuses and is not restricted to instant", async () => {
  received = null;
  await getUserBookings({ query: { status: "scheduled" }, user: { _id: "customer" } }, {});
  assert.equal(received.mode, undefined);
  assert.ok(allowed.includes("scheduled"));
  assert.ok(!allowed.includes("confirmed"));
});
