const { getChatNamespace } = require("../../commonModules/chatModule/sockets/chatEventEmitter");
const { getUserRoom } = require("../../commonModules/chatModule/sockets/chatSocketRooms");

/**
 * Signal-only: the payload tells the app *that* something changed and which
 * offer, never the booking details — the app refetches over HTTP. `serverNow`
 * lets the client count down against the server clock instead of its own.
 * Best effort; push covers an offline provider.
 */
const emitOffer = (event, { io = global.io, userId, bookingId, offerId, expiresAt, status, paymentStatus, reason }) => {
  if (!status) throw new Error("Offer status is required for socket signals");
  const namespace = getChatNamespace(io);
  if (!namespace || !userId) return;
  namespace.to(getUserRoom(userId)).emit(event, {
    bookingId: String(bookingId),
    offerId: String(offerId),
    status,
    paymentStatus: paymentStatus ?? null,
    ...(reason && { reason }),
    expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    serverNow: Date.now(),
  });
};

const emitOfferReceived = (args) => emitOffer("offerReceived", { ...args, status: "pending" });
const emitOfferClosed = (args) => emitOffer("offerClosed", args);

const emitBookingPaymentUpdated = ({ io = global.io, userId, bookingId, offerId, bookingStatus, paymentStatus }) => {
  if (!bookingStatus || !paymentStatus) throw new Error("Booking and payment statuses are required");
  const namespace = getChatNamespace(io);
  if (!namespace || !userId) return;
  namespace.to(getUserRoom(userId)).emit("bookingPaymentUpdated", {
    bookingId: String(bookingId),
    offerId: String(offerId),
    bookingStatus,
    paymentStatus,
    serverNow: Date.now(),
  });
};

module.exports = { emitOfferReceived, emitOfferClosed, emitBookingPaymentUpdated };
