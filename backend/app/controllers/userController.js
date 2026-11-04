const { User, SubscriptionType } = require("@models/UserModel");
const moment = require("moment");
const bcrypt = require("bcryptjs");
const { sendResponse, validateParams, cleanfiles, fireAndForget } = require("@utils/responseUtil");
const BusinessAnalyticsEvent = require("@models/BusinessAnalyticsEvent");
const { formatUserResponse, attachProfile } = require("@utils/userResponseUtil");
const { syncProfileFlags } = require("@utils/profileFlagsUtil");
const { NotificationTypes } = require("@models/Notifications");
const validator = require("validator");
const { userCache } = require("@config/nodeCache");
const { UserProfile } = require("@models/UserProfile");
const BusinessProfile = require("@models/BusinessProfile");
const { default: mongoose } = require("mongoose");
const Category = require("@models/Category");
const { Tag } = require("@models/Tag");
const { Badge } = require("@models/Badge");
const {
  paginationPipeline,
  businessHelperPipeline,
  finalRes,
  nearestFirstStages,
} = require("@utils/aggregationHelper");
const { validateSlotsFormat, regenerateBusinessHourSlots } = require("@utils/serviceUtil");
const { getFullImageUrl } = require("@utils/imageHelper");
const { getCategories } = require("../../commonModules/controllers/categoryController");
const { validateBadgeOptionRef, resolveBadgeOptionName } = require("@utils/badgeUtil");
const { Session, createSession } = require("@models/Session");
const { getUsersOnlineMap } = require("../../commonModules/chatModule/sockets/chatPresenceRedis");
const { safeKeyword, escapeRegExp } = require("@helperUtils/regexUtil");
const { generateUniqueSlug } = require("@utils/slugUtil");
const { suggestBusinessDescription } = require("@services/ai/features/suggestBusinessDescription");
const { resolveNaturalSearch } = require("@services/ai/features/naturalSearch");
const { applyAvailability } = require("@utils/availabilityHelper");
const { getServices } = require("./serviceController");
const { getPackages } = require("./packageController");
const { getPortfolios } = require("./portfolioController");

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
    response.profile = (await attachProfile(user)).profile;
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

    // accountState.userType is what attachProfile branches on — without it
    // every account would resolve to the customer UserProfile branch.
    const user = await User.findById(userId).select("profileIcon name phoneNumber accountState.userType");

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    const response = formatUserResponse(user, null, [], ["resetToken", "accountState", "metadata", "security"]);

    // Same profile the caller gets for themselves on GET /users/profile —
    // attachProfile returns the BusinessProfile for a business account and the
    // UserProfile for a customer, and null when that profile isn't active.
    response.profile = (await attachProfile(user)).profile;

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

    if (profileIcon !== undefined) {
      user.profileIcon = cleanfiles(profileIcon);
    }

    if (distanceUnit) {
      user.distanceUnit = distanceUnit;
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
const validateLocation = (location) => {
  const { type, coordinates, address } = location;

  if (type !== "Point") return "invalid_location_type";

  if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
    return "invalid_location_1";
  }

  const [longitude, latitude] = coordinates;

  if (typeof longitude !== "number" || typeof latitude !== "number") {
    return "invalid_coordinates";
  }

  if (!address || address.trim() === "") {
    return "invalid_location_address";
  }

  return null;
};

const validateBadges = (badges) => {
  if (!badges) return null;

  for (const key of Object.keys(badges)) {
    const badge = badges[key];

    if (!badge.badgeId || !badge.badgeName || !badge.optionId || !badge.optionName) {
      return "invalid_badge_payload";
    }

    if (!mongoose.Types.ObjectId.isValid(badge.badgeId) || !mongoose.Types.ObjectId.isValid(badge.optionId)) {
      return "invalid_badge_id";
    }
  }

  return null;
};

