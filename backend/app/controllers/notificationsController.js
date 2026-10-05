const {
  sendResponse,
  generateMeta,
  parsePaginationParams,
} = require("../../helperUtils/responseUtil");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { NotificationExp } = require("../../models/Notifications");
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
    const [notifications, totalNotifications, unreadCount] = await Promise.all([
      NotificationExp.find({ receiverId: req.user._id })
        //  .populate('objectId') // Populate full subjectId object
        .populate("subjectId", "_id name profileIcon") // Populate full subjectId object
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      NotificationExp.countDocuments({ receiverId: req.user._id }),
      // Across the whole inbox, not just this page — it's the badge count, and
      // it's the same number PUT /notifications/read reports back.
      NotificationExp.countDocuments({ receiverId: req.user._id, isRead: false }),
    ]);

    // Calculate pagination meta
    const meta = { ...generateMeta(page, limit, totalNotifications), unreadCount };

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

/**
 * PUT /notifications/read — mark notifications as read.
 *
 *   { "ids": ["<id>", "<id>"] }   marks just those
 *   {}  (ids omitted)             marks all of the caller's unread
 *
 * Always scoped to the caller: an id belonging to someone else doesn't match,
 * rather than being marked read.
 */
const readNotification = async (req, res) => {
  const { ids } = req.body || {};
  const hasIds = Array.isArray(ids) && ids.length > 0;

  const filter = { receiverId: req.user._id, isRead: false };

  if (hasIds) {
    const invalidId = ids.find((value) => !mongoose.isValidObjectId(value));
    if (invalidId) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "notification_ids_invalid",
      });
    }
    filter._id = { $in: ids.map((value) => new mongoose.Types.ObjectId(String(value))) };
  }

  try {
    // Already-read notifications are filtered out, so markedRead is what this
    // call actually changed — re-sending the same ids reports 0, not a repeat.
    const { modifiedCount } = await NotificationExp.updateMany(filter, { $set: { isRead: true } });
    const unreadCount = await NotificationExp.countDocuments({ receiverId: req.user._id, isRead: false });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "notifications_marked_read_success",
      values: { count: modifiedCount },
      data: { markedRead: modifiedCount, unreadCount },
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
