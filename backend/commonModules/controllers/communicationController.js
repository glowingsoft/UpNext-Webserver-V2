// communicationController.js
const {
  sendEmailViaSgrid,
  sendEmailViaAwsSes,
  sendSmsViaPinpoint,
  sendEmailViaBrevo
} = require("@utils/emailUtil");
const { Devices } = require("@models/Devices");
const { sendResponse, validateParams } = require("@utils/responseUtil");
const adminFireBConfig = require("@config/firebaseAdmin"); // Firebase admin SDK setup
const {
  registrationOtpEmailTemplate,
} = require("@utils/emailTemplates");
const { NotificationExp, NotificationTypes } = require("@models/Notifications");
const { Vonage } = require("@vonage/server-sdk");
const { UserProfile } = require("@models/UserProfile");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const mongoose = require("mongoose");
const { emitNotificationReceived } = require("@socketIo/notificationSocketEmitter");

/**
 * Send an email using SendGrid
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const sendEmailSgrid = async (req, res) => {
  const { title, emails, subject, body, config } = req.body;

  // Validate required parameters
  const validationOptions = {
    formFields: ["title", "emails", "subject", "body"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    await sendEmailViaSgrid(title, emails, subject, body, config);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "email_sent",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.body,
      error,
    });
  }
};

/**
 * Send an email using AWS SES
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const sendEmailAws = async (req, res) => {
  const { title, emails, subject, body, config } = req.body;

  // Validate required parameters
  const validationOptions = {
    formFields: ["title", "emails", "subject", "body"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    await sendEmailViaAwsSes(emails, subject, body, config);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "email_sent",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "failed_to",
      error: error,
    });
  }
};
/**
 * Send an email using AWS SES
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const sendEmailBrevo = async (req, res) => {
  const { title, emails, subject, body, config } = req.body;
  // Validate required parameters
  const validationOptions = {
    formFields: ["title", "emails", "subject", "body"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    await sendEmailViaBrevo(emails, subject, body, config);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "email_sent",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "failed_to",
      error: error,
    });
  }
};

const sendSmsViaPinpointAws = async (req, res) => {
  const { phoneNumber, otp } = req.body;

  // Validate required parameters
  if (!phoneNumber || !otp) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "phone_number_1",
      error: "Phone number and OTP are required.",
    });
  }

  try {
    const otpMessage = `${otp} is your OTP for the UpNext App`;
    await sendSmsViaPinpoint(phoneNumber, otpMessage);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "otp_sent",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.body,
      error,
    });
  }
};

/**
 * Send a notification (placeholder function, can be expanded for different titles)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const sendNotificationControllerForTesting = async (req, res) => {
  const { recipients, title, body, data } = req.body;

  // Validate required parameters
  const validationOptions = {
    formFields: ["recipients", "title", "body"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  // Nothing to send is a bad request, not a delivery failure — without this
  // the send below returns zero responses and falls through to a bare 500.
  const sendableRecipients = (Array.isArray(recipients) ? recipients : []).filter((r) => r?.deviceId);
  if (sendableRecipients.length === 0) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "notification_device_ids_required",
    });
  }

  try {
    // Placeholder for notification sending logic
    // This can be expanded to handle different titles of notifications like SMS, Push, etc.
    // console.log(`Sending ${title} notification to: ${recipients.join(", ")}`);
    // console.log(`body: ${body}`);

    // Simulate sending notification
    const response = await sendNotification(sendableRecipients, {
      title: title,
      body: body,
      data: data,
    });

    const successIds = [];
    const failureIds = [];

    // Matched on deviceId: responses come back grouped by payload type, so
    // their order doesn't follow the order of the request's recipients.
    response.responses.forEach((resp, idx) => {
      const recipient = sendableRecipients.find((r) => r.deviceId === resp.deviceId) || sendableRecipients[idx];
      if (resp.success) {
        successIds.push(recipient);
      } else {
        failureIds.push({
          ...recipient,
          error: resp.error ? resp.error.message : "Unknown error",
        });
      }
    });

    if (successIds.length > 0) {
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "notifications_sent_success", // Use the success translation key
        values: { title }, // Pass the dynamic title
        data: {
          successIds,
          failureIds,
        },
      });
    } else {
      return sendResponse({
        res,
        statusCode: 500,
        translationKey: "notifications_sent_failure", // Use the success translation key
        values: { title }, // Pass the dynamic title
        data: {
          successIds,
          failureIds,
        },
      });
    }
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message,
      error,
    });
  }
};

const VALID_NOTIFICATION_TYPES = new Set(Object.values(NotificationTypes));

/**
 * The stored notification's `type` is a required enum, so an unrecognized value
 * makes insertMany throw and loses the whole batch — silently, since the save
 * runs in the background task below. Push payloads carry their own finer
 * grained `data.type` (e.g. "booking_accepted", "incoming_call") that clients
 * route on, and those are deliberately not enum members: they stay untouched on
 * the wire, and only the persisted row is normalized. Callers pass the enum
 * value explicitly via `notificationType`; anything unmapped lands in "system"
 * rather than disappearing.
 */
