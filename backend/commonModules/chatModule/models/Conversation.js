const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["direct", "group"],
      required: true,
      default: "direct",
    },
    participants: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "member", "guest"], // Optional: you can add more roles
          default: "member",
        },
        chatState: {
          type: String,
          enum: [
            "default",
            "favorite",
            "archived",
            "blocked",
          ],
          default: "default",
        },
        isActive: {
          type: Boolean,
          default: true, // track if the user is currently part of the conversation
        },
        // "Clear chat" is per-participant and non-destructive: messages at or
        // before this timestamp are hidden from THIS user only, so the other
        // side keeps its full history. Messages are never removed, so a clear
        // can't take the peer's copy with it (that's what deleteChat is for).
        clearedAt: {
          type: Date,
        },
        removedAt: {
          type: Date,
        },
      },
    ],
    groupName: {
      type: String,
      required: function () {
        return this.type === "group";
      },
    },
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    groupMetadata: {
      image: {
        type: String, // URL to the group image
      },
      description: {
        type: String,
      },
    },
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    // Direct conversations only — every booking that has ever opened/reopened
    // this thread between the two participants (oldest first). A direct
    // conversation only ever comes from a booking, so this must stay non-empty.
    bookingIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Booking",
        },
      ],
      default: [],
      validate: {
        validator: function (v) {
          return this.type !== "direct" || v.length >= 1;
        },
        message: "bookingIds must have at least one booking for a direct conversation",
      },
    },
    // Direct conversations only — whether messaging is currently allowed.
    // Kept in sync by the booking lifecycle (opened/reopened on booking
    // creation, closed once no active booking remains between the pair) —
    // never deleted, just closed.
    chatStatus: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
    },
    unreadCounts: {
      // userId -> unread count map, store as object or array
      type: Map,
      of: Number,
      default: {},
    },
    groupSettings: {
      canMessage: {
        type: Boolean,
        default: true, // Can members send messages or only admins
      },
      isPrivate: {
        type: Boolean,
        default: false, // Is this a private group
      },
    },
    isArchived: {
      type: Boolean,
      default: false, // Indicates if the conversation is archived
    },
    lastActivity: {
      type: Map,
      of: Date, // Maps userId to their last activity timestamp
      default: {},
    },
    deletedAt: {
      type: Date,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },

  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1 });
conversationSchema.index({ lastMessage: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