const createOrUpdateUserProfile = async (req, res) => {
  const { name, phoneNumber, location, description, badges, categories, profileIcon } = req.body;
  const currentUser = req.user;

  try {
    const validationOptions = {
      rawData: ["description", "location", "badges", "categories"],
      objectIdFields: ["categories"],
    };

    if (!validateParams(req, res, validationOptions)) {
      return; // Validation failed, response already sent
    }
    const validBadges = await Badge.find({ _id: { $in: Object.values(badges || {}).map((b) => b.badgeId) } }).lean();
    if (validBadges.length !== Object.values(badges || {}).length) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "one_or_more_badges_not_found",
      });
    }
    const updateData = {};
    const coreUser = {};
    if (name && name.trim() !== "") coreUser.name = name;

    if (profileIcon !== undefined) {
      coreUser.profileIcon = cleanfiles(profileIcon);
    }

    if (phoneNumber) {
      //validate phone using validator
      if (!validator.isMobilePhone(phoneNumber)) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_phone_1",
        });
      }
      coreUser.phoneNumber = phoneNumber;
    }
    if (location) {
      const locationError = validateLocation(location);

      if (locationError) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: locationError,
        });
      }
      updateData.location = {
        type: "Point",
        coordinates: location.coordinates,
        address: location.address,
      };
    }

    if (description && description.trim() !== "") {
      updateData.description = description;
    }

    if (categories?.length) {
      const categoryDocs = await Category.find({ _id: { $in: categories } }).lean();
      if (categoryDocs.length !== categories.length) {
        return sendResponse({
          res,
          statusCode: 404,
          translationKey: "category_not",
        });
      }
      // Single combined array — { _id, name } — name denormalized at write time
      updateData.categories = categoryDocs.map((c) => ({ _id: c._id, name: c.name || "" }));
    }

    if (badges) {
      const badgeError = validateBadges(badges);

      if (badgeError) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: badgeError,
        });
      }
      updateData.badges = badges;
    }

    const session = await mongoose.startSession();
    let userProfile;
    try {
      session.startTransaction();

      if (Object.keys(coreUser).length) {
        await User.updateOne({ _id: currentUser._id }, { $set: coreUser }, { session });
      }

      userProfile = await UserProfile.findOneAndUpdate(
        { user: currentUser._id },
        {
          $set: updateData,
          $setOnInsert: {
            user: currentUser._id,
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          session,
        },
      );

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error; // handled by the outer catch
    } finally {
      await session.endSession();
    }

    userCache.del(currentUser._id.toString());

    const updatedUser = await User.findById(currentUser._id).lean();
    const { basicInfo } = formatUserResponse(updatedUser, null, [], ["resetToken"]);

    const profileResponse = userProfile.toObject();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_profile",
      data: { ...profileResponse, basicInfo },
    });
  } catch (error) {
    console.error("Error creating or updating user profile:", error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "user_profile_update_error",
      values: { errorMessage: error.message },
      error,
    });
  }
};

const suggestBusinessProfileDescription = async (req, res) => {
  const { businessName, categories, skills } = req.body;
  const tags = Array.isArray(req.body.tags)
    ? req.body.tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
  const categoryNames = Array.isArray(categories)
    ? categories
        .map((category) => (typeof category === "string" ? category : category?.name))
        .filter((category) => typeof category === "string" && category.trim())
    : [];
  const skillNames = Array.isArray(skills) ? skills.filter((skill) => typeof skill === "string" && skill.trim()) : [];
  const normalizedBusinessName = typeof businessName === "string" ? businessName.trim() : "";

  if (!tags.length && !categoryNames.length && !skillNames.length && !normalizedBusinessName) {
    return sendResponse({ res, statusCode: 400, translationKey: "business_description_suggest_missing_input" });
  }

  try {
    const description = await suggestBusinessDescription({
      tags,
      businessName,
      categories,
      skills,
    });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "business_description_suggested",
      data: { description, suggested: true },
    });
  } catch (error) {
    console.error("suggestBusinessProfileDescription failed", error);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "business_description_suggested",
      data: {
        description: [normalizedBusinessName, ...categoryNames, ...skillNames, ...tags].join(", "),
        suggested: false,
        reason: "ai_unavailable",
      },
    });
  }
};

