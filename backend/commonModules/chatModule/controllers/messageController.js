const Message = require("../models/Message");
const { safeKeyword } = require("@helperUtils/regexUtil");
const mongoose = require("mongoose");
const moment = require("moment");
const Conversation = require("../models/Conversation");

const {
  sendResponse,
  parsePaginationParams,
  generateMeta,
  validateParams,
  convertUtcToTimezone,
} = require("@helperUtils/responseUtil");

const { NotificationTypes } = require("../../../models/Notifications");
const { getFullImageUrl } = require("@utils/imageHelper");

const {
  getChatNamespace,
  getUsersInRoom,
  emitMessageToConversation,
  emitChatUpdatedToUser,
  emitMessageDeletedToConversation,
  emitChatClearedToUser,
  emitConversationDeletedToUser,
} = require("../sockets/chatEventEmitter");
const { getDirectRoom, getGroupRoom } = require("../sockets/chatSocketRooms");
const { getUsersOnlineMap } = require("../sockets/chatPresenceRedis");
const { resolveActiveBooking, getUnreadCounts } = require("../services/conversationGateService");
const { sendUserNotifications } = require("../../controllers/communicationController");
// const { logEngagementService } = require("../../appEngagement/engagementEventsService");
const { User } = require("@models/UserModel.js");
const { resolveChatIdentity } = require("../services/chatIdentityService");

/**
 * The header state a chat screen needs the moment it opens — whether the
 * composer is allowed, and whether the peer is online.
 *
 * fetchChats already computes both, but a client arriving from a push
 * notification never went through the list: it deep-links straight into the
 * thread, so it had no way to learn either without refetching the whole
 * conversation list. Same rules as the list so the two can't disagree.
 */
const buildChatContext = async ({ conversation, userId }) => {
  const isDirect = conversation.type === "direct";

  // participants.user is an ObjectId on a lean doc; String() covers both that
  // and a populated participant.
  const peerId = isDirect
    ? conversation.participants.find(
        (p) => String(p.user?._id || p.user) !== String(userId),
      )?.user
    : null;

  // Either side blocking closes messaging for both — matches sendMessage.
  const isBlocked = isDirect && (conversation.participants || []).some((p) => p.chatState === "blocked");

  const onlineMap = peerId ? await getUsersOnlineMap([peerId]) : null;

  return {
    conversationId: conversation._id,
    type: conversation.type,
    // "closed" is the booking gate: a direct chat is closed once no active
    // booking remains between the pair, and reopens when a new one is made.
    chatStatus: isDirect ? conversation.chatStatus : null,
    isBlocked,
    canMessage: isDirect
      ? conversation.chatStatus !== "closed" && !isBlocked
      : conversation.groupSettings?.canMessage ?? false,
    peer: peerId
      ? {
          _id: peerId,
          // Point-in-time; "userStatusChanged" on /chat keeps it current while
          // the screen stays open.
          isOnline: Boolean(onlineMap.get(String(peerId))),
        }
      : null,
  };
};

