const {
  sendResponse,
  generateMeta,
  parsePaginationParams,
} = require("@utils/responseUtil");
const moment = require("moment-timezone");
const { NotificationExp } = require("@models/Notifications");
const { getFullImageUrl } = require("@utils/imageHelper");
const BusinessProfile = require("@models/BusinessProfile");

/**
 * subjectId is a ref to User, so a notification sent by a business resolves to
 * the owner's account. Clients that want to open the business behind it would
 * otherwise need a second call per row — one batched lookup covers the page.
 */
const loadSenderBusinesses = async (subjectIds) => {
  const ids = [...new Set(subjectIds.filter(Boolean).map((id) => id.toString()))];
  if (ids.length === 0) return new Map();

  const profiles = await BusinessProfile.find({ user: { $in: ids } })
    .select("_id user businessName image")
    .lean();

  return new Map(
    profiles.map((profile) => [
      profile.user.toString(),
      {
        _id: profile._id,
        businessName: profile.businessName,
        image: profile.image ? getFullImageUrl(profile.image) : profile.image,
      },
    ]),
  );
};

// Get all notifications with pagination
const getNotifications = async (req, res) => {
  const { page, limit } = parsePaginationParams(req);

  try {
    const [notifications, totalNotifications] = await Promise.all([
      NotificationExp.find({ receiverId: req.user._id })
        //  .populate('objectId') // Populate full subjectId object
        .populate("subjectId", "_id name profileIcon") // Populate full subjectId object
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      NotificationExp.countDocuments({ receiverId: req.user._id }),
    ]);

    // Calculate pagination meta
    const meta = generateMeta(page, limit, totalNotifications);

    const senderBusinesses = await loadSenderBusinesses(
      notifications.map((notification) => notification.subjectId?._id),
    );

    const formattedNotifications = notifications.map((notification) => {
      const {
        _id,
        type,
        objectId,
        title,
        body,
        data,
        url,
        isRead,
        createdAt,
        objectType,
        subjectId,
        receiverId,
      } = notification;
      const userTimezone = req.user.timezone || "UTC";
      const timeSince = moment(createdAt).tz(userTimezone).fromNow();

      // profileIcon is stored as a bare S3 key, so the base belongs here rather
      // than in the document — getFullImageUrl leaves external avatars alone.
      const subject = subjectId
        ? {
            _id: subjectId._id,
            name: subjectId.name,
            profileIcon: subjectId.profileIcon
              ? getFullImageUrl(subjectId.profileIcon)
              : subjectId.profileIcon,
            // null for a sender who has no business profile.
            business: senderBusinesses.get(subjectId._id.toString()) || null,
          }
        : null;

      return {
        _id,
        type,
        objectId,
        objectType,
        subject,
        title,
        body,
        data,
        isRead,
        timeSince,
      };
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "notifications_fetched_success", // Use translation key
      data: formattedNotifications,
      meta: meta,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "notifications_fetch_error", // Use translation key for errors
      error,
    });
  }
};

// Mark a notification as read by ID
const readNotification = async (req, res) => {
  try {
    const notification = await NotificationExp.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true }
    );
    if (!notification) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "notification_not_found", // Use translation key
      });
    }
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "notification_marked_read_success", // Use translation key
      data: notification,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "notification_mark_read_error", // Use translation key
      error,
    });
  }
};

module.exports = {
  getNotifications,
  readNotification,
};