const createOrUpdateBusinessProfile = async (req, res) => {
  const {
    businessName,
    image,
    coverImage,
    categories,
    tags,
    location,
    businessType,
    teamSize,
    yearsOfExperience,
    description,
    badges,
    socialLinks,
    certificationFiles,
    skills,
    certificationBadgeId,
    certificationOptionId,
    isAvailable,
    operatingHours,
  } = req.body;

  const currentUser = req.user;

  try {
    const validationOptions = {
      rawData: ["categories", "location", "badges", "image", "coverImage", "businessType"],
      objectIdFields: ["categories", "tags"],
    };

    if (!validateParams(req, res, validationOptions)) {
      return; // Validation failed, response already sent
    }
    const validBadges = await Badge.find({ _id: { $in: Object.values(badges || {}).map((b) => b.badgeId) } }).lean();
    if (validBadges.length !== Object.values(badges || {}).length) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "one_or_more_badges_not_found",
      });
    }
    const updateData = {};
    const existingProfile = await BusinessProfile.findOne({ user: currentUser._id })
      .select("certifications categories nameSlug businessName")
      .lean();

    if (categories?.length) {
      const categoryObjs = await Category.find({ _id: { $in: categories } }).lean();
      if (categoryObjs.length !== categories.length) {
        return sendResponse({
          res,
          statusCode: 404,
          translationKey: "category_not",
        });
      }
      // Single combined array — { _id, name } — name denormalized at write time
      updateData.categories = categoryObjs.map((c) => ({ _id: c._id, name: c.name || "" }));
      const needToVerifyList = ["Licensed Professional"];
      const needsVerification = categoryObjs.some((c) => needToVerifyList.includes(c?.translations?.en || c?.name));
      const certStatus = existingProfile?.certifications?.status;
      if (needsVerification && certStatus === "pending") {
        updateData.status = "pending";
      }
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return sendResponse({ res, statusCode: 400, translationKey: "invalid_tags" });
      }
      const tagDocs = await Tag.find({ _id: { $in: tags }, status: "active" }).lean();
      if (tagDocs.length !== tags.length) {
        return sendResponse({ res, statusCode: 404, translationKey: "tag_not_found" });
      }
      const categoryIds = new Set(
        (categories?.length ? categories : existingProfile?.categories || []).map((category) =>
          String(category?._id ?? category),
        ),
      );
      if (tagDocs.some((tag) => !categoryIds.has(String(tag.category)))) {
        return sendResponse({ res, statusCode: 400, translationKey: "tag_category_not_allowed" });
      }
      updateData.tags = tagDocs.map((tag) => ({ _id: tag._id, name: tag.name }));
    }
    if (location) {
      const locationError = validateLocation(location);

      if (locationError) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: locationError,
        });
      }
      updateData.location = {
        type: "Point",
        coordinates: location.coordinates,
        address: location.address,
      };
    }

    if (businessName && businessName.trim() !== "") {
      const trimmedBusinessName = businessName.trim();
      const duplicateName = await BusinessProfile.findOne({
        user: { $ne: currentUser._id },
        businessName: { $regex: `^${escapeRegExp(trimmedBusinessName)}$`, $options: "i" },
      })
        .select("_id")
        .lean();
      if (duplicateName) {
        return sendResponse({ res, statusCode: 409, translationKey: "business_name_already_exists" });
      }
      updateData.businessName = trimmedBusinessName;
    }

    if (image !== undefined) {
      updateData.image = cleanfiles(image);
    }

    if (coverImage !== undefined) {
      updateData.coverImage = cleanfiles(coverImage);
    }

    if (businessType) {
      updateData.businessType = businessType;
    }

    if (teamSize !== undefined) {
      updateData.teamSize = teamSize;
    }

    if (yearsOfExperience !== undefined) {
      updateData.yearsOfExperience = yearsOfExperience;
    }

    if (description && description.trim() !== "") {
      updateData.description = description;
    }

    if (badges) {
      const badgeError = validateBadges(badges);

      if (badgeError) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: badgeError,
        });
      }
      updateData.badges = badges;
    }

    if (socialLinks) {
      updateData.socialLinks = socialLinks;
    }

    if (Array.isArray(skills)) {
      updateData.skills = skills;
    }
    if (Array.isArray(certificationFiles) && certificationFiles.length > 0) {
      const prevCerts = existingProfile?.certifications;
      // "name" is not client-settable — it's always derived from the resolved
      // badge option (e.g. "Licensed Cosmetologist"). badgeId/optionId fall
      // back to whatever's already stored so a file-only resubmission still works.
      const effectiveCertBadgeId = certificationBadgeId || prevCerts?.badgeId;
      const effectiveCertOptionId = certificationOptionId || prevCerts?.optionId;
      if (!effectiveCertBadgeId || !effectiveCertOptionId) {
        return sendResponse({ res, statusCode: 400, translationKey: "certification_type_required" });
      }

      const badgeRefError = await validateBadgeOptionRef({
        badgeId: effectiveCertBadgeId,
        optionId: effectiveCertOptionId,
      });
      if (badgeRefError) {
        return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
      }
      const certOptionName = await resolveBadgeOptionName({
        badgeId: effectiveCertBadgeId,
        optionId: effectiveCertOptionId,
      });

      // Same-submission guard as the dedicated certifications endpoint —
      // resubmitting identical files must not reset the review state
      const isUnchangedSubmission =
        prevCerts &&
        prevCerts.badgeId?.toString() === effectiveCertBadgeId?.toString() &&
        prevCerts.optionId?.toString() === effectiveCertOptionId?.toString() &&
        JSON.stringify(cleanfiles(prevCerts.files || [])) === JSON.stringify(cleanfiles(certificationFiles)) &&
        ["pending", "approved"].includes(prevCerts.status);

      if (!isUnchangedSubmission) {
        const isFirstSubmission = !prevCerts || prevCerts.status === "not_submitted";
        updateData["certifications.files"] = cleanfiles(certificationFiles);
        updateData["certifications.status"] = "pending";
        updateData["certifications.rejectionReason"] = "";
        updateData["certifications.version"] = isFirstSubmission ? 1 : (prevCerts.version || 1) + 1;
        updateData["certifications.name"] = certOptionName;
        updateData["certifications.badgeId"] = effectiveCertBadgeId;
        updateData["certifications.optionId"] = effectiveCertOptionId;
      }
    }

    if (isAvailable !== undefined) {
      updateData.isAvailable = isAvailable;
    }
    if (Array.isArray(operatingHours) && operatingHours.length > 0) {
      const err = validateSlotsFormat(operatingHours);
      if (err) {
        return sendResponse({
          res,
          statusCode: 400,
          ...err,
        });
      }
      updateData.operatingHours = operatingHours;
    }

    // Generated once, on the profile's first business name — never rewritten
    // by later name changes, so existing public links keep working.
    if (!existingProfile?.nameSlug) {
      const nameForSlug = updateData.businessName || existingProfile?.businessName;
      if (nameForSlug && nameForSlug.trim() !== "") {
        updateData.nameSlug = await generateUniqueSlug(BusinessProfile, nameForSlug);
      }
    }

    const businessProfile = await BusinessProfile.findOneAndUpdate(
      { user: currentUser._id },
      {
        $set: updateData,
        $setOnInsert: {
          user: currentUser._id,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      },
    );

    userCache.del(currentUser._id.toString());

    // Keep business-hours services/packages in sync with the new hours
    if (updateData.operatingHours) {
      await regenerateBusinessHourSlots(businessProfile._id, businessProfile.operatingHours);
    }

    const responseData = businessProfile.toObject();
    if (responseData.certifications) {
      responseData.certifications.optionName = await resolveBadgeOptionName(responseData.certifications);
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "business_profile",
      data: responseData,
    });
  } catch (error) {
    console.error("Error creating or updating business profile:", error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "business_profile_update_error",
      values: { errorMessage: error.message },
      error,
    });
  }
};