const fetchChats = async (req, res) => {
  const { _id: userId, timezone, userType } = req.user;
  const { page, limit } = parsePaginationParams(req);
  const { keyword, chatState } = req.query;

  try {
    const chatStateMap = {
      inbox: ["default", "favorite"],
      favorite: ["favorite"],
      archived: ["archived"],
      blocked: ["blocked"],
    };

    const allowedStates = chatStateMap[chatState] || ["default", "favorite"];

    const baseMatch = {
      participants: {
        $elemMatch: {
          user: userId,
          chatState: { $in: allowedStates },
        },
      },
    };

    const keywordFilter = keyword?.trim()
      ? {
        $or: [
          { groupName: { $regex: safeKeyword(keyword), $options: "i" } },
          {
            $and: [
              { type: "direct" },
              {
                userDetails: {
                  $elemMatch: {
                    _id: { $ne: userId },
                    name: { $regex: safeKeyword(keyword), $options: "i" },
                  },
                },
              },
            ],
          },
        ],
      }
      : null;

    const sharedPipeline = [
      { $match: baseMatch },

      {
        $addFields: {
          currentParticipant: {
            $first: {
              $filter: {
                input: "$participants",
                as: "participant",
                cond: {
                  $eq: ["$$participant.user", new mongoose.Types.ObjectId(userId)],
                },
              },
            },
          },
        },
      },

      {
        $lookup: {
          from: "users",
          localField: "participants.user",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      // A direct conversation is always customer<->business. Which identity
      // to show for "the other side" depends on who's asking (the requesting
      // user's own userType), not on which participant happens to own an
      // active profile — a dual-role account (has both a UserProfile and an
      // active BusinessProfile) would otherwise leak its business identity
      // into a business-to-business-looking chat row.
      {
        $lookup: {
          from: "businessprofiles",
          let: { participantIds: "$participants.user" },
          pipeline: [
            { $match: { $expr: { $and: [{ $in: ["$user", "$$participantIds"] }, { $eq: ["$status", "active"] }] } } },
            { $project: { user: 1, businessName: 1, image: 1, description: 1 } },
          ],
          as: "businessProfileDetails",
        },
      },
      {
        $lookup: {
          from: "userprofiles",
          let: { participantIds: "$participants.user" },
          pipeline: [
            { $match: { $expr: { $and: [{ $in: ["$user", "$$participantIds"] }, { $eq: ["$status", "active"] }] } } },
            { $project: { user: 1, description: 1 } },
          ],
          as: "userProfileDetails",
        },
      },
      {
        $lookup: {
          from: "messages",
          localField: "lastMessage",
          foreignField: "_id",
          as: "lastMessageData",
        },
      },
      {
        $unwind: {
          path: "$lastMessageData",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "lastMessageData.senderId",
          foreignField: "_id",
          as: "lastMessageSender",
        },
      },
      {
        $unwind: {
          path: "$lastMessageSender",
          preserveNullAndEmptyArrays: true,
        },
      },
      // Last 5 bookings tied to this thread, resolved live off Booking so
      // name/status are never stale — bookingIds itself just stores refs.
      {
        $addFields: {
          recentBookingIds: { $slice: ["$bookingIds", -5] },
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "recentBookingIds",
          foreignField: "_id",
          as: "recentBookingsData",
        },
      },
    ];

    // Pipeline for paginated data
    const paginatedPipeline = [
      ...sharedPipeline,
      ...(keywordFilter ? [{ $match: keywordFilter }] : []),
      // Same reason as the message sort: _id keeps conversations with an
      // identical updatedAt from reshuffling across paged calls.
      { $sort: { updatedAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ];

    // Pipeline for total count
    const countPipeline = [
      ...sharedPipeline,
      ...(keywordFilter ? [{ $match: keywordFilter }] : []),
      { $count: "count" },
    ];

    const [conversations, countResult] = await Promise.all([
      Conversation.aggregate(paginatedPipeline),
      Conversation.aggregate(countPipeline),
    ]);

    const totalConversations = countResult[0]?.count || 0;

    const directPeerUserIds = conversations
      .filter((conv) => conv.type === "direct")
      .map((conv) =>
        conv.userDetails.find((u) => u._id.toString() !== userId.toString())?._id
      )
      .filter(Boolean)
      .map((id) => id.toString());

    const onlineMap = await getUsersOnlineMap(directPeerUserIds);

    const formattedChats = conversations.map((conv) => {
      const unreadCounts = new Map(Object.entries(conv.unreadCounts || {}));
      let objectId, chatName, chatIcon, chatDescription, otherUser = null, currentUser = null;

      if (conv.type === "direct") {
        otherUser = conv.userDetails.find(
          (u) => u._id.toString() !== userId.toString()
        );
        objectId = otherUser?._id || null;

        if (userType === "business") {
          // Viewer is the business side — always show the other participant's
          // own (customer) identity, even if that account also happens to
          // hold an active BusinessProfile from switching roles elsewhere.
          const otherUserProfile = (conv.userProfileDetails || []).find(
            (up) => String(up.user) === String(otherUser?._id)
          );

          chatName = otherUser?.name || "Unknown";
          chatIcon = otherUser?.profileIcon || null;
          chatDescription = otherUserProfile?.description || null;
        } else {
          // Viewer is the customer side — always show the other participant's
          // business identity.
          const otherBusinessProfile = (conv.businessProfileDetails || []).find(
            (bp) => String(bp.user) === String(otherUser?._id)
          );

          chatName = otherBusinessProfile?.businessName || otherUser?.name || "Unknown";
          chatIcon = otherBusinessProfile?.image || otherUser?.profileIcon || null;
          chatDescription = otherBusinessProfile?.description || null;
        }
      } else {
        objectId = conv._id;
        chatName = conv.groupName || "Unnamed Group";
        chatIcon = conv.groupMetadata?.image || null;
        chatDescription = conv.groupMetadata?.description || null;
      }

      // The conversation still points at its real last message (the peer needs
      // it), so a viewer who cleared the thread gets an empty preview rather
      // than the message they just cleared away.
      const viewerClearedAt = conv.currentParticipant?.clearedAt;
      const rawLastMsg = conv.lastMessageData || {};
      const lastMsg =
        viewerClearedAt && rawLastMsg.createdAt && rawLastMsg.createdAt <= viewerClearedAt
          ? {}
          : rawLastMsg;

      const localDate = lastMsg.createdAt
        ? convertUtcToTimezone(lastMsg.createdAt, timezone)
        : null;
      const timesince = localDate ? moment(localDate).fromNow() : null;

      // Either side blocking closes messaging for both — matches sendMessage.
      const isBlocked =
        conv.type === "direct" &&
        (conv.participants || []).some((p) => p.chatState === "blocked");

      const bookingsById = new Map((conv.recentBookingsData || []).map((b) => [String(b._id), b]));
      const bookingIds = (conv.recentBookingIds || [])
        .map((id) => {
          const booking = bookingsById.get(String(id));
          if (!booking) return null;
          return { _id: booking._id, name: booking.target?.[0]?.name ?? null, status: booking.status };
        })
        .filter(Boolean);

      return {
        conversationId: conv._id,
        type: conv.type,
        objectId,
        chatName,
        // Concatenating the base blindly doubled it on rows that stored a full
        // URL, and mangled external (OAuth) avatars — getFullImageUrl only
        // prefixes a bare key.
        chatIcon: chatIcon ? getFullImageUrl(chatIcon) : null,
        chatDescription,
        chatState: conv.currentParticipant?.chatState || "default",

        isOnline:
          conv.type === "direct" && objectId
            ? Boolean(onlineMap.get(objectId.toString()))
            : false,
        lastMessage: {
          _id: lastMsg._id,
          messageContent: lastMsg.messageContent,
          messageType: lastMsg.messageType,
          // Sender comes from a separate $lookup, so it has to be suppressed
          // alongside the preview when the viewer has cleared the thread.
          senderId: lastMsg._id ? conv.lastMessageSender?._id : undefined,
          senderName: lastMsg._id ? conv.lastMessageSender?.name : undefined,
          timesince,
        },
        unreadCount: unreadCounts.get(userId.toString()) || 0,
        // Mirrors sendMessage's block gate so the client can hide the composer
        // instead of finding out via a 403.
        canMessage: conv.type === "direct"
          ? conv.chatStatus !== "closed" && !isBlocked
          : conv.groupSettings?.canMessage ?? false,
        bookingIds,
      };
    });

    const { total: totalUnreadCounts } = await getUnreadCounts(userId);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Chats fetched successfully",
      data: formattedChats,
      meta: { ...generateMeta(page, limit, totalConversations), totalUnreadCounts },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "Error fetching chats",
      error,
    });
  }
};


// Fetch messages (pagination)
const fetchMessages = async (req, res) => {
  const { _id: userId, timezone } = req.user;
  let { conversationId, objectId } = req.query;
  const { page, limit } = parsePaginationParams(req);

  try {
    let conversation = null;
    if (conversationId) {
      conversation = await Conversation.findById(conversationId).lean();
    } else if (objectId) {
      // Find the conversation for direct chat with the other user
      conversation = await Conversation.findOne({
        type: "direct",
        "participants.user": { $all: [userId, objectId] }, // Ensure both users are participants
        $expr: { $eq: [{ $size: "$participants" }, 2] }, // Ensure there are exactly 2 participants
      }).lean();
      conversationId = conversation?._id; // Set conversationId from found conversation
    } else {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "Conversation ID or Object ID is required",
      });
    }
    if (!conversation) {
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "Messages fetched successfully",
        data: [],
        meta: { ...generateMeta(page, limit, 0), chat: null },
      });
    }

    if (
      !conversation.participants.some(
        (p) => p.user._id.toString() === userId.toString()
      )
    ) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "Access denied to conversation",
      });
    }

    // Anything the viewer cleared stays in the DB (the peer still has it) but
    // must never come back to this viewer — scope both the page and the count.
    const clearedAt = conversation.participants.find(
      (p) => p.user._id.toString() === userId.toString()
    )?.clearedAt;

    const messageFilter = {
      conversationId,
      ...(clearedAt ? { createdAt: { $gt: clearedAt } } : {}),
    };

    const messages = await Message.find(messageFilter)
      // _id breaks createdAt ties so the order is total — without it, messages
      // sharing a timestamp can swap between pages and across refetches.
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Fetching this page is what marks these messages read for the viewer, so
    // the receipt covers exactly what was delivered — scoping by the page's ids
    // also inherits the clearedAt cutoff already applied by messageFilter.
    const pageIds = messages.map((m) => m._id);
    const markRead = pageIds.length
      ? Message.updateMany(
        { _id: { $in: pageIds }, senderId: { $ne: userId }, "readBy.userId": { $ne: userId } },
        { $push: { readBy: { userId, readAt: new Date() } } },
      )
      : Promise.resolve();

    // Unread count then follows from what is genuinely still unread rather than
    // being zeroed outright — older pages the viewer never loaded still count.
    // Fire-and-forget, as before.
    //
    // timestamps:false matters as much as the write itself. Conversation is a
    // timestamped schema and fetchChats sorts on updatedAt, so stamping it here
    // would let merely OPENING a thread jump it to the top of the list — the
    // list is ordered by conversation activity, and reading is not activity.
    // The $ne guard keeps it a no-op when the count hasn't actually moved.
    markRead
      .then(() =>
        Message.countDocuments({
          ...messageFilter,
          senderId: { $ne: userId },
          "readBy.userId": { $ne: userId },
        })
      )
      .then((remaining) =>
        Conversation.updateOne(
          { _id: conversationId, [`unreadCounts.${userId}`]: { $ne: remaining } },
          { $set: { [`unreadCounts.${userId}`]: remaining } },
          { timestamps: false }
        )
      )
      .catch(() => { });

    const [totalMessages, chat] = await Promise.all([
      Message.countDocuments(messageFilter),
      buildChatContext({ conversation, userId }),
    ]);

    const formattedMessages = messages.map((msg) => {
      const localDate = convertUtcToTimezone(msg.createdAt, timezone);
      const alreadyRead = msg.readBy.some((r) => String(r.userId) === String(userId));
      // Reflects the mark-as-read write just fired above rather than waiting on it —
      // a sender is always considered to have "read" their own message.
      const isRead = alreadyRead || msg.senderId.toString() === userId.toString();

      return {
        ...msg,
        timesince: moment(localDate).fromNow(),
        isRead, // Whether the message has been read by the current user
      };
    });

    formattedMessages.forEach((msg) => {
      delete msg.readBy; // Optional: remove the readBy array if it's not needed in the response
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Messages fetched successfully",
      data: formattedMessages,
      meta: { ...generateMeta(page, limit, totalMessages), chat },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "Error fetching messages",
      error: error.message,
    });
  }
};

