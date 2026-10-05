const mongoose = require('mongoose');

const { getUserRoom, resolveConversationRoom } = require("./chatSocketRooms");
const { markUserOnline, markUserOffline } = require("./chatPresenceRedis");
const {
  loadAndCacheConversationPeers,
  emitStatusToConversationPeers,
  clearConversationPeers,
} = require("./chatPresenceEmitter");
const { User } = require('../../../models/UserModel');
const { getUnreadCounts } = require('../services/conversationGateService');
const { sendUserNotifications } = require('../../controllers/communicationController');
const { NotificationTypes } = require('../../../models/Notifications');
const { getFullImageUrl } = require('../../../helperUtils/imageHelper');

const activeCallMap = new Map(); // userId -> partnerId (bidirectional call lock)

const chatSocketHandler = (io) => {
  io.on("connection", async (socket) => {
    let { subjectId, objectId, type } = socket.handshake.query;
 
    const { Types } = mongoose;
 
    if (!objectId) {
      console.log("Single User Socket Connect->", subjectId);
      if (!subjectId || !Types.ObjectId.isValid(subjectId)) {
        const errorMessage =
          "subjectId must be provided in query parameters and must be valid ObjectId.";
        socket.emit("error", { message: errorMessage });
        return;
      }
    } else if (!subjectId || !objectId || !Types.ObjectId.isValid(subjectId) || !Types.ObjectId.isValid(objectId)) {
      const errorMessage = "subjectId and objectId must be provided in query parameters and must be valid ObjectId.";
      socket.emit("error", { message: errorMessage });
      console.error(errorMessage);
      return;
    }
 
    let connectionType = "direct";
    if (!objectId) {
      connectionType = "self";
      objectId = subjectId;
    } else {
      connectionType = type || "direct";
    }
 
    const userRoom = getUserRoom(subjectId);
    socket.join(userRoom);

    // Send this user's unread counts across every conversation they're in as
    // soon as their socket connects.
    getUnreadCounts(subjectId)
      .then((counts) => socket.emit("unreadCounts", counts))
      .catch((err) => console.error(`Failed to load unread counts for ${subjectId}:`, err.message));

    const markFirstSocket = await markUserOnline(subjectId);
 
    if (markFirstSocket) {
      const peerIds = await loadAndCacheConversationPeers(subjectId);
      emitStatusToConversationPeers({ io, userId: subjectId, status: "online", peerIds });
    }
 
    const conversationRoom = resolveConversationRoom({
      subjectId,
      objectId,
      type: connectionType,
    });
 
    if (conversationRoom) {
      socket.join(conversationRoom);
    }
 
    // ── Chat listeners ─────────────────────────────────────────────────────
    if (connectionType === "direct") {
      socket.on("sendDirectMessage", async (messageData) => {
        const { messageContent, messageType, mediaUrl } = messageData;
        if (!conversationRoom) return;
        // Scoped to this pair's room, not the peer's account-wide user room —
        // the peer may have other threads open on other sockets.
        socket.to(conversationRoom).emit("receiveMessage", {
          objectId,
          subjectId,
          messageContent,
          messageType,
          mediaUrl,
        });
      });
    } else if (connectionType === "group") {
      socket.on("sendGroupMessage", async (messageData) => {
        const { messageContent, messageType, mediaUrl } = messageData;
        if (!conversationRoom) return;
        socket.to(conversationRoom).emit("receiveMessage", {
          objectId,
          subjectId,
          messageContent,
          messageType,
          mediaUrl,
        });
      });
    }
 
    // ==========================
    // CALL HELPERS
    // ==========================
    const setCallPair = (a, b) => {
      activeCallMap.set(String(a), String(b));
      activeCallMap.set(String(b), String(a));
    };
 
    const clearCallPair = (a, b) => {
      activeCallMap.delete(String(a));
      activeCallMap.delete(String(b));
    };
 
    const getPartner = (userId) => {
      return activeCallMap.get(String(userId)) || null;
    };
 
    const isUserBusy = (userId) => {
      return !!activeCallMap.get(String(userId));
    };
 
    // ==========================
    // CALL EVENTS
    // ==========================
 
    // CALL INITIATE
    socket.on("callUser", async ({ targetUserId, offer, callType = "audio" }) => {
      const callerId = subjectId;
      const calleeId = String(targetUserId);
 
      const normalizedCallType = callType === "video" ? "video" : "audio";
 
      console.log(`[CALL:${normalizedCallType}] ${callerId} -> ${calleeId}`);
 
      if (isUserBusy(callerId) || isUserBusy(calleeId)) {
        io.to(getUserRoom(callerId)).emit("callBusy", {
          targetUserId: calleeId,
          reason: "user_in_call",
          callType: normalizedCallType,
        });
        return;
      }
 
      const caller = await User.findById(callerId)
        .select("name profileIcon")
        .lean();
 
      io.to(getUserRoom(calleeId)).emit("incomingCall", {
        callerId,
        callerName: caller?.name || "Unknown",
        callerAvatar: getFullImageUrl(caller?.profileIcon) || "",
        offer,
        callType: normalizedCallType,
      });
 
      await sendUserNotifications({
        recipientIds: [calleeId],
        title: normalizedCallType === "video" ? "Incoming Video Call" : "Incoming Audio Call",
        body: `${caller?.name || "Someone"} is calling you`,
        data: {
          type: "incoming_call",
          objectType: "call",
          callType: normalizedCallType,
          callerId,
          callerName: caller?.name || "Unknown",
          callerAvatar: getFullImageUrl(caller?.profileIcon) || "",
          // offer: JSON.stringify(offer),
        },
        notificationType: NotificationTypes.SYSTEM,
        sender: subjectId,
        objectId: subjectId,
        saveNotification: true,
      });
    });
 
    // CALL ACCEPT
    socket.on("answerCall", ({ targetUserId, answer, callType = "audio" }) => {
      const calleeId = subjectId;
      const callerId = String(targetUserId);
 
      const normalizedCallType = callType === "video" ? "video" : "audio";
 
      console.log(`[CALL ANSWERED:${normalizedCallType}] ${calleeId} -> ${callerId}`);
 
      if (getPartner(callerId) || getPartner(calleeId)) {
        return;
      }
 
      setCallPair(callerId, calleeId);
 
      io.to(getUserRoom(callerId)).emit("callAnswered", {
        answer,
        calleeId,
        callType: normalizedCallType,
      });
 
      socket.to(getUserRoom(calleeId)).emit("callAnsweredElsewhere", {
        callerId,
        callType: normalizedCallType,
      });
    });
 
    // ✅ ICE CANDIDATE - WITH LOGGING
    socket.on("iceCandidate", ({ targetUserId, candidate }) => {
      console.log('🧊 [SERVER] ICE candidate received');
      console.log('  From:', subjectId);
      console.log('  For:', String(targetUserId));
      console.log('  Candidate type:', candidate?.candidate?.split(' ')[7] || 'unknown');
 
      const targetRoom = getUserRoom(String(targetUserId));
      io.to(targetRoom).emit("iceCandidate", {
        candidate,
        fromUserId: subjectId,
      });
 
      console.log('  ✅ ICE forwarded to room:', targetRoom);
    });
 
    // REJECT CALL
    socket.on("rejectCall", ({ targetUserId, callType = "audio" }) => {
      const callerId = String(targetUserId);
      const rejecterId = subjectId;
      const normalizedCallType = callType === "video" ? "video" : "audio";
 
      const partner = getPartner(rejecterId);
      if (partner) clearCallPair(rejecterId, partner);
 
      clearCallPair(rejecterId, callerId);
      clearCallPair(callerId, rejecterId);
 
      io.to(getUserRoom(callerId)).emit("callRejected", {
        by: rejecterId,
        callType: normalizedCallType,
      });
 
      socket.to(getUserRoom(rejecterId)).emit("callAnsweredElsewhere", {
        callerId,
        callType: normalizedCallType,
      });
    });
 
    // END CALL
    socket.on("endCall", ({ targetUserId, callType = "audio" }) => {
      const otherUserId = String(targetUserId);
      const userId = subjectId;
      const normalizedCallType = callType === "video" ? "video" : "audio";
 
      const partner = getPartner(userId);
      if (partner) clearCallPair(userId, partner);
 
      clearCallPair(userId, otherUserId);
      clearCallPair(otherUserId, userId);
 
      io.to(getUserRoom(otherUserId)).emit("callEnded", {
        by: userId,
        callType: normalizedCallType,
      });
 
      if (partner && partner !== otherUserId) {
        io.to(getUserRoom(partner)).emit("callEnded", {
          by: userId,
          callType: normalizedCallType,
        });
      }
    });
 
    // ✅ MERGED DISCONNECT - HANDLES BOTH CALL AND CHAT CLEANUP
    socket.on("disconnect", async () => {
      console.log(`[DISCONNECT] ${subjectId}`);
 
      // CALL cleanup
      const partnerId = getPartner(subjectId);
      if (partnerId) {
        clearCallPair(subjectId, partnerId);
        io.to(getUserRoom(partnerId)).emit("callEnded", {
          by: subjectId,
        });
      }
 
      // CHAT cleanup
      const isLastSocket = await markUserOffline(subjectId);
      if (isLastSocket) {
        await emitStatusToConversationPeers({
          io,
          userId: subjectId,
          status: "offline",
        });
        await clearConversationPeers(subjectId);
      }
    });
 
  });
};

module.exports = chatSocketHandler;