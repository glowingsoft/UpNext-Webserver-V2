const { getUserRoom } = require("./chatSocketRooms");

function getChatNamespace(ioOrNamespace) {
  if (!ioOrNamespace) return null;

  if (typeof ioOrNamespace.of === "function") {
    return ioOrNamespace.of("/chat");
  }

  return ioOrNamespace;
}

/**
 * Which of these userIds currently have a socket that's a member of `room`.
 * Used to tell "has this exact conversation open right now" apart from
 * merely being connected to the app at all — being online elsewhere isn't
 * the same as having seen a message in this specific conversation.
 */
async function getUsersInRoom(chatNamespace, userIds = [], room) {
  if (!room) return [];
  const matched = [];

  await Promise.all(
    userIds.map(async (userId) => {
      const sockets = await chatNamespace.in(getUserRoom(userId)).fetchSockets();
      if (sockets.some((socket) => socket.rooms.has(room))) {
        matched.push(String(userId));
      }
    })
  );

  return matched;
}

/**
 * "receiveMessage" is a thread-scoped event: it belongs to the sockets that
 * actually have THIS conversation open, so it must go to the conversation room
 * — never to the recipients' account-wide `user:<id>` rooms. A recipient keeps
 * one socket per open thread (and all of them join their own user room), so
 * fanning out per-user delivers every conversation's messages to every open
 * thread of that account, and a client that appends on "receiveMessage" shows
 * customer B's message inside customer A's chat.
 *
 * Recipients who are connected but not currently in this conversation still
 * learn about the message from "chatUpdated" on their user room.
 */
function emitMessageToConversation({ ioOrNamespace, room, excludeUserId, message }) {
  const chatNamespace = getChatNamespace(ioOrNamespace);
  if (!chatNamespace || !room) return;

  let target = chatNamespace.to(room);
  // The sender is in the room too, but its own client already has the message
  // from the REST response — keep it excluded, as the per-recipient fan-out was.
  if (excludeUserId) {
    target = target.except(getUserRoom(excludeUserId));
  }

  target.emit("receiveMessage", message);
}

function emitChatUpdatedToUser({ ioOrNamespace, recipientId, payload }) {
  const chatNamespace = getChatNamespace(ioOrNamespace);
  if (!chatNamespace) return;

  chatNamespace.to(getUserRoom(recipientId)).emit("chatUpdated", payload);
}

function emitMessageDeletedToConversation({ ioOrNamespace, room, messageId, conversationId }) {
  const chatNamespace = getChatNamespace(ioOrNamespace);
  if (!chatNamespace || !room) return;

  chatNamespace.to(room).emit("messageDeleted", {
    messageId,
    conversationId,
    messageContent: "This message has been deleted",
  });
}

/**
 * A clear only affects the user who asked for it, so this goes to that user's
 * own room and nobody else's — it's how their other devices drop the thread's
 * history without the peer ever seeing anything change.
 */
function emitChatClearedToUser({ ioOrNamespace, recipientId, conversationId, clearedAt }) {
  const chatNamespace = getChatNamespace(ioOrNamespace);
  if (!chatNamespace) return;

  chatNamespace.to(getUserRoom(recipientId)).emit("chatCleared", { conversationId, clearedAt });
}

function emitConversationDeletedToUser({ ioOrNamespace, recipientId, conversationId }) {
  const chatNamespace = getChatNamespace(ioOrNamespace);
  if (!chatNamespace) return;

  chatNamespace.to(getUserRoom(recipientId)).emit("conversationDeleted", { conversationId });
}

module.exports = {
  getChatNamespace,
  getUsersInRoom,
  emitMessageToConversation,
  emitChatUpdatedToUser,
  emitMessageDeletedToConversation,
  emitChatClearedToUser,
  emitConversationDeletedToUser,
};