const sendMessage = async (req, res) => {
  const { _id: senderId, timezone } = req.user;
  const { conversationId } = req.body;
  let messageType,
    messageContent,
    mediaUrl,
    participantIds,
    conversationType,
    groupName,
    participantId,
    bookingId;

  if (req.body.conversationType === "group") {
    // Params for group chat
    ({
      messageType,
      messageContent = "",
      mediaUrl = null,
      participantIds =[],
      conversationType = "group",
      groupName,
    } = req.body);
  } else if (req.body.conversationType === "direct") {
    // Params for direct chat (default)
    ({
      messageType,
      messageContent = "",
      mediaUrl = null,
      participantId = "",
      conversationType = "direct",
      bookingId = null,
    } = req.body);
  }

  try {
    let conversation;

    // For 1-to-1 direct chat: find or create conversation between two users
    if (conversationType === "direct") {
      //if conversationId is provided, find the conversation
      if (conversationId) {
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
          return sendResponse({
            res,
            statusCode: 400,
            translationKey: "Invalid conversation ID",
          });
        }
        conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return sendResponse({
            res,
            statusCode: 404,
            translationKey: "Direct conversation not found",
          });
        }

        const otherParticipant = conversation.participants.find(
          (p) => p.user.toString() !== senderId.toString()
        );
        const gate = await resolveActiveBooking({
          userId: senderId,
          otherUserId: otherParticipant?.user,
          bookingId,
        });
        if (gate.error) {
          return sendResponse({
            res,
            statusCode: 403,
            translationKey: gate.error,
          });
        }

        conversation.chatStatus = "open";
        if (!conversation.bookingIds.some((id) => id.toString() === gate.bookingId.toString())) {
          conversation.bookingIds.push(gate.bookingId);
        }
      } else {
        participantIds = participantId ? [participantId] : []; // Ensure participantIds is an array
        if (!participantIds.length || participantIds.length !== 1) {
          return sendResponse({
            res,
            statusCode: 400,
            translationKey:
              "Must provide exactly one participant for direct chat",
          });
        }

        const otherUserId = participantIds[0];

        const gate = await resolveActiveBooking({
          userId: senderId,
          otherUserId,
          bookingId,
        });
        if (gate.error) {
          return sendResponse({
            res,
            statusCode: 403,
            translationKey: gate.error,
          });
        }

        // Find existing direct conversation between these two users
        conversation = await Conversation.findOne({
          type: "direct",
          "participants.user": { $all: [senderId, otherUserId] }, // Ensure both users are in participants array
          $expr: { $eq: [{ $size: "$participants" }, 2] }, // Ensure there are exactly 2 participants
        });

        if (!conversation) {
          // Create new direct conversation if not found
          conversation = await Conversation.create({
            type: "direct",
            participants: [
              { user: senderId, role: "admin" }, // Role for the sender (can be admin or member)
              { user: otherUserId, role: "member" }, // Role for the other participant
            ],
            unreadCounts: { [senderId]: 0, [otherUserId]: 0 }, // Initialize unread counts for both users
            bookingIds: [gate.bookingId],
            chatStatus: "open",
          });
        } else {
          conversation.chatStatus = "open";
          if (!conversation.bookingIds.some((id) => id.toString() === gate.bookingId.toString())) {
            conversation.bookingIds.push(gate.bookingId);
          }
        }
      }
    } else if (conversationType === "group") {
      // Handle group messages
      if (conversationId) {
        conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return sendResponse({
            res,
            statusCode: 404,
            translationKey: "Group conversation not found",
          });
        }
      } else {
        if (!groupName) {
          return sendResponse({
            res,
            statusCode: 400,
            translationKey: "Group name required for new group chat",
          });
        }

        // Create a new group conversation
        conversation = await Conversation.create({
          type: "group",
          groupName,
          participants: [
            { user: senderId, role: "admin" }, // Admin role for the creator of the group
            ...(Array.isArray(participantIds) && participantIds.length
              ? participantIds.map((id) => ({ user: id, role: "member" }))
              : []), // Set other participants as members if provided
          ],
          admins: [senderId], // Add creator as the admin
          unreadCounts: {}, // Will be updated below
        });
      }
    } else {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "Unsupported conversation type",
      });
    }

    // Block gate. "blocked" is only a participant chatState, and nothing used
    // to consult it on the write path, so blocking was cosmetic. Reversed by
    // setting chatState back to "default". Groups are exempt: one member
    // blocking a thread must not mute the whole room for everyone else.
    if (conversation.type === "direct") {
      const senderParticipant = conversation.participants.find(
        (p) => p.user.toString() === senderId.toString()
      );

      if (senderParticipant?.chatState === "blocked") {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "chat_blocked_by_you",
        });
      }

      const blockedByPeer = conversation.participants.some(
        (p) => p.user.toString() !== senderId.toString() && p.chatState === "blocked"
      );
      if (blockedByPeer) {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "chat_blocked_by_peer",
        });
      }
    }

    // Create the message
    const message = await Message.create({
      conversationId: conversation._id,
      senderId,
      messageType,
      messageContent,
      mediaUrl,
      readBy: [{ userId: senderId, readAt: new Date() }],
    });

    // Log engagement
    // void logEngagementService({
    //   entityType: "message",
    //   entityId: message._id,
    //   ownerUserId: senderId,
    //   eventType: "message",
    //   userId: senderId,
    // }).catch(console.error);

    // Update conversation with last message and unread counts
    conversation.lastMessage = message._id;
    conversation.participants.forEach((p) => {
      if (p.user.toString() !== senderId.toString()) {
        const count = conversation.unreadCounts.get(p.user.toString()) || 0;
        conversation.unreadCounts.set(p.user.toString(), count + 1);
      }
    });
    await conversation.save();

    const localDate = moment(message.createdAt).tz(timezone).format();
    let messageObject = {
      ...message.toObject(),
      timesince: moment(localDate).fromNow(),
      // Carried on every payload (receiveMessage and chatUpdated alike) so a
      // client can always tell which thread a message belongs to.
      conversationId: conversation._id.toString(),
      conversationType: conversation.type,
    };

    // Background task for emitting messages and notifications
    const handleBackgroundTask = async () => {
      try {
        // For direct chat, objectId is the other user's ID
        // For group chat, objectId is the group/conversation ID
        let objectId, subjectId;

        if (conversation.type === "direct") {
          const otherUser = conversation.participants.find(
            (p) => p.user.toString() !== senderId.toString()
          );
          objectId = otherUser?.user?._id.toString(); // Other user in direct conversation
          subjectId = senderId.toString();
        } else {
          objectId = conversation._id.toString(); // Use conversation ID for group chats
          subjectId = senderId.toString();
        }

        const chatNamespace = getChatNamespace(req.io || global.io);
        if (!chatNamespace) {
          throw new Error("Chat socket namespace is not initialized");
        }

        // For group chat, we need to loop over all participants
        const recipientIds = conversation.participants
          .filter((p) => p.user.toString() !== senderId.toString()) // Exclude sender
          .map((p) => p.user.toString()); // Get an array of recipient IDs for group chat

        // Only recipients who have THIS specific conversation's room open
        // right now count as having seen it — merely being connected to the
        // app elsewhere (e.g. sitting on the home screen) must NOT zero out
        // their unread count or mark the message read for them.
        const conversationRoom = conversation.type === "group"
          ? getGroupRoom(conversation._id)
          : getDirectRoom(senderId.toString(), recipientIds[0]);

        const viewingRecipientIds = await getUsersInRoom(
          chatNamespace,
          recipientIds,
          conversationRoom
        );

        if (viewingRecipientIds.length > 0) {
          viewingRecipientIds.forEach((id) => {
            conversation.unreadCounts.set(id, 0);
          });
          const newReadEntries = viewingRecipientIds.map((id) => ({ userId: id, readAt: new Date() }));
          await Message.updateOne(
            { _id: message._id },
            { $push: { readBy: { $each: newReadEntries } } },
          );
          // Keep the payload broadcast below (receiveMessage/chatUpdated) in
          // sync with this write — otherwise recipients who were live-viewing
          // would still see the message's stale pre-update readBy.
          messageObject.readBy = [...(messageObject.readBy || []), ...newReadEntries];
        }

        // Who still needs telling. A recipient sitting in this conversation has
        // already had the message pushed to them live and marked read just
        // above, so notifying them would buzz about something they are looking
        // at. Anyone merely connected elsewhere in the app — the home screen,
        // a different thread — is not "in the chat" and still gets notified:
        // their unread count went up and nothing put the message in front of
        // them.
        const viewingSet = new Set(viewingRecipientIds.map(String));

        // A recipient who has archived this thread has filed it away on
        // purpose, so it must stay silent for them: their unread count and the
        // live socket updates above still fire (the thread is muted, not
        // deleted, and reappears the moment they unarchive it), but no push
        // notification goes out. Archiving is per participant, so on a group
        // this only mutes the member who archived it.
        const archivedSet = new Set(
          conversation.participants
            .filter((p) => p.chatState === "archived")
            .map((p) => p.user.toString())
        );

        const notifyRecipientIds = recipientIds.filter(
          (id) => !viewingSet.has(String(id)) && !archivedSet.has(String(id))
        );

        // Always reset sender's unread count
        conversation.unreadCounts.set(senderId.toString(), 0);

        // Save conversation once after all updates — awaited (still inside
        // the fire-and-forget background task, so no request latency cost)
        // so the totalUnreadCount computed below via a fresh DB query below
        // isn't racing this same conversation's own write.
        await conversation.save().catch(() => { });

        emitMessageToConversation({
          ioOrNamespace: chatNamespace,
          room: conversationRoom,
          excludeUserId: senderId.toString(),
          message: messageObject,
        });

        // chatName/chatIcon ride inside messageContent, so every viewer gets its
        // own copy rather than one shared object stamped with the sender's
        // identity. Which identity a thread wears depends on who is reading it
        // — the same rule fetchChats and the push notification both apply — and
        // the sender's own client is looking at the peer, not at itself.
        const withChatIdentity = ({ chatName, chatIcon }) => ({ ...messageObject, chatName, chatIcon });

        // Emit chatUpdated to recipients in their personal user rooms.
        await Promise.all(recipientIds.map(async (recipientId) => {
          const unreadCount = conversation.unreadCounts.get(recipientId) || 0;
          const [{ total: totalUnreadCount }, identity] = await Promise.all([
            getUnreadCounts(recipientId),
            resolveChatIdentity({ conversation, senderId, recipientId }),
          ]);

          emitChatUpdatedToUser({
            ioOrNamespace: chatNamespace,
            recipientId,
            payload: {
              type: "newMessage",
              subjectId,
              objectId,
              senderName: req.user.name,
              messageContent: withChatIdentity(identity),
              unreadCount,
              totalUnreadCount,
            },
          });
        }));

        // Also notify the sender's own client, so its conversation list
        // updates off the same "chatUpdated" path as a recipient's rather
        // than relying on the REST response to patch local state. Its copy is
        // named for the peer — on a direct thread objectId is that peer, and a
        // group resolves to the group regardless of who is passed.
        const [{ total: senderTotalUnreadCount }, senderIdentity] = await Promise.all([
          getUnreadCounts(senderId),
          resolveChatIdentity({ conversation, senderId: objectId, recipientId: senderId }),
        ]);
        emitChatUpdatedToUser({
          ioOrNamespace: chatNamespace,
          recipientId: senderId,
          payload: {
            type: "newMessage",
            subjectId,
            objectId,
            senderName: req.user.name,
            messageContent: withChatIdentity(senderIdentity),
            unreadCount: 0,
            totalUnreadCount: senderTotalUnreadCount,
          },
        });

        const user = await User.findById(senderId).select("name -_id").lean();
        console.log("user",user );

        // Everyone is in the thread already — nothing left to announce.
        if (notifyRecipientIds.length === 0) return;

        // Send notifications to the group participants who aren't in the thread
        if (conversation.type === "group") {
          const { chatName, chatIcon } = await resolveChatIdentity({ conversation, senderId });

          await sendUserNotifications({
            recipientIds: notifyRecipientIds,
            title: "New Message",
            body: `You received a new message: ${messageContent}`,
            data: {
              type: NotificationTypes.NEW_MESSAGE,
              objectType: "group",
              conversationId: conversation._id.toString(),
              // The group's own name/image — identical for every member.
              chatName,
              chatIcon,
            },
            sender: subjectId,
            objectId: objectId,
          });
        }

        // If it's a direct message, send a notification to the other user
        if (conversation.type === "direct") {
          // Resolved against the recipient, not the sender: which of the two
          // identities the sender presents depends on which side is reading it.
          const { chatName, chatIcon } = await resolveChatIdentity({
            conversation,
            senderId,
            recipientId: objectId,
          });

          await sendUserNotifications({
            // The one other participant, and only because the check above
            // established they do not have this thread open.
            recipientIds: notifyRecipientIds,
            title: "New Message",
            body: `You received a new message: ${messageContent}`,
            // objectId on a direct notification is the RECIPIENT's own user id
            // (it's the "other user" from the sender's point of view), so it
            // can't identify the thread to open — the sender is `subjectId`,
            // and conversationId deep-links without any inference at all.
            data: {
              type: NotificationTypes.NEW_MESSAGE,
              objectType: "user",
              conversationId: conversation._id.toString(),
              chatName,
              chatIcon,
            },
            sender: subjectId,
            objectId: objectId,
          });
        }
      } catch (error) {
        console.error("Error in background task:", error);
      }
    };
    // Execute background task
    handleBackgroundTask();

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "Message sent successfully",
      data: messageObject,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "Error sending message",
      error: error,
    });
  }
};

