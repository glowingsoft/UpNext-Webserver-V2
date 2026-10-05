const Conversation = require("../models/Conversation");
const {
  cacheConversationPeers,
  getConversationPeers,
  clearConversationPeers,
} = require("./chatPresenceRedis");
const { getUserRoom } = require("./chatSocketRooms");

/**
 * Query all direct-conversation peer IDs for a user from MongoDB,
 * then cache them in Redis so subsequent lookups never hit the DB.
 *
 * Called once per user on their FIRST socket connection.
 */
async function loadAndCacheConversationPeers(userId) {
  const userIdStr = String(userId);

  try {
    // Find all direct conversations this user participates in
    const conversations = await Conversation.find(
      {
        type: "direct",
        "participants.user": userId,
        isDeleted: { $ne: true },
      },
      { participants: 1, _id: 0 }
    ).lean();

    // Extract the OTHER participant's id from each conversation
    const peerIds = conversations
      .flatMap((conv) => conv.participants)
      .filter((p) => p.user.toString() !== userIdStr)
      .map((p) => p.user.toString());

    const uniquePeerIds = [...new Set(peerIds)];

    await cacheConversationPeers(userId, uniquePeerIds);

    return uniquePeerIds;
  } catch (error) {
    console.error(
      "Failed to load/cache conversation peers for user",
      userIdStr,
      error.message
    );
    return [];
  }
}

/**
 * Emit a userStatusChanged event to all conversation peers of a user.
 *
 * status: "online" | "offline"
 *
 * On connect  → call with status "online"  (peers already cached here)
 * On disconnect → call with status "offline" (reads from Redis, no DB query)
 */
async function emitStatusToConversationPeers({ io, userId, status, peerIds }) {
  if (!io) return;

  const userIdStr = String(userId);

  // Allow caller to pass already-loaded peers to avoid a second Redis read
  const recipients =
    peerIds && peerIds.length > 0
      ? peerIds
      : await getConversationPeers(userId);

  if (recipients.length === 0) return;

  const payload = {
    userId: userIdStr,
    status, // "online" | "offline"
    timestamp: Date.now(),
  };

  const chatNamespace =
    typeof io.of === "function" ? io.of("/chat") : io;

  recipients.forEach((peerId) => {
    chatNamespace
      .to(getUserRoom(peerId))
      .emit("userStatusChanged", payload);
  });
}

module.exports = {
  loadAndCacheConversationPeers,
  emitStatusToConversationPeers,
  clearConversationPeers,
};