const switchAccount = async (req, res) => {
  try {
    const { _id, userType, businessId, profileId } = req.user;

    // Determine next state
    const isBusiness = userType === "business";
    const nextType = isBusiness ? "user" : "business";
    const profileKey = isBusiness ? businessId : profileId;

    if (!profileKey) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "fill_current_profile_first",
      });
    }

    // Grants eligibility (roles) and flips accountState.userType. userType
    // is read fresh from the DB on every request (see authMiddleware), so
    // this takes effect immediately across every gated route — including
    // every other active session/device this account is logged in on, not
    // just the caller's. That's an accepted tradeoff: one account, one
    // active mode at a time.
    const updatedUser = await User.findByIdAndUpdate(
      _id,
      {
        $addToSet: {
          "accountState.roles": nextType,
        },
        $set: {
          "accountState.userType": nextType,
        },
      },
      { new: true },
    );

    if (!updatedUser) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not_found",
      });
    }

    // Rotate the caller's own session so it gets a fresh token/refreshToken
    // reflecting the new userType, the same session-issuing path login uses —
    // just skipping credential re-verification since this request already
    // came in on a valid session.
    const currentSession = await Session.findOne({ userId: _id, sessionId: req.sessionId }).select(
      "deviceId deviceType",
    );
    const deviceType = currentSession?.deviceType || req.user.deviceType || null;
    const { sessionId, refreshToken } = await createSession({
      userId: _id,
      deviceId: currentSession?.deviceId || null,
      deviceType,
    });
    const token = updatedUser.generateAuthToken(sessionId, deviceType);

    // The client reads hasUserProfile/hasBusinessProfile off this response to
    // decide whether the mode it just switched into lands on a usable app or on
    // the "create your profile" screen, so resolve them rather than trusting
    // what findByIdAndUpdate returned — authMiddleware's own correction for this
    // request is fire-and-forget and may not have landed yet.
    await syncProfileFlags(updatedUser);

    const response = formatUserResponse(updatedUser, token, [], ["resetToken"]);
    response.refreshToken = refreshToken;
    response.profile = (await attachProfile(updatedUser)).profile;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: nextType === "business" ? "business_role_enabled" : "user_role_enabled",
      data: response,
    });
  } catch (error) {
    console.error("Error switching account:", error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "switch_account_error",
      values: { errorMessage: error.message },
      error,
    });
  }
};

const submitCertifications = async (req, res) => {
  const { _id: userId } = req.user;
  const { files, badgeId, optionId } = req.body;

  const validationOptions = {
    rawData: ["files"],
  };

  if (!validateParams(req, res, validationOptions)) return;

  if (!Array.isArray(files) || files.length === 0) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "certifications_files_required",
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

    const prevCerts = profile.certifications;
    // "name" is not client-settable — it's always derived from the resolved
    // badge option (e.g. "Licensed Cosmetologist"). badgeId/optionId fall
    // back to whatever's already stored so a file-only resubmission still works.
    const effectiveBadgeId = badgeId || prevCerts.badgeId;
    const effectiveOptionId = optionId || prevCerts.optionId;
    if (!effectiveBadgeId || !effectiveOptionId) {
      return sendResponse({ res, statusCode: 400, translationKey: "certification_type_required" });
    }

    const badgeRefError = await validateBadgeOptionRef({ badgeId: effectiveBadgeId, optionId: effectiveOptionId });
    if (badgeRefError) {
      return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
    }
    const optionName = await resolveBadgeOptionName({ badgeId: effectiveBadgeId, optionId: effectiveOptionId });

    // Normalize to bare filenames so re-submitting the full URLs from a GET
    // response still counts as "the same files"
    const newFiles = cleanfiles(files);
    const isUnchangedSubmission =
      prevCerts.badgeId?.toString() === effectiveBadgeId?.toString() &&
      prevCerts.optionId?.toString() === effectiveOptionId?.toString() &&
      JSON.stringify(cleanfiles(prevCerts.files || [])) === JSON.stringify(newFiles) &&
      ["pending", "approved"].includes(prevCerts.status);

    if (isUnchangedSubmission) {
      const unchanged = prevCerts.toObject();
      if (unchanged.files?.length) {
        unchanged.files = unchanged.files.map((file) => getFullImageUrl(file));
      }
      unchanged.optionName = optionName;
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "certifications_unchanged",
        data: unchanged,
      });
    }

    const isFirstSubmission = prevCerts.status === "not_submitted";
    profile.certifications.name = optionName;
    profile.certifications.files = newFiles;
    profile.certifications.status = "pending";
    profile.certifications.rejectionReason = "";
    profile.certifications.version = isFirstSubmission ? 1 : (prevCerts.version || 1) + 1;
    profile.certifications.badgeId = effectiveBadgeId;
    profile.certifications.optionId = effectiveOptionId;

    await profile.save();

    const certifications = profile.certifications.toObject();
    if (certifications.files?.length) {
      certifications.files = certifications.files.map((file) => getFullImageUrl(file));
    }
    certifications.optionName = optionName;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "certifications_submitted",
      data: certifications,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "certifications_submit_error",
      error,
    });
  }
};