//add participant to group chat
const addParticipantToGroup = async (req, res) => {
  const { _id: userId } = req.user;
  const { conversationId } = req.params;
  let { participants } = req.body;

  // Ensure participants is always an array
  if (!Array.isArray(participants)) {
    participants = participants ? [participants] : [];
  }

  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "Invalid conversation ID",
    });
  }
  if (!participants.length) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "No participant IDs provided",
    });
  }
  // Validate all participant IDs
  for (const id of participants) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: `Invalid participant ID: ${id}`,
      });
    }
  }
  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "Conversation not found",
      });
    }
    if (conversation.type !== "group") {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "Only group conversations can have participants added",
      });
    }
    if (!conversation.participants.some((p) => p.user.toString() === userId)) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "You do not have permission to add participants",
      });
    }
    // Filter out participant IDs already in the group
    const existingIds = conversation.participants.map((p) => p.user.toString());
    const newParticipantIds = participants.filter(
      (id) => !existingIds.includes(id)
    );
    if (!newParticipantIds.length) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey:
          newParticipantIds.length === 1
            ? "Participant is already in the group"
            : "All participants are already in the group",
      });
    }
    // Add new participants
    newParticipantIds.forEach((id) => {
      conversation.participants.push({
        user: id,
        role: "member",
        isActive: true,
      });
      conversation.unreadCounts.set(id.toString(), 0);
    });
    await conversation.save();
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Participants added to group successfully",
      data: {
        conversationId: conversation._id,
        participantIds: newParticipantIds,
      },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "Error adding participants",
      error: error.message,
    });
  }
};

