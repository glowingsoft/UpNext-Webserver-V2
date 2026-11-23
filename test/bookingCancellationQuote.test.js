require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const penaltyPath = require.resolve("../backend/app/services/penaltyService");
require.cache[penaltyPath] = {
  id: penaltyPath,
  filename: penaltyPath,
  loaded: true,
  exports: {
    quoteCancellationPenalty: async ({ cancellationCount }) => ({
      cancellationNumber: cancellationCount + 1,
      deductionCents: cancellationCount >= 1 ? 700 : 0,
      warningIssued: cancellationCount === 0,
      rankingReductionApplied: cancellationCount >= 1,
      suspensionHours: cancellationCount >= 2 ? 24 : 0,
    }),
  },
};

const { getCancellationQuote } = require("../backend/app/services/bookingCancellationQuote");
const original = { booking: Booking.findOne, offer: BookingOffer.exists, provider: BusinessProfile.findById };
const customer = { bookingId: "booking", userId: "customer", userType: "user" };
let filter;
let offerFilter;
let booking;
let offer;
let provider;

const setup = (status) => {
  booking = {
    _id: "booking", user: "customer", business: "business", status, paymentStatus: "pending",
    payment: null, pricing: { depositCents: 1500, heldCents: 0, totalCents: 10700 },
    cancellationPolicySnapshot: { policy: "refundable_24h" },
    flow: { isAvailableNow: false, appointmentStart: new Date("2026-11-20T12:00:00Z"),
      currentOffer: { offerId: "offer" } },
    authorization: { offerId: "offer" },
  };
  offer = { _id: "offer" };
  provider = { user: "provider", matchStats: { cancellationCount: 0 } };
  Booking.findOne = (query) => {
    filter = query;
    return { lean: async () => booking };
  };
  BookingOffer.exists = async (query) => { offerFilter = query; return offer; };
  BusinessProfile.findById = () => ({ lean: async () => provider });
};

test("customer receives no-charge pre-acceptance and unheld payment-window quotes", async () => {
  for (const status of ["requested", "awaiting_customer_decision", "accepted_awaiting_payment"]) {
    setup(status);
    const result = await getCancellationQuote(customer);
    assert.equal(result.data.chargeCents, 0);
    assert.equal(result.data.penaltyCents, 0);
    assert.equal(result.data.canceledBy, "user");
    assert.equal(result.data.authorizationRelease, status === "accepted_awaiting_payment" ?
      "if_present" : "not_applicable");
    assert.deepEqual(filter, { _id: "booking", mode: "instant", user: "customer" });
    if (status === "requested") {
      assert.deepEqual(offerFilter, { _id: "offer", booking: "booking", business: "business", status: "pending" });
    }
  }
});

test("a customer cancellation quote captures only a forfeited deposit", async () => {
  setup("confirmed");
  booking.paymentStatus = "authorized";
  booking.payment = "payment";
  booking.pricing.heldCents = 10700;
  booking.authorization.intentId = "intent";
  booking.flow.appointmentStart = new Date("2026-11-18T11:00:00Z");
  const result = await getCancellationQuote({ ...customer, now: new Date("2026-11-17T12:00:00Z") });
  assert.equal(result.data.chargeCents, 1500);
  assert.equal(result.data.refundableDepositCents, 0);

  booking.cancellationPolicySnapshot.policy = "refundable_24h";
  booking.flow.appointmentStart = new Date("2026-11-18T12:00:00Z");
  const refundable = await getCancellationQuote({ ...customer, now: new Date("2026-11-17T12:00:00Z") });
  assert.equal(refundable.data.chargeCents, 0);
  assert.equal(refundable.data.refundableDepositCents, 1500);
});

test("provider quotes include warning, payout deduction, ranking and suspension actions", async () => {
  setup("confirmed");
  booking.paymentStatus = "authorized";
  booking.payment = "payment";
  booking.pricing.heldCents = 10700;
  booking.authorization.intentId = "intent";
  const business = { bookingId: "booking", userType: "business", businessId: "business" };
  let result = await getCancellationQuote(business);
  assert.equal(result.data.chargeCents, 0);
  assert.equal(result.data.penaltyCents, 0);
  assert.equal(result.data.warningIssued, true);
  assert.equal(result.data.rankingReductionApplied, false);

  provider.matchStats.cancellationCount = 1;
  result = await getCancellationQuote(business);
  assert.equal(result.data.penaltyCents, 700);
  assert.equal(result.data.rankingReductionApplied, true);
  assert.equal(result.data.suspensionHours, 0);

  provider.matchStats.cancellationCount = 2;
  result = await getCancellationQuote(business);
  assert.equal(result.data.penaltyCents, 700);
  assert.equal(result.data.suspensionHours, 24);
  assert.deepEqual(filter, { _id: "booking", mode: "instant", business: "business" });
});

test("unavailable states and inconsistent bookings do not receive a quote", async () => {
  for (const status of ["canceled", "completed"]) {
    setup(status);
    assert.equal((await getCancellationQuote(customer)).status, 409);
  }
  setup("requested");
  offer = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("requested");
  provider = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("accepted_awaiting_payment");
  booking.authorization = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("confirmed");
  assert.equal((await getCancellationQuote(customer)).status, 409);
});

test("ownership is scoped by role and unsupported states return 404 or 409", async () => {
  setup("confirmed");
  const business = { bookingId: "booking", userType: "business", businessId: "business" };
  assert.equal((await getCancellationQuote(business)).status, 409);
  assert.deepEqual(filter, { _id: "booking", mode: "instant", business: "business" });
  booking = null;
  assert.equal((await getCancellationQuote(customer)).status, 404);
  assert.equal((await getCancellationQuote({ ...business, businessId: null })).status, 404);
});

test.after(() => {
  Booking.findOne = original.booking;
  BookingOffer.exists = original.offer;
  BusinessProfile.findById = original.provider;
  delete require.cache[penaltyPath];
});
