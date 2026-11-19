const Booking = require("@models/Bookings");
const { transitionBooking } = require("./bookingStateMachine");

const coordinatesValid = (lat, lng) => {
  const hasLat = lat !== undefined && lat !== null;
  const hasLng = lng !== undefined && lng !== null;
  return hasLat === hasLng && (!hasLat || (typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180));
};

const recordCustomerArrival = async ({ bookingId, userId, businessId, actor, lat, lng, now = new Date() }) => {
  if (!coordinatesValid(lat, lng)) return { error: "location_required", status: 400 };
  if ((actor !== "user" && actor !== "business") || (actor === "user" && !userId) ||
      (actor === "business" && !businessId)) return { error: "booking_cannot_check_in", status: 409 };
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      mode: "instant",
      ...(actor === "user" ? { user: userId } : { business: businessId }),
      status: { $in: ["confirmed", "ongoing"] },
      "checkIns.customerArrived.at": { $exists: false },
    },
    { $set: { "checkIns.customerArrived": {
      at: now, by: actor, ...(lat != null && { lat, lng }),
    } } },
    { new: true, runValidators: true },
  ).lean();
  if (!booking) return { error: "booking_cannot_check_in", status: 409 };
  return { data: { bookingId: booking._id, customerArrived: booking.checkIns.customerArrived } };
};

const startInstantBooking = async ({ bookingId, businessId, now = new Date() }) => {
  if (!businessId) return { error: "instant_booking_cannot_start", status: 409 };
  const booking = await transitionBooking({
    bookingId, from: "confirmed", to: "ongoing", actor: "business", now,
    guard: { mode: "instant", business: businessId, "checkIns.customerArrived.at": { $type: "date" } },
  });
  if (!booking) return { error: "instant_booking_cannot_start", status: 409 };
  return { data: { bookingId: booking._id, status: booking.status } };
};

module.exports = { recordCustomerArrival, startInstantBooking };
