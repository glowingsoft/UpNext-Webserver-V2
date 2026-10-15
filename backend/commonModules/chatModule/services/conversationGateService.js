const mongoose = require("mongoose");
const { User } = require("../../../models/UserModel");
const BusinessProfile = require("../../../models/BusinessProfile");
const Booking = require("../../../models/Bookings");
const Conversation = require("../models/Conversation");
const { UserProfile } = require("@models/UserProfile");

// A booking in any of these states no longer counts as "active" for chat purposes.
const TERMINAL_BOOKING_STATUSES = ["completed", "canceled", "expired"];

// Given the two User ids on either side of a direct chat, work out which one
// is the customer and which is the business, resolving the business side down
// to its BusinessProfile id (Booking.business is a BusinessProfile id, not a
// User id). Rejects same-type pairs (user<->user, business<->business).

const resolveChatPair = async (userAId, userBId) => {
  const [userA, userB, ...profiles] = await Promise.all([
    User.findById(userAId).select("accountState.roles").lean(),
    User.findById(userBId).select("accountState.roles").lean(),
    UserProfile.findOne({ user: userAId }).select("_id status").lean(),
    UserProfile.findOne({ user: userBId }).select("_id status").lean(),
    BusinessProfile.findOne({ user: userAId }).select("_id status").lean(),
    BusinessProfile.findOne({ user: userBId }).select("_id status").lean(),
  ]);

  if (!userA || !userB) return { error: "participant_not_found" };

  const [profileA, profileB, businessA, businessB] = profiles;

  const getType = (user, profile, business) => {
    const roles = user.accountState?.roles || [];

    if (roles.includes("business") && business?.status === "active") return "business";

    if (roles.includes("user") && profile?.status === "active") return "user";

    return null;
  };

  const typeA = getType(userA, profileA, businessA);
  const typeB = getType(userB, profileB, businessB);

  if (!typeA || !typeB) return { error: "valid_verified_profile_required" };

  if (typeA === typeB) return { error: "chat_requires_user_and_business" };

  const isABusiness = typeA === "business";

  return {
    customerUserId: isABusiness ? userBId : userAId,
    businessUserId: isABusiness ? userAId : userBId,
    businessProfileId: isABusiness ? businessA._id : businessB._id,
  };
};
/**
 * Live gate for sendMessage — resolves whether an active (non-terminal)
 * booking currently exists between the two chat participants. If bookingId
 * is supplied it must itself belong to this pair and still be active.
 */
const resolveActiveBooking = async ({ userId, otherUserId, bookingId }) => {
  const pair = await resolveChatPair(userId, otherUserId);
  if (pair.error) return { error: pair.error };

  const filter = {
    user: pair.customerUserId,
    business: pair.businessProfileId,
    status: { $nin: TERMINAL_BOOKING_STATUSES },
  };

  if (bookingId) {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return { error: "invalid_booking_id" };
    filter._id = bookingId;
  }

  const booking = await Booking.findOne(filter).sort({ createdAt: -1 }).select("_id").lean();
  if (!booking) return { error: "no_active_booking" };

  return { bookingId: booking._id, customerUserId: pair.customerUserId, businessUserId: pair.businessUserId };
};

/**
 * Called once a Booking first comes into existence (materializeBookingFromDraft).
 * Finds the existing direct conversation between the customer and the
 * business owner, or creates it — either way records the booking and marks
 * the chat open (reopening it if it had been closed).
 */
const openOrReopenConversationForBooking = async (booking) => {
  const businessProfile = await BusinessProfile.findById(booking.business).select("user").lean();
  if (!businessProfile) return null;

  const customerUserId = booking.user;
  const businessUserId = businessProfile.user;

  const conversation = await Conversation.findOne({
    type: "direct",
    "participants.user": { $all: [customerUserId, businessUserId] },
    $expr: { $eq: [{ $size: "$participants" }, 2] },
  });

  if (!conversation) {
    return Conversation.create({
      type: "direct",
      participants: [
        { user: customerUserId, role: "member" },
        { user: businessUserId, role: "member" },
      ],
      unreadCounts: { [customerUserId]: 0, [businessUserId]: 0 },
      bookingIds: [booking._id],
      chatStatus: "open",
    });
  }

  return Conversation.findByIdAndUpdate(
    conversation._id,
    { $addToSet: { bookingIds: booking._id }, $set: { chatStatus: "open" } },
    { new: true },
  );
};

/**
 * Called after a booking's status flips to a terminal state. Closes the
 * conversation (never deletes it) only if no other booking between the same
 * customer/business pair is still active.
 */
const closeConversationIfNoActiveBookings = async ({ userId, businessId }) => {
  const stillActive = await Booking.exists({
    user: userId,
    business: businessId,
    status: { $nin: TERMINAL_BOOKING_STATUSES },
  });
  if (stillActive) return;

  const businessProfile = await BusinessProfile.findById(businessId).select("user").lean();
  if (!businessProfile) return;

  await Conversation.updateOne(
    {
      type: "direct",
      "participants.user": { $all: [userId, businessProfile.user] },
      $expr: { $eq: [{ $size: "$participants" }, 2] },
    },
    { $set: { chatStatus: "closed" } },
  );
};

/**
 * Sum a user's unreadCounts across every (non-deleted) conversation they're
 * in. Shared by the socket connect handler (initial snapshot) and
 * sendMessage's chatUpdated emit (live total alongside the per-conversation
 * count), so both stay in sync off the same aggregation.
 */
const getUnreadCounts = async (userId) => {
  const conversations = await Conversation.find({ "participants.user": userId, isDeleted: false })
    .select("unreadCounts")
    .lean();

  const byConversation = {};
  let total = 0;
  conversations.forEach((conv) => {
    const count = conv.unreadCounts?.[userId] || 0;
    if (count > 0) byConversation[conv._id.toString()] = count;
    total += count;
  });

  return { total, byConversation };
};

module.exports = {
  TERMINAL_BOOKING_STATUSES,
  resolveActiveBooking,
  openOrReopenConversationForBooking,
  closeConversationIfNoActiveBookings,
  getUnreadCounts,
};
