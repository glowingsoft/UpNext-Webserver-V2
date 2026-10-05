const { getChatNamespace } = require("../../commonModules/chatModule/sockets/chatEventEmitter");
const { getUserRoom } = require("../../commonModules/chatModule/sockets/chatSocketRooms");

/**
 * "Your inbox changed" — pushed to an account whose notification row was just
 * saved.
 *
 * The saved row and the FCM push are independent (see sendUserNotifications):
 * a recipient with `pushNotifications` — or a per-type toggle like
 * `messageAlerts` — set to false still gets the row, and had no way to learn
 * about it until the next GET /app/notifications. This is that signal, and it
 * deliberately ignores push preferences: those govern the OS notification tray,
 * not in-app state.
 *
 * A signal, not the row. `unreadCount` is there so the badge updates without a
 * round trip, but the notification itself is left to GET /app/notifications —
 * that endpoint formats `timeSince` in the caller's timezone and enriches
 * `subject` with the sender's business, and duplicating that shape here would
 * give the client two versions of the same row to keep in sync.
 *
 * Emitted on the /chat namespace, where a connected client already holds its
 * account-wide `user:<id>` room (see chatSocketHandler) — the same channel
 * "chatUpdated" and "certificationStatus" use. Best effort: a recipient who is
 * offline simply misses it and reads the inbox on next load.
 */
const emitNotificationReceived = ({ io = global.io, userId, unreadCount, notificationId, type }) => {
  const namespace = getChatNamespace(io);
  if (!namespace || !userId) return;

  namespace.to(getUserRoom(userId)).emit("notificationReceived", {
    // Enough to badge immediately and to decide whether a refetch is even
    // needed — the inbox screen refetches page 1, everything else just counts.
    unreadCount,
    notificationId: notificationId ? String(notificationId) : null,
    type: type || null,
    receivedAt: Date.now(),
  });
};

module.exports = { emitNotificationReceived };