const resolveNotificationType = (type) =>
  VALID_NOTIFICATION_TYPES.has(type) ? type : NotificationTypes.SYSTEM;

/**
 * Per-type push toggles, on top of the master `pushNotifications` switch.
 * Each profile schema only carries its own keys (`messageAlerts` is business
 * side, `bookingReminders` is customer side), so a key that doesn't exist on
 * the profile being checked reads as undefined and blocks nothing.
 */
const PUSH_PREFERENCE_BY_TYPE = {
  [NotificationTypes.NEW_MESSAGE]: "messageAlerts",
  [NotificationTypes.REMINDER]: "bookingReminders",
};

/**
 * Callers name their recipients inconsistently: booking documents store the
 * BusinessProfile `_id` in `business`, so `recipientIds: [booking.business]`
 * hands us a profile id where every downstream lookup (Devices, UserProfile,
 * Notification.receiverId) expects the User id. Left unmapped, the business
 * side of every booking notification matched nothing — no push, no saved row,
 * and a `receiverId` the notifications endpoint could never return.
 *
 * Anything that isn't a User is looked up as a BusinessProfile and swapped for
 * its owning user. Ids that are neither are dropped.
 */
const resolveRecipientUserIds = async (recipientIds) => {
  const ids = [
    ...new Set(
      (Array.isArray(recipientIds) ? recipientIds : [recipientIds])
        .filter((id) => id && mongoose.isValidObjectId(id))
        .map((id) => id.toString()),
    ),
  ];
  if (ids.length === 0) return [];

  const users = await User.find({ _id: { $in: ids } }).select("_id").lean();
  const userIds = new Set(users.map((user) => user._id.toString()));

  const unknown = ids.filter((id) => !userIds.has(id));
  if (unknown.length === 0) return ids;

  const profiles = await BusinessProfile.find({ _id: { $in: unknown } }).select("user").lean();
  const profileToUser = new Map(profiles.map((profile) => [profile._id.toString(), profile.user?.toString()]));

  const resolved = ids.map((id) => (userIds.has(id) ? id : profileToUser.get(id))).filter(Boolean);

  const dropped = ids.length - resolved.length;
  if (dropped > 0) {
    console.error(`sendUserNotifications: dropped ${dropped} recipient id(s) matching neither a User nor a BusinessProfile.`);
  }

  return [...new Set(resolved)];
};

/**
 * The sender needs both identities: `subjectId` on the saved row is a ref to
 * User, while a client deep-linking to "who sent this" wants the business it
 * came from. Callers pass whichever they have — `businessId` on booking
 * notifications, the User id on chat — so look up the other side either way.
 */
const resolveSender = async (sender) => {
  const empty = { userId: null, businessProfileId: null };
  if (!sender || !mongoose.isValidObjectId(sender)) return empty;

  const id = sender.toString();

  const user = await User.findById(id).select("_id").lean();
  if (user) {
    const profile = await BusinessProfile.findOne({ user: id }).select("_id").lean();
    return { userId: id, businessProfileId: profile?._id?.toString() || null };
  }

  const profile = await BusinessProfile.findById(id).select("_id user").lean();
  if (profile?.user) {
    return { userId: profile.user.toString(), businessProfileId: profile._id.toString() };
  }

  return empty;
};

/**
 * One "your inbox changed" ping per recipient, carrying that recipient's own
 * unread total so the badge updates without a round trip.
 *
 * Counted in a single grouped query rather than a countDocuments per user, and
 * wrapped so a Redis/socket problem can never fail the send: the rows are
 * already saved at this point, and a missed ping costs only immediacy — the
 * client still sees it on the next GET /app/notifications.
 */
