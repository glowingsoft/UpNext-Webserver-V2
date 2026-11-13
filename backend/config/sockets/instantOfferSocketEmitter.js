const { getChatNamespace } = require("../../commonModules/chatModule/sockets/chatEventEmitter");
const { getUserRoom } = require("../../commonModules/chatModule/sockets/chatSocketRooms");

/**
 * Signal-only: the payload tells the app *that* something changed and which
 * offer, never the booking details — the app refetches over HTTP. `serverNow`
 * lets the client count down against the server clock instead of its own.
 * Best effort; push covers an offline provider.
 */
const emitOffer = (event, { io = global.io, userId, bookingId, offerId, expiresAt }) => {
  const namespace = getChatNamespace(io);
  if (!namespace || !userId) return;
  namespace.to(getUserRoom(userId)).emit(event, {
    bookingId: String(bookingId),
    offerId: String(offerId),
    expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    serverNow: Date.now(),
  });
};

const emitOfferReceived = (args) => emitOffer("offerReceived", args);
const emitOfferClosed = (args) => emitOffer("offerClosed", args);

module.exports = { emitOfferReceived, emitOfferClosed };
