const mongoose = require("mongoose");

// Define the NotificationTypes enum
const NotificationTypes = {
  NEW_MESSAGE: "newMessage",
  SYSTEM: "system",
  REMINDER: "reminder",
  NEW_BOOKING: "newBooking",
  BOOKING_REQUEST: "BookingRequest",
  BOOKING_APPROVED: "bookingApproved",
  BOOKING_REJECTED: "bookingRejected",
  BOOKING_PICKED: "bookingPicked",
  BOOKING_COMPLETED: "bookingCompleted",
  BOOKING_CANCELED: "bookingCanceled",
  CERTIFICATION_APPROVED: "certificationApproved",
  CERTIFICATION_REJECTED: "certificationRejected",
};

// Define the NotificationSchema
const NotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: Object.values(NotificationTypes), // Reference the notification types enum
    required: true,
  },
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User", // Reference to the sender (optional)
    default: null,
  },
  objectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  objectType: {
    type: String,
    required: true,
  },
  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User", // Reference to the user for whom this notification is intended
    required: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  body: {
    type: String,
    required: true,
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Automatically update `updatedAt` field on modification
NotificationSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Export both Notification model and NotificationTypes enum
const NotificationExp = mongoose.model("Notification", NotificationSchema);
module.exports = {
  NotificationExp,
};
module.exports.NotificationTypes = NotificationTypes;