const notifyInboxChanged = async (savedNotifications = []) => {
  if (savedNotifications.length === 0) return;

  try {
    const receiverIds = [...new Set(savedNotifications.map((row) => String(row.receiverId)))];
    const counts = await NotificationExp.aggregate([
      {
        $match: {
          receiverId: { $in: receiverIds.map((id) => new mongoose.Types.ObjectId(id)) },
          isRead: false,
        },
      },
      { $group: { _id: "$receiverId", count: { $sum: 1 } } },
    ]);
    const unreadByUser = new Map(counts.map((row) => [String(row._id), row.count]));

    savedNotifications.forEach((notification) => {
      emitNotificationReceived({
        userId: notification.receiverId,
        unreadCount: unreadByUser.get(String(notification.receiverId)) || 0,
        notificationId: notification._id,
        type: notification.type,
      });
    });
  } catch (error) {
    console.error("Failed to emit notification events:", error.message);
  }
};

/**
 * Sends a notification to multiple users based on their user IDs.
 *
 * Two independent deliveries, in this order:
 *   1. the Notification row — every recipient gets one, whatever their push
 *      settings are and whether or not they own a device. It is their in-app
 *      inbox, and push preferences are about push.
 *   2. the FCM push — only for recipients who allow it and have a device.
 *
 * They used to be one path: the save lived inside the "has devices" branch and
 * ran off the push responses, so a recipient with push disabled, no registered
 * device, or an unconfigured Firebase silently got nothing at all.
 *
 * @param {Object} param0 - Object containing recipientIds (array), title (string), body (string), and optional data (object).
 * @param {string} [param0.notificationType] - NotificationTypes value stored on the saved notification.
 */

const sendUserNotifications = async ({
  recipientIds,
  title,
  body,
  data = {},
  sender = null, // Optional: sender ID
  objectId = null, // Optional: object ID
  saveNotification = true, // send false if you don't want to save notification in db
  notificationType = null, // Optional: NotificationTypes value for the saved row
}) => {
  setImmediate(async () => {
    const resolvedType = resolveNotificationType(notificationType || data.type);

    try {
      const [userIds, resolvedSender] = await Promise.all([
        resolveRecipientUserIds(recipientIds),
        resolveSender(sender),
      ]);
      if (userIds.length === 0) return;

      const { userId: senderUserId, businessProfileId: senderBusinessId } = resolvedSender;

      // ─── 1. The in-app notification ─────────────────────────────────────
      // Saved for every recipient before anything is pushed, so a Firebase
      // outage or a missing device token can't cost someone their inbox entry.
      if (saveNotification) {
        // objectId/objectType are required on the model — without them the
        // whole batch would be rejected, so say so instead of failing mutely.
        if (!objectId || !data.objectType) {
          console.error("Skipping notification save — objectId/objectType missing for:", title);
        } else {
          try {
            const saved = await NotificationExp.insertMany(
              userIds.map((userId) => ({
                type: resolvedType,
                subjectId: senderUserId,
                objectId,
                objectType: data.objectType,
                receiverId: userId,
                title,
                body,
              })),
            );
            // Sits with the save, not with the push below, for the same reason
            // the save does: it is in-app state, so push preferences don't gate it.
            await notifyInboxChanged(saved);
          } catch (error) {
            console.error("Failed to save notifications:", error.message);
          }
        }
      }

      // ─── 2. The push ────────────────────────────────────────────────────
      // A profile with the master push toggle off — or the toggle for this
      // notification's kind — is skipped here only; its row is already saved.
      const preferenceKey = PUSH_PREFERENCE_BY_TYPE[resolvedType];
      const [userProfiles, businessProfiles] = await Promise.all([
        UserProfile.find({ user: { $in: userIds } }).select("user notificationPreferences").lean(),
        BusinessProfile.find({ user: { $in: userIds } }).select("user notificationPreferences").lean(),
      ]);

      // A user can hold both profiles (role switching), and either one saying
      // "no" is an opt-out — matching how the master toggle already behaved.
      const optedOutIds = new Set(
        [...userProfiles, ...businessProfiles]
          .filter((profile) => {
            const preferences = profile.notificationPreferences || {};
            if (preferences.pushNotifications === false) return true;
            return Boolean(preferenceKey) && preferences[preferenceKey] === false;
          })
          .map((profile) => profile.user.toString()),
      );

      const pushRecipientIds = userIds.filter((id) => !optedOutIds.has(id));
      if (pushRecipientIds.length === 0) return;

      const recipientDevices = await Devices.find({
        userId: { $in: pushRecipientIds },
      }).select("userId devices").lean();

      if (!recipientDevices || recipientDevices.length === 0) {
        console.log("No devices found for the provided user IDs.");
        return;
      }

      // Grouped per user so each send carries only that user's tokens, and
      // deduped by deviceId — the same token registered twice would otherwise
      // produce two identical pushes.
      const devicesByUser = new Map();
      for (const record of recipientDevices) {
        const userId = record.userId.toString();
        const byDeviceId = devicesByUser.get(userId) || new Map();
        for (const device of record.devices || []) {
          if (!device?.deviceId) continue;
          byDeviceId.set(device.deviceId, {
            deviceId: device.deviceId,
            deviceType: device.deviceType,
          });
        }
        devicesByUser.set(userId, byDeviceId);
      }

      // FCM data is a string map. Callers pass ObjectIds and the occasional
      // null (any notification without a `sender`), so everything is coerced
      // here and absent keys are dropped rather than sent as null — clients
      // read data values as strings either way.
      const pushData = Object.fromEntries(
        Object.entries({
          ...data, // Additional data payload
          subjectId: senderUserId,
          // Present only when the sender has a business profile — lets a client
          // open the business without a round trip to resolve the user.
          subjectBusinessId: senderBusinessId,
          objectId,
        })
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );

      for (const [userId, byDeviceId] of devicesByUser) {
        const userDevices = [...byDeviceId.values()];
        if (userDevices.length === 0) continue;

        try {
          const response = await sendNotification(userDevices, {
            title,
            body,
            data: pushData,
          });

          const failures = response.responses.filter((deviceResponse) => !deviceResponse.success);
          if (failures.length > 0) {
            console.error(
              `Push to user ${userId}: ${failures.length}/${response.responses.length} token(s) failed —`,
              failures.map((failure) => failure.error?.message).join("; "),
            );
          }
        } catch (error) {
          // One user's push failing (or Firebase being unconfigured) must not
          // stop the remaining recipients from getting theirs.
          console.error(`Push to user ${userId} failed:`, error.message);
        }
      }
    } catch (error) {
      console.error("Error sending notifications in background:", error);
    }
  });
};

