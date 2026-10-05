const express = require("express");
const {
  fetchChats,
  fetchMessages,
  sendMessage,
  deleteChat,
  deleteMessage,
  addParticipantToGroup,
  chatActionHandler,
} = require("../controllers/messageController");
const auth = require("@middlewares/authMiddleware");
const createRateLimiter = require("@helperUtils/rateLimiter");

const router = express.Router();
router.use(auth);

// Rate limiters for the different routes
const conversationsRateLimiter = createRateLimiter("conversations", 10, 50);
const messagesRateLimiter = createRateLimiter("messages", 20, 100);
const sendMessageRateLimiter = createRateLimiter("sendMessage", 5, 20);
const deleteChatRateLimiter = createRateLimiter("deleteChat", 3, 10);
const deleteMessageRateLimiter = createRateLimiter("deleteMessage", 5, 20);
const markReadRateLimiter = createRateLimiter("markRead", 10, 50);
const addParticipantRateLimiter = createRateLimiter("addParticipant", 5, 20);

// Fetch conversations (chats)
router.get("/", conversationsRateLimiter, fetchChats);
router.put("/:conversationId/action", conversationsRateLimiter, chatActionHandler); // For actions like favorite, archive, block, etc.

// Fetch messages for a conversation by conversationId
router.get("/messages", messagesRateLimiter, fetchMessages);

// Send a new message to a conversation (conversationId optional for direct chat creation)
router.post("/message", sendMessageRateLimiter, sendMessage);

// Delete a conversation (chat) by conversationId
router.delete("/:conversationId", deleteChatRateLimiter, deleteChat);

// Delete a specific message by messageId
router.delete("/messages/:messageId", deleteMessageRateLimiter, deleteMessage);

// Add a participant to a group chat
router.post("/:conversationId/participants", addParticipantRateLimiter, addParticipantToGroup);


module.exports = router;