// Delete a chat
const deleteChat = async (req, res) => {
  const { _id: userId } = req.user;
  const { conversationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "Invalid conversation ID",
    });
  }

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "Conversation not found",
      });
    }

    // Check if the user is a participant in the conversation
    if (
      !conversation.participants.some(
        (p) => p.user.toString() === userId.toString()
      )
    ) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "You do not have permission to delete this chat",
      });
    }
    // Delete all messages and the conversation in parallel
    await Promise.all([
      Message.deleteMany({ conversationId }),
      Conversation.findByIdAndDelete(conversationId),
    ]);

    // Notify every participant, including the deleter's own room — one
    // "conversationDeleted" code path for actor and recipients alike,
    // instead of the deleter relying on the REST response to update its list.
    try {
      const chatNamespace = getChatNamespace(req.io || global.io);
      if (chatNamespace) {
        conversation.participants.forEach((p) => {
          emitConversationDeletedToUser({
            ioOrNamespace: chatNamespace,
            recipientId: p.user.toString(),
            conversationId,
          });
        });
      }
    } catch (error) {
      console.error("Error notifying conversation deletion:", error);
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Chat deleted successfully",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error,
      error: error,
    });
  }
};

const deleteMessage = async (req, res) => {
  const { messageId } = req.params;
  const { _id: userId, timezone } = req.user;

  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "Invalid message ID",
    });
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "No such message found",
      });
    }

    // Check if current user is the sender of the message
    if (message.senderId.toString() !== userId.toString()) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "You are not authorized to delete this message",
      });
    }

    // Soft delete the message (mark as deleted without removing it from DB).
    // conversation.lastMessage is left untouched even if it points at this
    // message — the message doc itself now carries the placeholder content,
    // so the lookup in fetchChats still resolves to a real preview instead
    // of an empty stub.
    message.isDeleted = true;
    message.messageContent = "This message has been deleted";
    await message.save();

    // Notify live viewers and refresh the sidebar preview in the background —
    // same fire-and-forget shape as sendMessage's handleBackgroundTask, so the
    // delete response isn't held up on socket/DB round trips.
    const notifyDeletion = async () => {
      try {
        const conversation = await Conversation.findById(message.conversationId).lean();
        if (!conversation) return;

        const chatNamespace = getChatNamespace(req.io || global.io);
        if (!chatNamespace) return;

        const senderId = userId.toString();
        const recipientIds = conversation.participants
          .filter((p) => p.user.toString() !== senderId)
          .map((p) => p.user.toString());

        const conversationRoom = conversation.type === "group"
          ? getGroupRoom(conversation._id)
          : getDirectRoom(senderId, recipientIds[0]);

        emitMessageDeletedToConversation({
          ioOrNamespace: chatNamespace,
          room: conversationRoom,
          messageId: message._id,
          conversationId: conversation._id,
        });

        // Only push a sidebar refresh if this message is still the
        // conversation's preview — irrelevant otherwise.
        if (conversation.lastMessage?.toString() === message._id.toString()) {
          const localDate = moment(message.createdAt).tz(timezone).format();
          const messageObject = {
            ...message.toObject(),
            timesince: moment(localDate).fromNow(),
          };

          await Promise.all(recipientIds.map(async (recipientId) => {
            const { total: totalUnreadCount } = await getUnreadCounts(recipientId);
            emitChatUpdatedToUser({
              ioOrNamespace: chatNamespace,
              recipientId,
              payload: {
                type: "messageDeleted",
                conversationId: conversation._id.toString(),
                messageContent: messageObject,
                totalUnreadCount,
              },
            });
          }));

          // Also notify the deleter's own room, same as sendMessage does —
          // one "chatUpdated" code path for actor and recipients alike.
          const { total: senderTotalUnreadCount } = await getUnreadCounts(senderId);
          emitChatUpdatedToUser({
            ioOrNamespace: chatNamespace,
            recipientId: senderId,
            payload: {
              type: "messageDeleted",
              conversationId: conversation._id.toString(),
              messageContent: messageObject,
              totalUnreadCount: senderTotalUnreadCount,
            },
          });
        }
      } catch (error) {
        console.error("Error notifying message deletion:", error);
      }
    };
    notifyDeletion();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Message deleted successfully",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error,
      error: error,
    });
  }
};