const sendNotification = async (recipients, payload) => {
  const androidTokens = [];
  const iosTokens = [];

  // Split by payload shape, not by platform name: iOS needs the apns block,
  // while android and web both take the plain notification+data message.
  // "web" is a registered deviceType (see the Devices enum) but used to match
  // neither branch, so web tokens were dropped and the caller got zero
  // responses — which surfaced as a 500 with an empty failure list.
  recipients.forEach((recipient) => {
    if (!recipient?.deviceId) return;
    if (recipient.deviceType === "ios") {
      iosTokens.push(recipient.deviceId);
    } else {
      androidTokens.push(recipient.deviceId);
    }
  });
  // const additionalToken = "cYp8RW8gREO3vhzf_nHlCB:APA91bHR17qarpZDNK7SlZw-ybhb7JmHHbBGLZGDdYFh_6XJFPzfCCC0HdrOv3R-N36ZnoUrY_3I0h5-nFONRhIyQV8QRbAqkvdadYPOFB4EIavJUdfyXtTJYcMNoJKSeTZ0noJqLp4k";
  // androidTokens.push(additionalToken);

  // Notification payload for Android
  const androidPayload = {
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
  };

  // Notification payload for iOS
  const iosPayload = {
    notification: {
      title: payload.title,
      body: payload.body,
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: "default", // Use default sound on iOS
          badge: 1, // Optional: set the badge number on the app icon
        },
      },
    },
    data: payload.data, // Optional: add custom data for iOS
  };

  try {
    // Kept as ordered groups so each FCM response can be paired back with the
    // token it belongs to — the responses of the two sends are concatenated,
    // so an index into the original recipients array doesn't line up.
    const groups = [];
    if (androidTokens.length > 0) groups.push({ tokens: androidTokens, message: androidPayload });
    if (iosTokens.length > 0) groups.push({ tokens: iosTokens, message: iosPayload });

    const responses = await Promise.all(
      groups.map((group) =>
        adminFireBConfig.messaging().sendEachForMulticast({
          tokens: group.tokens,
          ...group.message,
        }),
      ),
    );

    // // Log the response of each promise with a message
    // responses.forEach((response, index) => {
    //   console.log(`Response from promise ${index + 1}:`, response);
    //   if (response.failureCount > 0) {
    //     response.responses.forEach((resp, idx) => {
    //       if (!resp.success) {
    //         console.error(
    //           `Failure message from promise ${index + 1}, response ${idx + 1}:`,
    //           resp.error
    //         );
    //       }
    //     });
    //   }
    // });

    const result = {
      responses: [],
    };

    responses.forEach((response, groupIndex) => {
      response.responses.forEach((deviceResponse, tokenIndex) => {
        // deviceId lets callers report per-device outcomes without relying on
        // the position of the token in their own list.
        result.responses.push({ ...deviceResponse, deviceId: groups[groupIndex].tokens[tokenIndex] });
      });
    });
    return result;
  } catch (error) {
    console.error("Error sending notifications:", error);
    throw error;
  }
};

