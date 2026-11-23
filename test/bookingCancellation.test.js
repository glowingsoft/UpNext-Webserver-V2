require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");

const calls = { captures: [], releases: [], penalties: [], notifications: [] };
let booking;
let transitionArgs;

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return filename;
};
const cachePaths = [
  stub("../backend/app/services/bookingStateMachine", {
    transitionBooking: async (args) => {
      transitionArgs = args;
      booking.status = "canceled";
      booking.cancelReason = args.reason;
      Object.entries(args.set).forEach(([key, value]) => setPath(booking, key, value));
      return booking;
    },
  }),
  stub("../backend/app/services/bookingPreAcceptance", {
    cancelBeforeAcceptance: async (args) => ({ data: { bookingId: args.bookingId, status: "canceled" } }),
  }),
  stub("../backend/app/services/bookingOfferResponse", {
    closeOffer: async (args) => ({ data: { bookingId: args.bookingId, status: "awaiting_customer_decision" } }),
  }),
  stub("../backend/app/services/penaltyService", {
    recordPenalty: async (args) => {
      calls.penalties.push(args);
      return {
        penalty: { _id: "penalty" }, cancellationNumber: 2, deductionCents: 700,
        warningOnly: false, rankingReductionApplied: true, suspendedUntil: null,
      };
    },
  }),
  stub("../backend/app/services/bookingAuthorization", {
    cleanupAuthorization: async () => {
      calls.releases.push(booking._id);
      booking.paymentStatus = "released";
    },
  }),
  stub("../backend/app/services/instantPaymentService", {
    runCapture: async (bookingId) => {
      calls.captures.push(bookingId);
      booking.paymentStatus = "partially_captured";
      booking.capture.status = "captured";
      return true;
    },
  }),
  stub("../backend/commonModules/controllers/communicationController", {
    sendUserNotifications: (args) => calls.notifications.push(args),
  }),
];

const setPath = (object, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((current, key) => {
    current[key] = current[key] || {};
    return current[key];
  }, object);
  parent[last] = value;
};

const { cancelInstantBooking } = require("../backend/app/services/bookingCancellation");
const original = {
  startSession: mongoose.startSession,
  findOne: Booking.findOne,
  findById: Booking.findById,
  updateOne: Booking.updateOne,
  provider: BusinessProfile.findById,
};

const setup = (status = "confirmed") => {
  calls.captures.length = 0;
  calls.releases.length = 0;
  calls.penalties.length = 0;
  calls.notifications.length = 0;
  transitionArgs = null;
  booking = {
    _id: "booking", user: "customer", business: "business", status, mode: "instant",
    paymentStatus: "authorized", payment: "payment",
    pricing: { depositCents: 1500, heldCents: 10700, totalCents: 10700 },
    cancellationPolicySnapshot: { policy: "refundable_24h" },
    flow: { isAvailableNow: false, appointmentStart: new Date("2026-11-18T11:00:00Z") },
    authorization: { offerId: "offer", intentId: "intent", cleanupPending: false },
    capture: { status: "none" },
    statusHistory: [],
  };
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  Booking.findOne = () => ({
    session: () => ({ lean: async () => booking }),
    lean: async () => booking,
  });
  Booking.findById = () => ({ lean: async () => booking });
  Booking.updateOne = async (_, update) => {
    Object.entries(update.$set || {}).forEach(([key, value]) => setPath(booking, key, value));
    return { matchedCount: 1 };
  };
  BusinessProfile.findById = () => ({
    session: () => ({ lean: async () => ({ user: "provider" }) }),
    lean: async () => ({ user: "provider" }),
  });
};

test("customer cancellation captures only a forfeited deposit and records the settlement", async () => {
  setup();
  const result = await cancelInstantBooking({
    bookingId: "booking", userId: "customer", userType: "user",
    now: new Date("2026-11-17T12:00:00Z"),
  });
  assert.equal(transitionArgs.set.paymentStatus, "capture_retrying");
  assert.equal(transitionArgs.set["capture.amountCents"], 1500);
  assert.equal(transitionArgs.set["capture.kind"], "cancellation");
  assert.equal(booking.cancellation.chargeCents, 1500);
  assert.deepEqual(calls.captures, ["booking"]);
  assert.deepEqual(calls.releases, []);
  assert.equal(result.data.chargeCents, 1500);
  assert.equal(result.data.paymentStatus, "partially_captured");
});

test("customer cancellation inside the refundable window releases rather than captures", async () => {
  setup();
  booking.flow.appointmentStart = new Date("2026-11-20T12:00:00Z");
  const result = await cancelInstantBooking({
    bookingId: "booking", userId: "customer", userType: "user",
    now: new Date("2026-11-17T12:00:00Z"),
  });
  assert.equal(transitionArgs.set["authorization.cleanupPending"], true);
  assert.equal(booking.cancellation.chargeCents, 0);
  assert.equal(booking.cancellation.refundableDepositCents, 1500);
  assert.deepEqual(calls.captures, []);
  assert.deepEqual(calls.releases, ["booking"]);
  assert.equal(result.data.chargeCents, 0);
});

test("provider cancellation charges no customer and persists the penalty ladder actions", async () => {
  setup("ongoing");
  const result = await cancelInstantBooking({
    bookingId: "booking", businessId: "business", userType: "business", reason: "unavailable",
    now: new Date("2026-11-17T12:00:00Z"),
  });
  assert.equal(transitionArgs.reason, "provider");
  assert.equal(booking.cancellation.chargeCents, 0);
  assert.equal(booking.cancellation.providerPenalty, "penalty");
  assert.equal(booking.cancellation.providerCancellationNumber, 2);
  assert.equal(booking.cancellation.rankingReductionApplied, true);
  assert.equal(calls.penalties[0].type, "cancellation");
  assert.deepEqual(calls.captures, []);
  assert.deepEqual(calls.releases, ["booking"]);
  assert.equal(result.data.providerPenaltyCents, 700);
  assert.equal(result.data.rankingReductionApplied, true);
});

test("pre-acceptance cancellation delegates to the customer-cancel or provider-decline flow", async () => {
  setup("requested");
  let result = await cancelInstantBooking({
    bookingId: "booking", userId: "customer", userType: "user",
  });
  assert.equal(result.data.status, "canceled");

  setup("requested");
  result = await cancelInstantBooking({
    bookingId: "booking", businessId: "business", userType: "business",
  });
  assert.equal(result.data.status, "awaiting_customer_decision");
  assert.deepEqual(calls.penalties, []);
});

test.after(() => {
  mongoose.startSession = original.startSession;
  Booking.findOne = original.findOne;
  Booking.findById = original.findById;
  Booking.updateOne = original.updateOne;
  BusinessProfile.findById = original.provider;
  cachePaths.forEach((path) => { delete require.cache[path]; });
});
