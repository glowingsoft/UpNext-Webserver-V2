require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { emitOfferReceived, emitOfferClosed, emitBookingPaymentUpdated } = require("../backend/config/sockets/instantOfferSocketEmitter");

test("offer events keep their names and expose the persisted offer status", () => {
  const events = [];
  const io = { of: (namespace) => {
    assert.equal(namespace, "/chat");
    return { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
  } };
  const args = { io, userId: "provider", bookingId: "booking", offerId: "offer", expiresAt: new Date(2000000000000) };
  emitOfferReceived({ ...args, paymentStatus: "pending" });
  emitOfferClosed({ ...args, status: "accepted", paymentStatus: "authorized" });
  emitOfferClosed({ ...args, status: "closed", reason: "customer_canceled" });
  assert.deepEqual(events.map((event) => event.event), ["offerReceived", "offerClosed", "offerClosed"]);
  assert.deepEqual(events.map((event) => event.payload.status), ["pending", "accepted", "closed"]);
  assert.deepEqual(events.map((event) => event.payload.paymentStatus), ["pending", "authorized", null]);
  assert.equal(events[0].room, "user:provider");
  assert.equal(events[0].payload.expiresAt, args.expiresAt.getTime());
  assert.equal(events[2].payload.reason, "customer_canceled");
  assert.ok(Number.isFinite(events[1].payload.serverNow));
  assert.throws(() => emitOfferClosed(args), /status is required/);
});

test("payment update targets the user room and carries booking and payment statuses", () => {
  let result;
  const io = { of: () => ({ to: (room) => ({ emit: (event, payload) => { result = { room, event, payload }; } }) }) };
  emitBookingPaymentUpdated({ io, userId: "provider", bookingId: "booking", offerId: "offer",
    bookingStatus: "confirmed", paymentStatus: "authorized" });
  assert.equal(result.room, "user:provider");
  assert.equal(result.event, "bookingPaymentUpdated");
  assert.equal(result.payload.bookingId, "booking");
  assert.equal(result.payload.offerId, "offer");
  assert.equal(result.payload.bookingStatus, "confirmed");
  assert.equal(result.payload.paymentStatus, "authorized");
  assert.ok(Number.isFinite(result.payload.serverNow));
  assert.throws(() => emitBookingPaymentUpdated({ io }), /statuses are required/);
});