// Initialize the Vonage client with your credentials
const vonage = new Vonage({
  apiKey: "ec823766", // Replace with your Vonage API Key
  apiSecret: "KNMQzSzi9eJx93mF", // Replace with your Vonage API Secret
  privateKey: "" 
});

const sendSmsViaVonage = async (req, res) => {
  const { phoneNumber, otp } = req.body;

  // Validate required parameters
  if (!phoneNumber || !otp) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "phone_number_1",
      error: "Phone number and OTP are required.",
    });
  }

  try {
    const otpMessage = `${otp} is your OTP for the ZahraPay App`;
    const from = "+923005098444"; // Replace with your Vonage virtual number

    // Send SMS using Nexmo's API (Vonage)
    const messageData = {
      to: phoneNumber,
      from: from,
      text: otpMessage,
    };

    // Send the message via Nexmo (Vonage) SDK
    vonage.sms.send(messageData, (err, responseData) => {
      console.log("Entered the callback function");
      if (err) {
        console.error("Error sending SMS:", err);
        return sendResponse({
          res,
          statusCode: 500,
          translationKey: "Error sending SMS via Vonage",
          error: err.message,
        });
      } else {
        console.log("Response data:", responseData);
        if (
          responseData &&
          responseData.messages &&
          responseData.messages[0].status === "0"
        ) {
          console.log("Message sent successfully:", responseData);
          return sendResponse({
            res,
            statusCode: 200,
            translationKey: "otp_sent",
            data: responseData,
          });
        } else {
          console.error(
            "Failed to send message. Status:",
            responseData.messages[0].status
          );
          return sendResponse({
            res,
            statusCode: 500,
            translationKey: "otp_sent",
            error: `Failed with status: ${responseData.messages[0].status}`,
          });
        }
      }
    });
  } catch (error) {
    console.error("Error sending SMS:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "otp_sent",
      error: error.message,
    });
  }
};


const axios = require('axios');

const sendSMSSomalianAPI = async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const message = `Your OTP is ${otp}`;

  // Validate required parameters
  if (!phoneNumber || !otp) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "phone_number_1",
      error: "Phone number and message are required.",
    });
  }

  try {
    const apiKey = '07098f01-6071-4045-abd8-63a7ec3e25ac'; // Replace with your actual API Key
    const apiSecret = '5810f9db-bd8e-4002-ab57-721ab0d8ee1e'; // Replace with your actual API Secret

    // Combine API credentials
    const accountApiCredentials = `${apiKey}:${apiSecret}`;

    // Convert credentials to base64
    const buff = Buffer.from(accountApiCredentials);
    const base64Credentials = buff.toString('base64');

    // Set the request headers, including the Authorization header
    const requestHeaders = {
      headers: {
        'Authorization': `Basic ${base64Credentials}`,
        'Content-Type': 'application/json'
      }
    };

    // Construct the request data (the SMS content and destination number)
    const requestData = JSON.stringify({
      messages: [{
        content: message, // Message content
        destination: phoneNumber // Destination phone number
      }]
    });

    // Send the POST request to the API endpoint
    const response = await axios.post('https://rest.mymobileapi.com/bulkmessages', requestData, requestHeaders);

    if (response.data) {
      console.log("Success:", response.data);
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "otp_sent",
        data: response.data,
      });
    }
  } catch (error) {
    console.error("Error sending SMS:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "otp_sent",
      error: error.message,
    });
  }
};



module.exports = {
  sendEmailSgrid,
  sendEmailAws,
  sendSmsViaPinpointAws,
  sendNotificationControllerForTesting,
  sendUserNotifications,
  sendSmsViaVonage,
  sendSMSSomalianAPI,
  sendEmailBrevo
};
