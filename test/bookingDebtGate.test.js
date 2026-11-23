require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { User } = require("@models/UserModel");

const servicePath = require.resolve("../backend/app/services/paymentService");
let debt;
require.cache[servicePath] = {
  id: servicePath, filename: servicePath, loaded: true,
  exports: { getOutstandingDebt: async () => debt },
};
const responsePath = require.resolve("@utils/responseUtil");
let response;
require.cache[responsePath] = {
  id: responsePath, filename: responsePath, loaded: true,
  exports: { sendResponse: (value) => { response = value; } },
};
const { blockOutstandingDebt } = require("../backend/middlewares/debtMiddleware");
const originalFind = User.findById;

test("debt gate checks actual outstanding bookings even if the cached flag is false", async () => {
  User.findById = () => ({ select: () => ({ lean: async () => ({ hasOutstandingDebt: false }) }) });
  debt = { hasDebt: true, bookings: [{ _id: "booking" }] };
  response = null;
  let nextCalled = false;
  await blockOutstandingDebt({ user: { _id: "customer", userType: "user" } }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.data.outstandingBooking, "booking");
});

test("debt gate allows customers once all outstanding bookings are paid", async () => {
  User.findById = () => ({ select: () => ({ lean: async () => ({ hasOutstandingDebt: true }) }) });
  debt = { hasDebt: false, bookings: [] };
  let nextCalled = false;
  await blockOutstandingDebt({ user: { _id: "customer", userType: "user" } }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test.after(() => { User.findById = originalFind; });
