require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");
const { getCancellationQuote } = require("../backend/app/services/bookingCancellationQuote");

const original = { booking: Booking.findOne, offer: BookingOffer.exists, provider: BusinessProfile.findById };
const customer = { bookingId: "booking", userId: "customer", userType: "user" };
let filter;
let offerFilter;
let booking;
let offer;
let provider;

const setup = (status) => {
  booking = { _id: "booking", user: "customer", business: "business", status, paymentStatus: "pending",
    payment: null, pricing: { heldCents: 0 }, flow: { currentOffer: { offerId: "offer" } },
    authorization: { offerId: "offer" } };
  offer = { _id: "offer" };
  provider = { user: "provider" };
  Booking.findOne = (query) => {
    filter = query;
    return { lean: async () => booking };
  };
  BookingOffer.exists = async (query) => { offerFilter = query; return offer; };
  BusinessProfile.findById = () => ({ lean: async () => provider });
};

test("customer receives a zero-charge quote for each supported state", async () => {
  for (const status of ["requested", "awaiting_customer_decision", "accepted_awaiting_payment"]) {
    setup(status);
    const result = await getCancellationQuote(customer);
    assert.deepEqual(result.data, {
      bookingId: "booking", bookingStatus: status, canceledBy: "user", currency: "usd",
      penaltyCents: 0, chargeCents: 0,
      authorizationRelease: status === "accepted_awaiting_payment" ? "if_present" : "not_applicable",
    });
    assert.deepEqual(filter, { _id: "booking", mode: "instant", user: "customer" });
    if (status === "requested") {
      assert.deepEqual(offerFilter, { _id: "offer", booking: "booking", business: "business", status: "pending" });
    }
  }
});

test("unavailable states and inconsistent pending bookings do not receive a quote", async () => {
  for (const status of ["confirmed", "ongoing", "canceled", "completed"]) {
    setup(status);
    assert.equal((await getCancellationQuote(customer)).status, 409);
  }
  setup("requested");
  offer = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("requested");
  provider = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("awaiting_customer_decision");
  booking.pricing.heldCents = 1;
  assert.equal((await getCancellationQuote(customer)).status, 409);
  setup("accepted_awaiting_payment");
  booking.authorization = null;
  assert.equal((await getCancellationQuote(customer)).status, 409);
});

test("ownership is scoped by role and unsupported provider cancellation returns 409", async () => {
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
});