// PATCH /business-profile/operating-hours — dedicated, business-only
const updateOperatingHours = async (req, res) => {
  const { _id: userId } = req.user;
  const { operatingHours } = req.body;

  const validationOptions = {
    rawData: ["operatingHours"],
  };

  if (!validateParams(req, res, validationOptions)) return;

  if (!Array.isArray(operatingHours) || operatingHours.length === 0) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "operating_hours_required",
    });
  }

  const formatError = validateSlotsFormat(operatingHours);
  if (formatError) {
    return sendResponse({
      res,
      statusCode: 400,
      ...formatError,
    });
  }

  try {
    const profile = await BusinessProfile.findOneAndUpdate(
      { user: userId },
      { $set: { operatingHours } },
      { new: true, runValidators: true },
    ).select("operatingHours");

    if (!profile) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "business_profile_not_found",
      });
    }

    // Keep business-hours services/packages in sync with the new hours
    await regenerateBusinessHourSlots(profile._id, profile.operatingHours);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "operating_hours_updated",
      data: { operatingHours: profile.operatingHours },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

// PATCH /users/business-profile/availability — toggle whether the business
// currently shows up as bookable (req.user.isAvailable, cached at auth time,
// must be invalidated so the change takes effect on the very next request).
const updateAvailability = async (req, res) => {
  const { _id: userId } = req.user;
  const { isAvailable } = req.body;

  if (typeof isAvailable !== "boolean") {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "invalid_enum_value",
      values: { field: "isAvailable", allowedValues: "true, false", invalidValues: String(isAvailable) },
    });
  }

  try {
    const profile = await BusinessProfile.findOneAndUpdate(
      { user: userId },
      { $set: { isAvailable } },
      { new: true },
    ).select("isAvailable");

    if (!profile) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    userCache.del(userId.toString());

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "availability_updated",
      data: { isAvailable: profile.isAvailable },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// Filter options for the app's businesses tabs
const businessTypeList = ["all", "solo", "team"];

const getUserBusinesses = async (req, res) => {
  const validationOptions = {
    enumFields: {
      status: ["pending", "active", "inactive", "suspended", "deleted"],
      sortBy: businessSortList,
    },
    dateFields: {
      date: "YYYY-MM-DD",
    },
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    const businessResult = await getBusinesses({
      req,
      filter: {},
    });

    const businesses = Array.isArray(businessResult.data) ? businessResult.data : [];

    if (req.user?.userType === "user" && businesses.length) {
      fireAndForget(
        BusinessAnalyticsEvent.insertMany(
          businesses.map((business) => ({
            business: business._id,
            type: "search_impression",
            user: req.user._id,
          })),
        ),
        "search_impression tracking",
      );
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: businesses,
      meta: {
        ...businessResult.meta,
        businessTypeList,
        sortByList: businessSortList,
      },
    });
  } catch (error) {
    console.error(error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

// GET /users/businesses — paginated businesses list
const getAllBusinesses = async (req, res) => {
  const validationOptions = {
    enumFields: {
      status: ["pending", "active", "inactive", "suspended", "deleted"],
      sortBy: businessSortList,
    },
    dateFields: {
      date: "YYYY-MM-DD",
    },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const keyword = String(req.query.keyword || "").trim();
    let naturalSearch = null;
    let businessFilter = {};
    let searchReq = req;
    let services = [];
    let packages = [];
    let portfolios = [];

    if (keyword) {
      naturalSearch = await resolveNaturalSearch(keyword);
      if (naturalSearch.hasText) {
        const ownerIds = await User.find({
          $or: [{ name: { $in: naturalSearch.regexes } }, { email: { $in: naturalSearch.regexes } }],
        }).distinct("_id");
        businessFilter.$or = [
          { _id: { $in: naturalSearch.businessIds } },
          { businessName: { $in: naturalSearch.regexes } },
          { "categories.name": { $in: naturalSearch.regexes } },
          { "tags.name": { $in: naturalSearch.regexes } },
          { description: { $in: naturalSearch.regexes } },
          { skills: { $in: naturalSearch.regexes } },
          ...(ownerIds.length ? [{ user: { $in: ownerIds } }] : []),
        ];
      }
      // Day/time phrases from the keyword apply as filters; explicit params win.
      searchReq = { ...req, query: { ...naturalSearch.availability, ...req.query, keyword: undefined } };
    }

    const businessResult = await getBusinesses({ req: searchReq, filter: businessFilter });
    const businesses = Array.isArray(businessResult.data) ? businessResult.data : [];
    const meta = businessResult.meta;

    if (keyword) {
      const matchedBusinessIds = await BusinessProfile.distinct("_id", businessResult.filter);
      const entityReq = {
        ...req,
        query: { ...naturalSearch.availability, ...req.query, keyword: undefined, status: "active" },
      };
      const [serviceResult, packageResult, portfolioResult] = await Promise.all([
        getServices({
          filter: { ...naturalSearch.serviceFilter, business: { $in: matchedBusinessIds } },
          req: entityReq,
        }),
        getPackages({
          filter: { ...naturalSearch.packageFilter, business: { $in: matchedBusinessIds } },
          req: entityReq,
        }),
        getPortfolios({
          filter: { ...naturalSearch.portfolioFilter, business: { $in: matchedBusinessIds } },
          req: entityReq,
        }),
      ]);
      services = Array.isArray(serviceResult.data) ? serviceResult.data : [];
      packages = Array.isArray(packageResult.data) ? packageResult.data : [];
      portfolios = Array.isArray(portfolioResult.data) ? portfolioResult.data : [];
    }

    const data = { businesses, packages, services, portfolios };

    // Analytics: a business "appearing in search" is an impression on every
    // business in the returned page — only counted for customers browsing,
    // not admins or businesses looking at other businesses. Public/unauthenticated
    // browsing (req.user undefined) is skipped since there's no user to attribute it to.
    if (req.user?.userType === "user" && businesses?.length) {
      fireAndForget(
        BusinessAnalyticsEvent.insertMany(
          businesses.map((business) => ({ business: business._id, type: "search_impression", user: req.user._id })),
        ),
        "search_impression tracking",
      );
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data,
      meta: { ...meta, businessTypeList, sortByList: businessSortList },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

// Sort options for the public/app business listing — "best_match" (default)
// leaves the pipeline's natural order untouched.
const businessSortMap = {
  rating_high_low: { "rating.avgRating": -1, "rating.totalReviews": -1 },
  price_low_high: { "priceRange.min": 1 },
  price_high_low: { "priceRange.min": -1 },
};
// Nearest-first isn't in the map above: it sorts on a substitute key that only
// exists once lat/lng are supplied, so getBusinesses builds its stages instead
// of reading a fixed $sort spec out of the map.
const NEAREST_SORT = "distance_near_far";
const businessSortList = ["best_match", NEAREST_SORT, ...Object.keys(businessSortMap)];

const getBusinesses = async ({ req, filter, naturalSearch = null }) => {
  try {
    const {
      page,
      limit,
      keyword,
      businessType,
      categoryId,
      isAvailable,
      minExperience,
      badges,
      status,
      location,
      sortBy,
      lat,
      lng,
    } = req?.query || {};
    filter = { ...(filter || {}) };
    if (req?.user?.userType === "admin") {
      // Admin can see every status, or narrow to one via ?status= — non-admins
      // are always restricted to active businesses regardless of this param.
      if (status) filter.status = status;
    } else {
      filter.status = "active";
    }
    if (naturalSearch?.hasText) {
      filter.$or = [
        { _id: { $in: naturalSearch.businessIds } },
        { businessName: { $in: naturalSearch.regexes } },
        { "categories.name": { $in: naturalSearch.regexes } },
        { "tags.name": { $in: naturalSearch.regexes } },
        { description: { $in: naturalSearch.regexes } },
        { skills: { $in: naturalSearch.regexes } },
      ];
    } else if (keyword && !naturalSearch) {
      // Escaped and length-capped — the raw keyword goes into $regex, so an
      // unescaped "(" would otherwise be an invalid-regex 500 (and a ReDoS door).
      const kw = { $regex: safeKeyword(keyword), $options: "i" };
      // The owner's name lives on the User doc, which businessHelperPipeline
      // only joins in after this $match — so it can't be matched by path here.
      // Resolving the ids up front keeps `filter` a plain match object, which
      // countBusinessStatuses reuses verbatim for the status tabs.
      const ownerIds = await User.find({ $or: [{ name: kw }, { email: kw }] }).distinct("_id");
      filter.$or = [
        { businessName: kw },
        { "categories.name": kw },
        { skills: kw },
        ...(ownerIds.length ? [{ user: { $in: ownerIds } }] : []),
      ];
    }
    if (businessType && businessType !== "all") {
      filter.businessType = businessType;
    }
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      filter["categories._id"] = new mongoose.Types.ObjectId(categoryId);
    }
    if (isAvailable === "true" || isAvailable === "false") {
      filter.isAvailable = isAvailable === "true";
    }
    if (location) {
      // Free-text match against the stored address (no discrete city/state
      // fields exist on BusinessProfile.location) — matches e.g. "Charlotte, NC"
      filter["location.address"] = { $regex: location, $options: "i" };
    }
    if (minExperience != null && !isNaN(Number(minExperience))) {
      filter.yearsOfExperience = { $gte: Number(minExperience) };
    }
    if (badges) {
      const badgeGroups = Object.keys(BusinessProfile.schema.obj.badges);
      const badgeIds = String(badges)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      if (badgeIds.length) {
        // Business must hold every requested badge (id matches the badge or its selected option, in any group)
        filter.$and = badgeIds.map((id) => ({
          $or: badgeGroups.flatMap((group) => [
            { [`badges.${group}.badgeId`]: id },
            { [`badges.${group}.optionId`]: id },
          ]),
        }));
      }
    }
    // `date` keeps its old meaning (open on that weekday) and now also combines
    // with time/timeFrom/timeTo; added after badges, which assign filter.$and.
    applyAvailability(filter, req, "business", { useDate: true });
    const pipeline = [
      ...businessHelperPipeline({
        filter,
        userLat: lat != null ? Number(lat) : null,
        userLng: lng != null ? Number(lng) : null,
      }),
    ];
    if (sortBy === "price_low_high" || sortBy === "price_high_low") {
      pipeline.push({
        $match: {
          "priceRange.min": { $gte: 1 },
        },
      });
    }
    // Sorting precedes pagination below, so nearest-first genuinely picks the
    // closest N rather than reordering an arbitrary page. Asking for it without
    // lat/lng is a no-op — there is no distance to order by.
    if (sortBy === NEAREST_SORT) {
      if (lat != null && lng != null) pipeline.push(...nearestFirstStages("$distanceKm"));
    } else if (businessSortMap[sortBy]) {
      pipeline.push({ $sort: businessSortMap[sortBy] });
    }
    if (page && limit) {
      pipeline.push(paginationPipeline({ page, limit }));
    }
    const res = await BusinessProfile.aggregate(pipeline);
    const finalResponse = finalRes({ page, limit, data: res });

    // Live presence for the green dot, distinct from isAvailable (the business's
    // own "accepting bookings" toggle). The profile's `user` is the User _id the
    // chat presence set is keyed by, so this is the same lookup fetchChats does —
    // one batched Redis pipeline for the whole page, all-false when Redis is down.
    const onlineMap = await getUsersOnlineMap((finalResponse.data || []).map((b) => b.user));
    finalResponse.data = (finalResponse.data || []).map((business) => ({
      ...business,
      isOnline: Boolean(onlineMap.get(String(business.user))),
    }));

    // The composed filter goes back with the results so a caller that needs
    // per-status tab counts can reuse it verbatim (see countBusinessStatuses)
    // instead of rebuilding — and drifting from — this same query.
    return { ...finalResponse, filter };
  } catch (error) {
    throw new Error("Error fetching businesses: " + error.message);
  }
};

/**
 * Counts per business status for the list's status tabs, from the filter
 * getBusinesses composed minus its own status — selecting a tab must not change
 * the numbers on the tabs, while every other filter (keyword, type, category…)
 * narrows all of them together. Zero-filled from the schema enum, "all" first,
 * matching the bookings list's meta.statuses and the customers list's statusList.
 */
const countBusinessStatuses = async (filter = {}) => {
  const baseFilter = { ...filter };
  delete baseFilter.status;

  const counts = await BusinessProfile.aggregate([
    { $match: baseFilter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const statusList = { all: 0 };
  BusinessProfile.schema.path("status").enumValues.forEach((status) => {
    statusList[status] = 0;
  });
  counts.forEach(({ _id, count }) => {
    statusList.all += count;
    if (_id in statusList) statusList[_id] = count;
  });
  return statusList;
};

// GET /users/categories — the categories selected on the caller's own
// UserProfile/BusinessProfile, with keyword search + pagination, active only
const getSelectedCategories = async (req, res) => {
  try {
    const { _id: userId, userType } = req.user;

    const ProfileModel = userType === "business" ? BusinessProfile : UserProfile;
    const profile = await ProfileModel.findOne({ user: userId }).select("categories").lean();
    const categoryIds = (profile?.categories || []).map((c) => c?._id ?? c);

    const { data, meta } = await getCategories({
      filter: { _id: { $in: categoryIds }, status: "active" },
      req,
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "categories_fetched_successfully",
      data,
      meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

// GET /users/notification-preferences — the caller's own toggle settings
const getNotificationPreferences = async (req, res) => {
  try {
    const { _id: userId, userType } = req.user;
    const ProfileModel = userType === "business" ? BusinessProfile : UserProfile;

    // Not .lean() — a profile saved before this field existed has nothing stored
    // under notificationPreferences yet, and only a hydrated Mongoose document
    // applies the schema's per-toggle defaults for a field that's actually missing.
    const profile = await ProfileModel.findOne({ user: userId }).select("notificationPreferences");
    if (!profile) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: userType === "business" ? "business_profile_not_found" : "user_profile_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: profile.notificationPreferences,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// PUT /users/notification-preferences — partial update, only touches the toggles that were sent.
// Businesses and customers have different toggle sets: business gets
// emailNotifications/pushNotifications/profileViewAlerts/messageAlerts,
// customers get emailNotifications/pushNotifications/bookingReminders.
const updateNotificationPreferences = async (req, res) => {
  const { _id: userId, userType } = req.user;
  const allowedFields =
    userType === "business"
      ? ["emailNotifications", "pushNotifications", "profileViewAlerts", "messageAlerts"]
      : ["emailNotifications", "pushNotifications", "bookingReminders"];

  const update = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) update[`notificationPreferences.${field}`] = !!req.body[field];
  }

  if (Object.keys(update).length === 0) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "missing_form_fields",
      values: { fields: allowedFields.join(", ") },
    });
  }

  try {
    const ProfileModel = userType === "business" ? BusinessProfile : UserProfile;

    const profile = await ProfileModel.findOneAndUpdate({ user: userId }, { $set: update }, { new: true }).select(
      "notificationPreferences",
    );
    if (!profile) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: userType === "business" ? "business_profile_not_found" : "user_profile_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "notification_preferences_updated",
      data: profile.notificationPreferences,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// PATCH /users/2fa — enable/disable two-factor authentication.
// Enabling is two calls to this same endpoint: first {enabled:true} sends an
// OTP without flipping the flag, then {enabled:true, otp} verifies it and only
// then turns 2FA on. Disabling {enabled:false} requires the current password
// instead, since it only lowers security rather than raising it.
const updateTwoFactorAuth = async (req, res) => {
  const { enabled, otp, currentPassword } = req.body;

  if (typeof enabled !== "boolean") {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "invalid_enum_value",
      values: { field: "enabled", allowedValues: "true, false", invalidValues: String(enabled) },
    });
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return sendResponse({ res, statusCode: 404, translationKey: "user_not_found" });
    }

    if (enabled) {
      if (user.security?.twoFactorEnabled) {
        return sendResponse({ res, statusCode: 400, translationKey: "two_factor_already_enabled" });
      }

      if (!otp) {
        // Step 1: send the enrollment OTP, don't enable yet
        const newOtp = user.generateOtp("twoFactor", user.timezone || "UTC");
        await user.save();
        // await sendEmailViaBrevo([user.email], "Enable Two-Factor Authentication", twoFactorOtpEmailTemplate(newOtp));
        return sendResponse({
          res,
          statusCode: 200,
          translationKey: "two_factor_otp_sent",
          data: { requiresOtp: true, otp: newOtp }, // otp included for testing purposes, same as other OTP flows in this codebase
        });
      }

      // Step 2: verify the OTP, then actually enable
      const otpInfo = user.otpInfo.twoFactorOtp;
      if (!otpInfo.otp || otpInfo.otpUsed || otpInfo.otp !== otp.toString()) {
        return sendResponse({ res, statusCode: 400, translationKey: "invalid_otp" });
      }
      if (otpInfo.otpExpires && new Date(otpInfo.otpExpires).getTime() < Date.now()) {
        return sendResponse({ res, statusCode: 400, translationKey: "otp_has" });
      }

      otpInfo.otp = "";
      otpInfo.otpExpires = "";
      otpInfo.otpUsed = true;
      user.security.twoFactorEnabled = true;
      await user.save();

      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "two_factor_enabled",
        data: { twoFactorEnabled: true },
      });
    }

    // Disabling — requires current password re-entry, same bar as changePassword
    if (!user.security?.twoFactorEnabled) {
      return sendResponse({ res, statusCode: 400, translationKey: "two_factor_already_disabled" });
    }
    if (typeof currentPassword !== "string" || !currentPassword) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "missing_form_fields",
        values: { fields: "currentPassword" },
      });
    }

    const isMatch = user.password ? await bcrypt.compare(currentPassword, user.password) : false;
    if (!isMatch) {
      return sendResponse({ res, statusCode: 401, translationKey: "incorrect_password" });
    }

    user.security.twoFactorEnabled = false;
    await user.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "two_factor_disabled",
      data: { twoFactorEnabled: false },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
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
  createOrUpdateUserProfile,
  createOrUpdateBusinessProfile,
  suggestBusinessProfileDescription,
  submitCertifications,
  updateOperatingHours,
  updateAvailability,
  getBusinesses,
  getAllBusinesses,
  countBusinessStatuses,
  getSelectedCategories,
  getNotificationPreferences,
  updateNotificationPreferences,
  updateTwoFactorAuth,
  switchAccount,
  getUserBusinesses,
};
