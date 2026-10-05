const { getFullImageUrl } = require("@utils/imageHelper");
const { User } = require("@models/UserModel.js");
const BusinessProfile = require("@models/BusinessProfile");

// Who a thread "is" depends on who is looking at it: the business side sees the
// customer's own identity, the customer side sees the business's. getConversations
// applies exactly this rule when it builds each row's chatName/chatIcon, and a
// push notification has to agree with the conversation list it drops the user
// into — otherwise the same thread is a person in one place and a salon in the
// other.
//
// A direct conversation has a single recipient and a group's name/icon is the
// same for every member, so one resolution serves a whole send either way.
const resolveChatIdentity = async ({ conversation, senderId, recipientId }) => {
  if (conversation?.type !== "direct") {
    return {
      chatName: conversation?.groupName || "Unnamed Group",
      chatIcon: conversation?.groupMetadata?.image
        ? getFullImageUrl(conversation.groupMetadata.image)
        : null,
    };
  }

  const [recipient, sender, senderBusiness] = await Promise.all([
    User.findById(recipientId).select("accountState.userType").lean(),
    User.findById(senderId).select("name profileIcon").lean(),
    BusinessProfile.findOne({ user: senderId }).select("businessName image").lean(),
  ]);

  // Viewer is the business side — show the sender's personal identity, even if
  // that account also holds a BusinessProfile from switching roles elsewhere.
  if (recipient?.accountState?.userType === "business") {
    return {
      chatName: sender?.name || "Unknown",
      chatIcon: sender?.profileIcon ? getFullImageUrl(sender.profileIcon) : null,
    };
  }

  // Viewer is the customer side — show the sender's business identity, falling
  // back to their personal one when they have no profile.
  const chatIcon = senderBusiness?.image || sender?.profileIcon;
  return {
    chatName: senderBusiness?.businessName || sender?.name || "Unknown",
    chatIcon: chatIcon ? getFullImageUrl(chatIcon) : null,
  };
};

module.exports = { resolveChatIdentity };
