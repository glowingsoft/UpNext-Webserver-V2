require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const handler = () => {};
stub("@middlewares/authMiddleware", handler);
stub("@middlewares/roleMiddleware", () => handler);
stub("@middlewares/debtMiddleware", { blockOutstandingDebt: handler });
const controller = new Proxy({}, { get: () => handler });
stub("../backend/app/controllers/instantController", controller);
stub("../backend/app/controllers/bookingController", controller);
stub("../backend/app/services/bookingLifecycleService", {
  runApprovalExpiryCron: handler,
  runHorizonChargeCron: handler,
  runPaymentFixGraceCron: handler,
  runStatusTransitionCron: handler,
});

const instant = require("../backend/app/routes/instantRoutes");
const booking = require("../backend/app/routes/bookingRoutes");
const routes = (router) => router.stack.filter((item) => item.route).map((item) => ({
  path: item.route.path,
  methods: Object.keys(item.route.methods),
}));
const has = (list, method, route) => list.some((item) => item.path === route && item.methods.includes(method));

test("v2 quote, offers, decline, cancel and customer check-in are registered under instant", () => {
  const list = routes(instant);
  for (const [method, route] of [
    ["get", "/quote"],
    ["get", "/offers"],
    ["get", "/offers/current"],
    ["get", "/bookings"],
    ["get", "/bookings/slots"],
    ["get", "/bookings/:id"],
    ["get", "/bookings/:id/quote/cancel"],
    ["patch", "/offers/:offerId/decline"],
    ["post", "/bookings/:id/decline"],
    ["post", "/bookings/:id/cancel"],
    ["post", "/bookings/:id/customer-arrived"],
    ["patch", "/bookings/:id/start"],
    ["get", "/bookings/:id/next-providers"],
    ["post", "/bookings/:id/send-again"],
    ["post", "/bookings/:id/send-next"],
  ]) assert.equal(has(list, method, route), true, `${method} ${route}`);
});

test("provider arrival routes are no longer registered", () => {
  const list = routes(instant);
  assert.equal(has(list, "post", "/bookings/:id/arrived"), false);
  assert.equal(has(list, "patch", "/bookings/:id/arrived"), false);
});

test("v2 routes are absent from legacy booking router and legacy actions remain", () => {
  const list = routes(booking);
  for (const [method, route] of [
    ["get", "/quote"],
    ["post", "/:id/decline"],
    ["post", "/:id/cancel"],
    ["post", "/:id/arrived"],
  ]) assert.equal(has(list, method, route), false, `${method} ${route}`);
  for (const [method, route] of [
    ["post", "/"], ["patch", "/:id/accept"], ["patch", "/:id/cancel"], ["patch", "/:id/complete"],
  ]) assert.equal(has(list, method, route), true, `${method} ${route}`);
});

test("instant collection samples target instant URLs and consistent Postman paths", () => {
  const collection = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "postman_collection", "UpNext.postman_collection.json")));
  const folder = collection.item.find((item) => item.name === "Up Next (Instant)");
  assert.ok(folder);
  const visit = (items) => {
    for (const item of items) {
      if (item.item) visit(item.item);
      if (!item.request?.url?.raw?.startsWith("{{url}}app/")) continue;
      const { raw, path: segments } = item.request.url;
      assert.ok(raw.startsWith("{{url}}app/instant/"), item.name);
      assert.equal(raw.split("?")[0], `{{url}}app/${segments.join("/")}`, item.name);
    }
  };
  visit(folder.item);
});
