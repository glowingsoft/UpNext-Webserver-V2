const mongoose = require("mongoose");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { User, SubscriptionType } = require("@models/UserModel");
const moment = require("moment");
const { sendResponse, validateParams, parsePaginationParams, generateMeta } = require("@utils/responseUtil");
const { formatUserResponse } = require("@utils/userResponseUtil");
const validator = require("validator");
const { userCache } = require("@config/nodeCache");
const fs = require("fs");
const path = require("path");
const { UserProfile } = require("@models/UserProfile");
const BusinessProfile = require("@models/BusinessProfile");
const { getFullImageUrl } = require("@utils/imageHelper");
const { resolveBadgeOptionName } = require("@utils/badgeUtil");
const { emitCertificationStatus } = require("@socketIo/certificationSocketEmitter");
const Booking = require("@models/Bookings");
const BookingDraft = require("@models/BookingDraft");
const Payment = require("@models/Payment");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { Promotion } = require("@models/Promotions");
const Review = require("@models/Review");
const PromotionUsage = require("@models/PromotionUsage");
const Portfolio = require("@models/Portfolios");
const ServiceCategory = require("@models/ServiceCategory");
const BusinessAnalyticsEvent = require("@models/BusinessAnalyticsEvent");
const Card = require("@models/Card");
const { Devices } = require("@models/Devices");
const { Session, revokeAllSessions } = require("@models/Session");
const Traffic = require("@models/Traffic");
const SupportRequest = require("@models/SupportRequest");
const Conversation = require("../../commonModules/chatModule/models/Conversation");
const Message = require("../../commonModules/chatModule/models/Message");
const { escapeRegExp } = require("@utils/regexUtil");
// Relative, not @notificationsUtil — that alias points at a path that no
// longer exists (the file moved under controllers/), so it throws on require.
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationExp, NotificationTypes } = require("@models/Notifications");
const { s3 } = require("@config/s3Client");
const AccountDeletionCleanup = require("@models/AccountDeletionCleanup");
const BookingOffer = require("@models/BookingOffer");
const Dispute = require("@models/Dispute");
// Path to the JSON file
// const currenciesFilePath = path.join(__dirname, "@assets/currencies/currencies.json");