/**
 * Two kinds of action share this endpoint:
 *  - chatState folders ("default"/"favorite"/"archived"/"blocked") — set the
 *    participant's single chatState slot.
 *  - verbs ("clear") — one-shot operations that aren't stored states.
 * Both are per-participant, so neither ever touches the other side's view.
 * Unblocking is just "default" — there's no separate action for it.
 */
const CHAT_STATE_ACTIONS = ["default", "favorite", "archived", "blocked"];
const CHAT_VERB_ACTIONS = ["clear"];

const chatActionHandler = async (req, res) => {
  const { _id: userId } = req.user;
  const { conversationId } = req.params;
  const { action } = req.body;

  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "Invalid conversation ID",
    });
  }

  const validActions = [...CHAT_STATE_ACTIONS, ...CHAT_VERB_ACTIONS];
  if (!validActions.includes(action)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "Invalid action",
    });
  }

  try {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "Conversation not found",
      });
    }

    // Find participant (IMPORTANT: per-user state)
    const participant = conversation.participants.find(
      (p) => p.user.toString() === userId.toString()
    );

    if (!participant) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "You do not have permission to perform this action",
      });
    }

    // Clear — wipes the thread for the requesting user only. Nothing is
    // deleted: a `clearedAt` watermark is stamped on this participant and the
    // read paths (fetchMessages/fetchChats) filter against it, so the peer's
    // copy of the history survives. deleteChat is the destructive counterpart.
    // chatState is deliberately left as-is: clearing a thread shouldn't pull it
    // out of the folder the user filed it under.
    if (action === "clear") {
      const clearedAt = new Date();
      participant.clearedAt = clearedAt;
      // Everything up to now is gone for this viewer, so nothing of it can
      // still be pending — otherwise the badge would count messages they
      // can no longer open.
      conversation.unreadCounts.set(userId.toString(), 0);
      await conversation.save();

      // Sync this user's other devices only — the peer sees no change at all.
      try {
        emitChatClearedToUser({
          ioOrNamespace: getChatNamespace(req.io || global.io),
          recipientId: userId.toString(),
          conversationId,
          clearedAt,
        });
      } catch (error) {
        console.error("Error notifying chat clear:", error);
      }

      const { total: totalUnreadCounts } = await getUnreadCounts(userId);

      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "chat_cleared",
        data: { conversationId, clearedAt },
        meta: { totalUnreadCounts },
      });
    }

    // Update chatState (single enum)
    participant.chatState = action;

    await conversation.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: `Conversation ${action} successfully`,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "Error performing action",
      error,
    });
  }
};

module.exports = {
  fetchChats,
  fetchMessages,
  sendMessage,
  deleteChat,
  deleteMessage,
  addParticipantToGroup,
  chatActionHandler
};
