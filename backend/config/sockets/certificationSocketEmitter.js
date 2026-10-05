const { getChatNamespace } = require("../../commonModules/chatModule/sockets/chatEventEmitter");
const { getUserRoom } = require("../../commonModules/chatModule/sockets/chatSocketRooms");

/**
 * Certification review result, pushed to the business that submitted it.
 *
 * Certification review is asynchronous — the business submits, then waits for
 * an admin who may act hours later — so the app has no request of its own to
 * learn the outcome from. This is that signal.
 *
 * Emitted on the /chat namespace: that's where a connected client holds its
 * account-wide `user:<id>` room (see chatSocketHandler), the same channel
 * "chatUpdated" and the call events already use. Delivery is best effort —
 * a business that's offline simply misses it and reads the status from the
 * profile/home endpoints on next load.
 */
const emitCertificationStatus = ({ io = global.io, userId, certifications, profileStatus = null }) => {
  const namespace = getChatNamespace(io);
  if (!namespace || !userId || !certifications) return;

  namespace.to(getUserRoom(userId)).emit("certificationStatus", {
    status: certifications.status,
    name: certifications.name || "",
    optionName: certifications.optionName || null,
    rejectionReason: certifications.rejectionReason || "",
    version: certifications.version,
    files: certifications.files || [],
    // The business profile's own status — approval releases a profile parked
    // in "pending", which is what re-enables service/package creation.
    profileStatus,
    reviewedAt: Date.now(),
  });
};

module.exports = { emitCertificationStatus };
