require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const BookingOffer = require("@models/BookingOffer");
const BusinessProfile = require("@models/BusinessProfile");

const signals = [];
const socketPath = require.resolve("@socketIo/instantOfferSocketEmitter");
require.cache[socketPath] = { id: socketPath, filename: socketPath, loaded: true,
  exports: { emitOfferClosed: (signal) => signals.push(signal), emitOfferReceived: () => {} } };
const { cancelSearch } = require("../backend/app/services/instantOfferService");
const original = { bookingUpdate: Booking.findOneAndUpdate, bookingFind: Booking.findById, update: Booking.updateOne,
  offer: BookingOffer.findOneAndUpdate, profile: BusinessProfile.findOneAndUpdate, profileUpdate: BusinessProfile.updateOne };

test("legacy offer closure reads the booking payment status without blocking cancellation on lookup failure", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    Booking.findOneAndUpdate = async () => ({ _id: "booking", instant: { offer: { current: "offer" } } });
    Booking.updateOne = async () => ({});
    BookingOffer.findOneAndUpdate = async () => ({ _id: "offer", booking: "booking", business: "business", status: "closed" });
    BusinessProfile.findOneAndUpdate = () => ({ lean: async () => ({ user: "provider" }) });
    BusinessProfile.updateOne = async () => ({});
    Booking.findById = () => ({ lean: async () => ({ paymentStatus: "authorized" }) });
    await cancelSearch({ bookingId: "booking", userId: "customer" });
    assert.equal(signals[0].paymentStatus, "authorized");

    Booking.findById = () => ({ lean: async () => { throw new Error("database unavailable"); } });
    await cancelSearch({ bookingId: "booking", userId: "customer" });
    assert.equal(signals[1].paymentStatus, null);
    assert.match(errors[0][0], /payment status lookup failed/);
  } finally {
    console.error = originalError;
  }
});

test.after(() => {
  Booking.findOneAndUpdate = original.bookingUpdate;
  Booking.findById = original.bookingFind;
  Booking.updateOne = original.update;
  BookingOffer.findOneAndUpdate = original.offer;
  BusinessProfile.findOneAndUpdate = original.profile;
  BusinessProfile.updateOne = original.profileUpdate;
});