// Function to read the JSON file and parse it
const readJSONFile = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading file from disk: ${error}`);
    return null;
  }
};

// Read the currencies data at startup
// const currenciesData = readJSONFile(currenciesFilePath);

// Block User Function
const blockUser = async (req, res) => {
  const { _id } = req.user;
  const { userIdToBlock } = req.params; // ID of the user to block

  const validationOptions = {
    pathParams: ["userIdToBlock"],
    objectIdFields: ["userIdToBlock"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Validation failed, response already sent
  }
  if (_id.equals(userIdToBlock)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "you_cannot",
    });
  }
  try {
    const [currentUser, userToBlock] = await Promise.all([
      User.findById(_id).select("blockedUsers"),
      User.findById(userIdToBlock),
    ]);

    if (!userToBlock) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_to_1",
      });
    }

    // Check if already blocked
    if (currentUser.blockedUsers.includes(userIdToBlock)) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "user_is",
      });
    }

    // Add the user to the blocked list of the current user
    currentUser.blockedUsers.push(userIdToBlock);

    // Save the current user
    await currentUser.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_blocked",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_9",
      error,
    });
  }
};

// Report User Function
const reportUser = async (req, res) => {
  const currentUser = req.user;
  const { userIdToReport } = req.params; // ID of the user to report

  const validationOptions = {
    pathParams: ["userIdToReport"],
    objectIdFields: ["userIdToReport"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Validation failed, response already sent
  }
  if (currentUser._id.equals(userIdToReport)) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "you_cannot_1",
    });
  }
  try {
    const userToReport = await User.findById(userIdToReport);

    if (!userToReport) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_to_2",
      });
    }

    // Check if current user has already reported this user
    if (userToReport.reportedBy.includes(currentUser._id)) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "you_have",
      });
    }

    // Add current user's ID to the reportedBy list
    userToReport.reportedBy.push(currentUser._id);

    // Increment the report count
    userToReport.reportCount += 1;

    // Check if user should be suspended
    if (userToReport.reportCount >= 10) {
      userToReport.accountState.status = "suspended";
      userToReport.accountState.reason = "User suspended due to multiple reports.";
      userToReport.accountState.suspensionDate = new Date();
    }

    // Save the reported user
    await userToReport.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_reported",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_10",
      error,
    });
  }
};

// Add or update a subscription for a user
const addOrUpdateSubscription = async (req, res) => {
  const { type } = req.body;
  const { _id } = req.user;

  // Validate subscription type
  if (!Object.values(SubscriptionType).includes(type)) {
    // Convert SubscriptionType values to an array
    const validSubscriptionTypes = Object.values(SubscriptionType);
    const errorMessage = "Invalid subscription type. Valid types are: " + validSubscriptionTypes.join(", ");
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: errorMessage,
    });
  }

  try {
    const user = await User.findById(_id).select("subscriptions");
    // Check if the subscription already exists
    const existingSubscription = user.subscriptions.find(
      (sub) => sub.type === type, // Use 'type' instead of 'status'
    );

    if (existingSubscription) {
      // Update the expiry date based on subscription type
      if (type === SubscriptionType.BLOOM_AGAIN_ESSENTIALS) {
        existingSubscription.endDate = moment(existingSubscription.endDate).add(1, "month").toDate();
      } else if (type === SubscriptionType.HEALING_HEARTS) {
        existingSubscription.endDate = moment(existingSubscription.endDate).add(1, "year").toDate();
      }
    } else {
      // Add new subscription
      let endDate = null;
      if (type === SubscriptionType.BLOOM_AGAIN_ESSENTIALS) {
        endDate = moment().add(1, "month").toDate();
      } else if (type === SubscriptionType.HEALING_HEARTS) {
        endDate = moment().add(1, "year").toDate();
      }

      user.subscriptions.push({
        type, // Correct 'type' field
        startDate: new Date(),
        endDate,
      });
    }

    // Save the user with the updated subscription
    await user.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "subscription_added",
      data: user.subscriptions,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "An error occurred while adding or updating the subscription",
      error,
    });
  }
};

// Remove a subscription
const removeSubscription = async (req, res) => {
  const { _id: userId } = req.user;
  const { subscriptionId } = req.params;

  try {
    // Find and remove the subscription
    const user = await User.findById(userId).select("subscriptions");
    const subscriptionIndex = user.subscriptions.findIndex((sub) => sub._id.toString() === subscriptionId);
    if (subscriptionIndex === -1) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "subscription_not",
      });
    }

    user.subscriptions.splice(subscriptionIndex, 1);

    // Save the user after removing the subscription
    await user.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "subscription_removed",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_12",
      error,
    });
  }
};

// Get all subscriptions for a user
const getSubscriptions = async (req, res) => {
  const { _id } = req.user;

  try {
    const user = await User.findById(_id).select("subscriptions");
    const subscriptions = user.subscriptions;

    if (subscriptions.length === 1 && subscriptions[0].type === SubscriptionType.SPARK_CONNECTION) {
      subscriptions[0].isActive = true;
    } else {
      const activeSubscriptions = subscriptions.filter((sub) => {
        return sub.endDate && moment(sub.endDate).isAfter(moment()) && sub.type !== SubscriptionType.SPARK_CONNECTION;
      });

      if (activeSubscriptions.length > 0) {
        const maxExpirySubscription = activeSubscriptions.reduce((maxSub, currentSub) => {
          return moment(currentSub.endDate).isAfter(moment(maxSub.endDate)) ? currentSub : maxSub;
        });

        subscriptions.forEach((sub) => {
          sub.isActive = sub._id.equals(maxExpirySubscription._id);
        });
      }
    }

    const formattedSubscriptions = subscriptions.map((sub) => {
      return {
        ...sub.toObject(),
        isActive: sub.isActive,
      };
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_subscriptions",
      data: formattedSubscriptions,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_13",
      error,
    });
  }
};

// Create a mapping for all possible fields and their respective collections
const populationFields = {};

/**
 * Dynamic population function to fetch user with populated fields.
 * @param {String} userId - The ID of the user to fetch.
 * @param {Array} fieldsToPopulate - An array of fields that need to be populated.
 * @returns {Promise<Object>} - The populated user object.
 */
const getUserWithPopulatedFields = async (userId, fieldsToPopulate = []) => {
  try {
    let query = User.findById(userId);

    // Build the dynamic population based on the fields requested
    fieldsToPopulate.forEach((field) => {
      const populationConfig = populationFields[field];
      if (populationConfig) {
        query = query.populate(populationConfig.path, populationConfig.select);
      }
    });

    // Execute the query and return the populated user
    const user = await query.exec();
    return user; // Return the user object
  } catch (error) {
    console.error("Error fetching user:", error);
    throw new Error("User fetch error"); // Let the middleware handle the error response
  }
};

/**
 * Dynamic population function to fetch user with populated fields.
 * @param {String} userId - The ID of the user to fetch.
 * @param {Array} fieldsToPopulate - An array of fields that need to be populated.
 * @returns {Promise<Object>} - The populated user object.
 */
const getUserProfile = async (req, res, next, fieldsToPopulate = []) => {
  try {
    const currentUser = req.user;

    let query = User.findById(currentUser._id);

    // Build the dynamic population based on the fields requested
    if (fieldsToPopulate.length > 0) {
      fieldsToPopulate.forEach((field) => {
        const populationConfig = populationFields[field];
        if (populationConfig) {
          query = query.populate(populationConfig.path, populationConfig.select);
        }
      });
    }

    // Execute the query and return the populated user
    const user = await query.exec();

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    const response = formatUserResponse(user, null, [], ["resetToken"]);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_fetched",
      data: response,
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: `An error occurred while fetching the user: ${error.message}`,
      error,
    });
  }
};

const getOtherUserProfile = async (req, res, next) => {
  try {
    const userId = req.params.userId;

    const [user, recentReviews] = await Promise.all([
      User.findById(userId).select("profileIcon name phoneNumber verificationStatus.phoneNumber"),
      Review.find({ object: userId, reviewType: "user" })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("subject", "name profileIcon")
        .lean(),
    ]);

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    const response = formatUserResponse(user, null, [], ["resetToken", "accountState", "metadata"]);

    // Include phone number if there are bookings with status "booked" or "picked"
    // if (bookings.length > 0) {
    response.contactInfo = {
      phoneNumber: user.phoneNumber,
      verificationStatus: user.verificationStatus.phoneNumber,
    };
    // }

    // The reviewer's icon is stored as a bare S3 key, so add the base here —
    // formatUserResponse only covers the profile's own icon.
    response.recentReviews = recentReviews.map((review) => ({
      ...review,
      subject: review.subject
        ? {
            ...review.subject,
            profileIcon: review.subject.profileIcon
              ? getFullImageUrl(review.subject.profileIcon)
              : review.subject.profileIcon,
          }
        : review.subject,
    }));

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_fetched",
      data: response,
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message,
      error,
    });
  }
};

/**
 * Update user profile function.
 * @param {Object} req - The request object containing user data.
 * @param {Object} res - The response object.
 * @param {Function} next - The next middleware function.
 * @returns {Promise<void>}
 */
const updateUserProfile = async (req, res, next) => {
  const { name, profileIcon, phoneNumber, location, distanceUnit, currencySymbol, currencyCode, language } = req.body;
  const currentUser = req.user;

  try {
    const user = await User.findById(currentUser._id);

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    if (profileIcon) {
      user.profileIcon = profileIcon;
    }

    if (distanceUnit) {
      user.distanceUnit = distanceUnit;
    }

    if (currencySymbol && currencyCode) {
      //verify currency symbol and code matches in the list
      if (currenciesData === null) {
        return sendResponse({
          res,
          statusCode: 500,
          translationKey: "currency_list_error",
        });
      }
      const currency = currenciesData.find((c) => c.symbol === currencySymbol && c.code === currencyCode);
      if (!currency) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_currency",
        });
      }

      user.currencySymbol = currencySymbol;
      user.currencyCode = currencyCode;
    }

    // Update fields if provided
    if (name && name.trim() !== "") user.name = name;
    if (phoneNumber) {
      //validate phone using validator
      if (!validator.isMobilePhone(phoneNumber)) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_phone_1",
        });
      }
      user.phoneNumber = phoneNumber;
    }

    if (location) {
      // Validate location
      const { coordinates, fullAddress } = location;
      if (!coordinates || coordinates.length !== 2 || !fullAddress) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_location_1",
        });
      }
      // Ensure coordinates are numbers
      const [longitude, latitude] = coordinates;
      if (typeof longitude !== "number" || typeof latitude !== "number") {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_coordinates",
        });
      }
      user.location = {
        type: "Point",
        coordinates: [longitude, latitude],
        fullAddress,
      };
    }

    if (language) {
      user.language = language;
    }

    // Save the updated user
    await user.save();

    userCache.del(currentUser._id.toString());

    const response = formatUserResponse(user, null, [], ["resetToken"]);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_profile",
      data: response,
    });
  } catch (error) {
    console.error("Error updating user profile:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "user_profile_update_error", // Use a translation key
      values: { errorMessage: error.message }, // Pass the error message as a dynamic value
      error,
    });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, documents } = req.body;

    const validationOptions = {
      pathParams: ["userId"],
      objectIdFields: ["userId"],
      rawData: ["status"],
      enumFields: {
        status: ["active", "inactive", "suspended", "pending"],
      },
    };

    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    const user = await User.findById(userId);

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    // Update user account state
    user.accountState.status = status;
    await user.save();

    const profileSchema = user?.accountState?.userType === "user" ? UserProfile : BusinessProfile;

    // Base update object
    const updateData = {
      status,
    };

    // If business, also update documents array
    if (user?.accountState?.userType === "business" && Array.isArray(documents)) {
      updateData.documents = documents;
    }

    await profileSchema.updateOne({ user: user._id }, { $set: updateData });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_profile_updated",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "something_went_wrong",
      error,
    });
  }
};

const reviewCertifications = async (req, res) => {
  const { userId } = req.params;
  const { action, rejectionReason } = req.body;

  const validationOptions = {
    pathParams: ["userId"],
    objectIdFields: ["userId"],
    formFields: ["action"],
    enumFields: { action: ["approve", "reject"] },
  };

  if (!validateParams(req, res, validationOptions)) return;

  if (action === "reject" && (!rejectionReason || rejectionReason.trim() === "")) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "certifications_rejection_reason_required",
    });
  }

  try {
    const profile = await BusinessProfile.findOne({ user: userId });

    if (!profile) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "business_profile_not_found",
      });
    }

    if (profile.certifications.status !== "pending") {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "certifications_not_pending",
      });
    }

    if (action === "approve") {
      profile.certifications.status = "approved";
      profile.certifications.rejectionReason = "";
      // The profile is parked in "pending" while a verification-required
      // category awaits review — approval releases it. Any other status
      // (inactive/suspended/deleted) was set deliberately, so leave it alone.
      if (profile.status === "pending") {
        profile.status = "active";
      }
    } else {
      profile.certifications.status = "rejected";
      profile.certifications.rejectionReason = rejectionReason.trim();
    }

    await profile.save();

    const certifications = profile.certifications.toObject();
    if (certifications.files?.length) {
      certifications.files = certifications.files.map((file) => getFullImageUrl(file));
    }
    certifications.optionName = await resolveBadgeOptionName(certifications);

    // The business has no request of its own to learn the outcome from — push
    // the reviewed status to whichever devices are connected.
    emitCertificationStatus({
      userId: profile.user,
      certifications,
      profileStatus: profile.status,
    });

    // …and a push/in-app notification, so the outcome still lands for a
    // business that wasn't connected when the admin reviewed it.
    const certificationLabel = certifications.optionName || certifications.name || "certification";
    sendUserNotifications({
      recipientIds: [profile.user],
      title: action === "approve" ? "Certifications Approved" : "Certifications Rejected",
      body:
        action === "approve"
          ? `Your ${certificationLabel} certification has been approved`
          : `Your ${certificationLabel} certification was rejected: ${profile.certifications.rejectionReason}`,
      data: {
        type:
          action === "approve" ? NotificationTypes.CERTIFICATION_APPROVED : NotificationTypes.CERTIFICATION_REJECTED,
        objectType: "certification",
      },
      objectId: profile._id,
      sender: req.user?._id || null,
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: action === "approve" ? "certifications_approved" : "certifications_rejected",
      data: certifications,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "certifications_review_error",
      error,
    });
  }
};

const getUserDeletionImpact = async (user, { session = null, businessProfiles: suppliedBusinessProfiles = null } = {}) => {
  const userId = user._id;
  const userProfileCountQuery = UserProfile.countDocuments({ user: userId });
  const businessProfilesQuery = suppliedBusinessProfiles
    ? null
    : BusinessProfile.find({ user: userId }).select("_id");
  if (session) {
    userProfileCountQuery.session(session);
    businessProfilesQuery?.session(session);
  }
  const userProfileCount = await userProfileCountQuery;
  const businessProfiles = suppliedBusinessProfiles || (await businessProfilesQuery.lean());
  const businessIds = businessProfiles.map((profile) => profile._id);
  const businessOwnerClause = businessIds.length ? [{ business: { $in: businessIds } }] : [];
  const bookingOwnerFilter = { $or: [{ user: userId }, ...businessOwnerClause] };
  const paymentOwnerFilter = { $or: [{ user: userId }, ...businessOwnerClause] };
  const reviewOwnerFilter = { $or: [{ subject: userId }, ...businessOwnerClause] };
  const businessRecordsFilter = { business: { $in: businessIds } };
  const pendingBookingPaymentStatuses = [
    "pending",
    "vaulted",
    "authorized",
    "requires_payment_fix",
    "capture_retrying",
  ];

  const countQueries = [
    () => Booking.countDocuments(bookingOwnerFilter),
    () => Booking.countDocuments({
      $and: [bookingOwnerFilter, { status: { $in: ["requested", "scheduled", "ongoing"] } }],
    }),
    () => Booking.countDocuments({ $and: [bookingOwnerFilter, { status: "ongoing" }] }),
    () => Booking.countDocuments({
      $and: [bookingOwnerFilter, { paymentStatus: { $in: pendingBookingPaymentStatuses } }],
    }),
    () => Booking.countDocuments({ $and: [bookingOwnerFilter, { paymentStatus: "failed" }] }),
    () => Payment.countDocuments(paymentOwnerFilter),
    () => Payment.countDocuments({ $and: [paymentOwnerFilter, { status: { $in: ["pending", "authorized"] } }] }),
    () => BookingDraft.countDocuments(bookingOwnerFilter),
    () => BookingOffer.countDocuments({
      business: { $in: businessIds },
      status: "pending",
      expiresAt: { $gt: new Date() },
    }),
    () => Dispute.countDocuments({
      $or: [{ user: userId }, ...(businessIds.length ? [{ provider: { $in: businessIds } }] : [])],
      outcome: "open",
    }),
    () => Services.countDocuments(businessRecordsFilter),
    () => Packages.countDocuments(businessRecordsFilter),
    () => Review.countDocuments(reviewOwnerFilter),
    () => Promotion.countDocuments(businessRecordsFilter),
    () => PromotionUsage.countDocuments({ user: userId }),
    () => Portfolio.countDocuments(businessRecordsFilter),
    () => ServiceCategory.countDocuments(businessRecordsFilter),
    () => BusinessAnalyticsEvent.countDocuments({
      $or: [{ user: userId }, ...businessOwnerClause],
    }),
    () => Card.countDocuments({ user: userId }),
    () => NotificationExp.countDocuments({ $or: [{ receiverId: userId }, { subjectId: userId }] }),
    () => Conversation.countDocuments({ $or: [{ "participants.user": userId }, { admins: userId }] }),
    () => Message.countDocuments({ $or: [{ senderId: userId }, { "readBy.userId": userId }] }),
    () => Session.countDocuments({ userId }),
    () => Devices.countDocuments({ userId }),
    () => Traffic.countDocuments({ profileId: userId }),
    () => SupportRequest.countDocuments({
      $or: [user.email, user.previousEmail]
        .filter(Boolean)
        .map((email) => ({ email: { $regex: `^${escapeRegExp(email)}$`, $options: "i" } })),
    }),
    () => User.countDocuments({
      _id: { $ne: userId },
      $or: [{ blockedUsers: userId }, { reportedBy: userId }],
    }),
  ];
  const countResults = [];
  for (const countQuery of countQueries) {
    const query = countQuery();
    countResults.push(await (session ? query.session(session) : query));
  }
  const [
    bookings,
    activeBookings,
    ongoingBookings,
    pendingBookingPayments,
    outstandingDebts,
    payments,
    pendingPayments,
    bookingDrafts,
    pendingBookingOffers,
    openDisputes,
    services,
    packages,
    reviews,
    promotions,
    promotionUsages,
    portfolios,
    serviceCategories,
    analyticsEvents,
    cards,
    notifications,
    conversations,
    messages,
    sessions,
    devices,
    traffic,
    supportRequests,
    accountReferences,
  ] = countResults;

  const affectedRecords = {
    user: 1,
    userProfiles: userProfileCount,
    businessProfiles: businessProfiles.length,
    bookings: {
      total: bookings,
      active: activeBookings,
      ongoing: ongoingBookings,
      pendingPayments: pendingBookingPayments,
      outstandingDebts,
    },
    payments: { total: payments, pending: pendingPayments },
    bookingDrafts,
    pendingBookingOffers,
    openDisputes,
    services,
    packages,
    reviews,
    promotions,
    promotionUsages,
    portfolios,
    serviceCategories,
    analyticsEvents,
    cards,
    notifications,
    conversations,
    messages,
    sessions,
    devices,
    traffic,
    supportRequests,
    accountReferences,
  };

  const blockingReasons = [];
  if (activeBookings) {
    blockingReasons.push({
      code: "active_bookings",
      translationKey: "user_deletion_blocked_active_bookings",
      count: activeBookings,
    });
  }
  if (pendingBookingPayments || pendingPayments) {
    blockingReasons.push({
      code: "pending_payments",
      translationKey: "user_deletion_blocked_pending_payments",
      bookingCount: pendingBookingPayments,
      paymentCount: pendingPayments,
    });
  }
  if (outstandingDebts) {
    blockingReasons.push({
      code: "outstanding_booking_debts",
      translationKey: "user_deletion_blocked_outstanding_debts",
      count: outstandingDebts,
    });
  }
  if (bookingDrafts) {
    blockingReasons.push({
      code: "booking_checkouts_in_progress",
      translationKey: "user_deletion_blocked_checkouts",
      count: bookingDrafts,
    });
  }
  if (pendingBookingOffers) {
    blockingReasons.push({
      code: "active_provider_offers",
      translationKey: "user_deletion_blocked_active_offers",
      count: pendingBookingOffers,
    });
  }
  if (openDisputes) {
    blockingReasons.push({
      code: "open_disputes",
      translationKey: "user_deletion_blocked_open_disputes",
      count: openDisputes,
    });
  }
  if (user.accountState?.status === "hardDeleted") {
    blockingReasons.push({
      code: "account_already_deleted",
      translationKey: "user_deletion_blocked_already_deleted",
    });
  }

  return {
    isDeletable: blockingReasons.length === 0,
    affectedRecords,
    blockingReasons,
  };
};

const checkUserDeletionEligibility = async (req, res) => {
  const { userId } = req.params;
  if (!validateParams(req, res, { pathParams: ["userId"], objectIdFields: ["userId"] })) return;

  try {
    const user = await User.findById(userId).select("_id email accountState.status").lean();
    if (!user) {
      return sendResponse({ res, statusCode: 404, translationKey: "user_not_found" });
    }

    const eligibility = await getUserDeletionImpact(user);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_deletion_eligibility_checked",
      data: eligibility,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "user_deletion_eligibility_error", error });
  }
};

const deleteUserAccount = async (req, res) => {
  const { userId } = req.params;
  if (!validateParams(req, res, { pathParams: ["userId"], objectIdFields: ["userId"] })) return;

  try {
    const user = await User.findById(userId).select("_id email accountState.status").lean();
    if (!user) {
      return sendResponse({ res, statusCode: 404, translationKey: "user_not_found" });
    }

    // Eligibility is recalculated here; the earlier impact-check response is never trusted.
    const eligibility = await getUserDeletionImpact(user);
    if (!eligibility.isDeletable) {
      return sendResponse({
        res,
        statusCode: 409,
        translationKey: "user_deletion_blocked",
        data: eligibility,
      });
    }

    const finalDeletionDate = new Date();
    const randomEmail = `deleted_user_${userId}_${finalDeletionDate.getTime()}@upnext.com`;
    const deletedUser = await User.findOneAndUpdate(
      { _id: userId, "accountState.status": { $ne: "hardDeleted" } },
      {
        $set: {
          email: randomEmail,
          previousEmail: user.email,
          "accountState.status": "hardDeleted",
          "accountState.finalDeletionDate": finalDeletionDate,
        },
      },
      { new: true },
    );

    if (!deletedUser) {
      return sendResponse({ res, statusCode: 409, translationKey: "user_deletion_blocked" });
    }

    // Keep historical bookings, payments and reviews; the existing account-deletion
    // flow anonymizes the account and hides its profiles rather than erasing history.
    await Promise.all([
      Devices.updateMany({ userId }, { $set: { devices: [] } }),
      UserProfile.updateMany({ user: userId }, { $set: { status: "deleted" } }),
      BusinessProfile.updateMany({ user: userId }, { $set: { status: "deleted" } }),
      User.updateMany(
        { _id: { $ne: userId }, $or: [{ blockedUsers: userId }, { reportedBy: userId }] },
        { $pull: { blockedUsers: userId, reportedBy: userId } },
      ),
      revokeAllSessions({ userId }),
    ]);

    userCache.del(userId.toString());
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "account_deleted",
      data: { userId, deleted: true, affectedRecords: eligibility.affectedRecords },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "account_deletion_error", error });
  }
};

const s3KeyFromAsset = (asset) => {
  if (typeof asset !== "string" || !asset.trim()) return null;

  const value = asset.trim().split(/[?#]/)[0];
  if (!value || value === "noimg.png") return null;
  const baseUrl = (process.env.S3_BASE_URL || "").replace(/\/+$/, "");
  if (baseUrl && value.startsWith(`${baseUrl}/`)) {
    return decodeURIComponent(value.slice(baseUrl.length + 1));
  }
  if (/^https?:\/\//i.test(value)) return null;
  return value.replace(/^\/+/, "");
};

const collectUserAssets = async ({ user, businessIds, session }) => {
  const businessProfilesQuery = BusinessProfile.find({ _id: { $in: businessIds } }).select(
    "image coverImage certifications.files",
  );
  const servicesQuery = Services.find({ business: { $in: businessIds } }).select("photos");
  const packagesQuery = Packages.find({ business: { $in: businessIds } }).select("coverImage photos");
  const promotionsQuery = Promotion.find({ business: { $in: businessIds } }).select("photos");
  const portfoliosQuery = Portfolio.find({ business: { $in: businessIds } }).select("media.file media.thumbnail");
  const bookingsQuery = Booking.find({ $or: [{ user: user._id }, { business: { $in: businessIds } }] }).select(
    "business snapshot.photos",
  );
  const assetQueries = [businessProfilesQuery, servicesQuery, packagesQuery, promotionsQuery, portfoliosQuery, bookingsQuery];
  if (session) assetQueries.forEach((query) => query.session(session));
  const [businessProfiles, services, packages, promotions, portfolios, bookings] = session
    ? [
        await businessProfilesQuery.lean(),
        await servicesQuery.lean(),
        await packagesQuery.lean(),
        await promotionsQuery.lean(),
        await portfoliosQuery.lean(),
        await bookingsQuery.lean(),
      ]
    : await Promise.all(assetQueries.map((query) => query.lean()));

  const assets = [
    user.profileIcon,
    ...businessProfiles.flatMap((profile) => [
      profile.image,
      profile.coverImage,
      ...(profile.certifications?.files || []),
    ]),
    ...services.flatMap((service) => service.photos || []),
    ...packages.flatMap((pkg) => [pkg.coverImage, ...(pkg.photos || [])]),
    ...promotions.flatMap((promotion) => promotion.photos || []),
    ...portfolios.flatMap((portfolio) => (portfolio.media || []).flatMap((media) => [media.file, media.thumbnail])),
  ];
  const businessesWithBookings = new Set(
    bookings
      .filter((booking) => businessIds.some((id) => String(id) === String(booking.business)))
      .map((booking) => String(booking.business)),
  );
  const businessImages = businessProfiles
    .filter((profile) => businessesWithBookings.has(String(profile._id)))
    .map((profile) => profile.image);
  const preservedKeys = new Set([
    ...bookings.flatMap((booking) => (booking.snapshot?.photos || []).map(s3KeyFromAsset).filter(Boolean)),
    ...businessImages.map(s3KeyFromAsset).filter(Boolean),
  ]);
  const keys = [...new Set(assets.map(s3KeyFromAsset).filter(Boolean))].filter((key) => !preservedKeys.has(key));
  if (!keys.length) return keys;

  const baseUrl = (process.env.S3_BASE_URL || "").replace(/\/+$/, "");
  const assetValues = [
    ...new Set([
      ...keys,
      ...assets.filter((asset) => typeof asset === "string"),
      ...(baseUrl ? keys.map((key) => `${baseUrl}/${key}`) : []),
    ]),
  ];
  const sharedKeys = new Set();
  const remember = (values) => {
    values
      .flat(Infinity)
      .map(s3KeyFromAsset)
      .filter(Boolean)
      .forEach((key) => sharedKeys.add(key));
  };
  const otherUserAssets = await User.find({ _id: { $ne: user._id }, profileIcon: { $in: assetValues } })
    .select("profileIcon")
    .lean();
  remember(otherUserAssets.map((otherUser) => otherUser.profileIcon));

  const otherBusinessAssets = await BusinessProfile.find({
    _id: { $nin: businessIds },
    $or: [
      { image: { $in: assetValues } },
      { coverImage: { $in: assetValues } },
      { "certifications.files": { $in: assetValues } },
    ],
  })
    .select("image coverImage certifications.files")
    .lean();
  remember(
    otherBusinessAssets.map((profile) => [profile.image, profile.coverImage, profile.certifications?.files || []]),
  );

  const otherServices = await Services.find({ business: { $nin: businessIds }, photos: { $in: assetValues } })
    .select("photos")
    .lean();
  remember(otherServices.map((service) => service.photos || []));
  const otherPackages = await Packages.find({
    business: { $nin: businessIds },
    $or: [{ coverImage: { $in: assetValues } }, { photos: { $in: assetValues } }],
  })
    .select("coverImage photos")
    .lean();
  remember(otherPackages.map((pkg) => [pkg.coverImage, pkg.photos || []]));
  const otherPromotions = await Promotion.find({ business: { $nin: businessIds }, photos: { $in: assetValues } })
    .select("photos")
    .lean();
  remember(otherPromotions.map((promotion) => promotion.photos || []));
  const otherPortfolios = await Portfolio.find({
    business: { $nin: businessIds },
    $or: [{ "media.file": { $in: assetValues } }, { "media.thumbnail": { $in: assetValues } }],
  })
    .select("media.file media.thumbnail")
    .lean();
  remember(
    otherPortfolios.map((portfolio) => (portfolio.media || []).flatMap((media) => [media.file, media.thumbnail])),
  );
  const otherBookingAssets = await Booking.find({
    $or: [{ "snapshot.photos": { $in: assetValues } }, { "snapshot.businessInfo.image": { $in: assetValues } }],
  })
    .select("snapshot.photos snapshot.businessInfo.image")
    .lean();
  remember(
    otherBookingAssets.map((booking) => [booking.snapshot?.photos || [], booking.snapshot?.businessInfo?.image]),
  );

  return keys.filter((key) => !sharedKeys.has(key));
};

const deleteS3Assets = async (keys) => {
  for (let index = 0; index < keys.length; index += 1000) {
    const response = await s3.send(
      new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (response.Errors?.length) {
      throw new Error(
        `Failed to delete ${response.Errors.length} user media file(s): ${response.Errors.map(
          ({ Key, Message }) => `${Key}: ${Message}`,
        ).join("; ")}`,
      );
    }
  }
};

const hardDeleteUserAccount = async (req, res) => {
  const { userId } = req.params;
  if (!validateParams(req, res, { pathParams: ["userId"], objectIdFields: ["userId"] })) return;

  try {
    const user = await User.findById(userId)
      .select("_id email previousEmail profileIcon accountState.userType accountState.status")
      .lean();

    if (!user) {
      const cleanup = await AccountDeletionCleanup.findOne({ userId }).lean();
      if (!cleanup) return sendResponse({ res, statusCode: 404, translationKey: "user_not_found" });

      await deleteS3Assets(cleanup.s3Keys);
      await AccountDeletionCleanup.deleteOne({ _id: cleanup._id });
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "account_deleted",
        data: { userId, deleted: true, storageCleanupComplete: true },
      });
    }

    if (user.accountState?.userType === "admin" || String(req.user?._id) === String(user._id)) {
      return sendResponse({ res, statusCode: 403, translationKey: "hard_delete_not_allowed" });
    }

    let impact;
    let s3Keys = [];
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const currentUser = await User.findById(user._id).session(session).lean();
        if (!currentUser) throw new Error("User account no longer exists");
        if (
          currentUser.accountState?.userType === "admin" ||
          String(req.user?._id) === String(currentUser._id)
        ) {
          const error = new Error("Admin accounts cannot be permanently deleted");
          error.statusCode = 403;
          throw error;
        }

        const currentBusinessProfiles = await BusinessProfile.find({ user: user._id })
          .select("_id businessName image location isAvailable")
          .session(session)
          .lean();
        const currentBusinessIds = currentBusinessProfiles.map((profile) => profile._id);
        impact = await getUserDeletionImpact(currentUser, {
          session,
          businessProfiles: currentBusinessProfiles,
        });
        const blockingReasons = impact.blockingReasons.filter((reason) => reason.code !== "account_already_deleted");
        if (blockingReasons.length) {
          const error = new Error("User account is not eligible for permanent deletion");
          error.deletionImpact = { ...impact, isDeletable: false, blockingReasons };
          throw error;
        }

        s3Keys = await collectUserAssets({
          user: currentUser,
          businessIds: currentBusinessIds,
          session,
        });

        await Booking.updateMany(
          { user: user._id },
          {
            $set: {
              "snapshot.userInfo": { _id: user._id, name: "Deleted user", profileIcon: null },
            },
          },
          { session },
        );
        for (const profile of currentBusinessProfiles) {
          await Booking.updateMany(
            { business: profile._id },
            {
              $set: {
                "snapshot.businessInfo": {
                  _id: profile._id,
                  businessName: profile.businessName,
                  image: profile.image,
                  location: profile.location,
                  isAvailable: profile.isAvailable,
                },
              },
            },
            { session },
          );
        }

        await AccountDeletionCleanup.findOneAndUpdate(
          { userId: user._id },
          { $set: { userId: user._id, s3Keys } },
          { upsert: true, new: true, session },
        );

        await UserProfile.deleteMany({ user: user._id }, { session });
        await BusinessProfile.deleteMany({ _id: { $in: currentBusinessIds } }, { session });
        await Services.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await Packages.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await Promotion.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await Portfolio.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await ServiceCategory.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await BusinessAnalyticsEvent.deleteMany({ business: { $in: currentBusinessIds } }, { session });
        await BusinessAnalyticsEvent.updateMany({ user: user._id }, { $set: { user: null } }, { session });
        await Card.deleteMany({ user: user._id }, { session });
        await Devices.deleteMany({ userId: user._id }, { session });
        await Session.deleteMany({ userId: user._id }, { session });
        await Traffic.deleteMany({ profileId: user._id }, { session });
        await BookingDraft.deleteMany(
          { $or: [{ user: user._id }, { business: { $in: currentBusinessIds } }] },
          { session },
        );
        await NotificationExp.deleteMany({ receiverId: user._id }, { session });
        await NotificationExp.updateMany({ subjectId: user._id }, { $set: { subjectId: null } }, { session });
        await Conversation.updateMany(
          { $or: [{ "participants.user": user._id }, { admins: user._id }] },
          {
            $pull: { participants: { user: user._id }, admins: user._id },
            $unset: {
              [`unreadCounts.${user._id}`]: "",
              [`lastActivity.${user._id}`]: "",
            },
          },
          { session },
        );
        await Message.updateMany({ senderId: user._id }, { $set: { senderId: null } }, { session });
        await Message.updateMany(
          { "readBy.userId": user._id },
          { $pull: { readBy: { userId: user._id } } },
          { session },
        );
        await Review.updateMany({ subject: user._id }, { $set: { subject: null } }, { session });
        await User.updateMany(
          { _id: { $ne: user._id }, $or: [{ blockedUsers: user._id }, { reportedBy: user._id }] },
          { $pull: { blockedUsers: user._id, reportedBy: user._id } },
          { session },
        );
        const supportRequestFilters = [currentUser.email, currentUser.previousEmail]
          .filter(Boolean)
          .map((email) => ({ email: { $regex: `^${escapeRegExp(email)}$`, $options: "i" } }));
        await SupportRequest.deleteMany({ $or: supportRequestFilters }, { session });
        await User.deleteOne({ _id: user._id }, { session });
      });
    } finally {
      await session.endSession();
    }

    userCache.del(String(user._id));

    try {
      await deleteS3Assets(s3Keys);
      await AccountDeletionCleanup.deleteOne({ userId: user._id });
    } catch (error) {
      return sendResponse({
        res,
        statusCode: 500,
        translationKey: "hard_delete_storage_cleanup_pending",
        data: { userId, deleted: true, storageCleanupPending: true },
        error,
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "account_deleted",
      data: {
        userId,
        deleted: true,
        preserved: {
          bookings: impact.affectedRecords.bookings.total,
          payments: impact.affectedRecords.payments.total,
          reviews: impact.affectedRecords.reviews,
        },
        storageCleanupComplete: true,
      },
    });
  } catch (error) {
    if (error.statusCode === 403) {
      return sendResponse({ res, statusCode: 403, translationKey: "hard_delete_not_allowed" });
    }
    if (error.deletionImpact) {
      return sendResponse({
        res,
        statusCode: 409,
        translationKey: "user_deletion_blocked",
        data: error.deletionImpact,
      });
    }
    return sendResponse({ res, statusCode: 500, translationKey: "hard_delete_error", error });
  }
};

module.exports = {
  blockUser,
  reportUser,
  addOrUpdateSubscription,
  removeSubscription,
  getSubscriptions,
  getUserWithPopulatedFields,
  getUserProfile,
  updateUserProfile,
  getOtherUserProfile,
  updateProfile,
  reviewCertifications,
  checkUserDeletionEligibility,
  deleteUserAccount,
  hardDeleteUserAccount,
};
