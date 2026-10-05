// helperUtils/userResponseUtil.js

const BusinessProfile = require("@models/BusinessProfile");
const Review = require("@models/Review");
const { convertUtcToTimezone } = require("./responseUtil");
const { getFullImageUrl } = require("@utils/imageHelper");
const { UserProfile } = require("@models/UserProfile");
const { resolveBadgeOptionName } = require("@utils/badgeUtil");
const { reviewStatsPipeline } = require("@utils/aggregationHelper");

const formatUserResponse = (userObject, token = null, includeFields = [], excludeFields = []) => {
  var pIcon = null;
  if (userObject.profileIcon) {
    pIcon = userObject.profileIcon;
  }

  // Attach base URL to profileIcon
  if (pIcon) {
    pIcon = getFullImageUrl(pIcon);
  }

  const response = {
    basicInfo: {
      _id: userObject._id,
      profileIcon: pIcon,
      name: userObject.name,
      email: userObject.email,
      phoneNumber: userObject.phoneNumber,
      language: userObject.language,
    },
    accountState: {
      userType: userObject.accountState?.userType || "user",
      roles: userObject.accountState?.roles || [userObject.accountState?.userType || "user"],
      // Which profiles the account actually owns, so a client can tell whether
      // switching into a mode will land on a usable app or on the "create your
      // profile" screen — switchAccount only validates the mode being left.
      hasUserProfile: Boolean(userObject.accountState?.hasUserProfile),
      hasBusinessProfile: Boolean(userObject.accountState?.hasBusinessProfile),
      status: userObject.accountState?.status || "active",
      verificationStatus: userObject.verificationStatus || {
        email: "pending",
        phoneNumber: "pending",
      },
      ...(userObject.accountState?.reason ? { reason: userObject.accountState.reason } : {}),
    },
  };

  // Security settings — lets the client render the 2FA toggle's current state
  response.security = {
    twoFactorEnabled: userObject.security?.twoFactorEnabled || false,
  };

  // Append metadata
  response.metadata = {
    timezone: userObject.timezone,
    createdAt: userObject.createdAt,
    updatedAt: userObject.updatedAt,
    __v: userObject.__v,
  };

  // Include otpInfo only in development environment
  let otpExpLocalTz;
  if (userObject.otpInfo && userObject.otpInfo.otpExpires) {
    otpExpLocalTz = convertUtcToTimezone(userObject.otpInfo.otpExpires, userObject.timezone);
  }

  // if (process.env.NODE_ENV === "dev" && userObject.otpInfo) {
  if (userObject.otpInfo) {
    response.otpInfo = userObject.otpInfo;
  }
  // Stripe Connect state (accountId, customerId, onboardingComplete,
  // chargesEnabled, payoutsEnabled) — lets the client gate business flows
  if (userObject.stripe) {
    response.stripe = userObject.stripe;
  }
  if (userObject.resetToken) {
    response.resetToken = userObject.resetToken;
  }
  // Return the structured response with token
  // Append token only if it's not null
  if (token) {
    response.token = token;
  }

  // Determine which objects to include or exclude in the final response
  let finalResponse = response;

  // Include specific fields if specified
  if (includeFields.length > 0) {
    finalResponse = {};
    includeFields.forEach((field) => {
      if (response[field]) {
        finalResponse[field] = response[field];
      }
    });
  }

  // Exclude specific fields if specified
  if (excludeFields.length > 0) {
    excludeFields.forEach((fieldPath) => {
      const [mainField, subField] = fieldPath.split(".");
      if (subField) {
        if (finalResponse[mainField]) {
          delete finalResponse[mainField][subField];
        }
      } else {
        delete finalResponse[fieldPath];
      }
    });

    return finalResponse;
  } else {
    // Include all fields
    return response;
  }
};

// Returns { profile, error } — error is a translation key when the profile
// exists but is not active, so callers decide how to respond instead of
// catching a thrown Error.
const attachProfile = async (user) => {
  const userId = user._id;
  const userType = user.userType || user.accountState?.userType || "user";
  let profile = null;
  if (userType === "business") {
    const biz = await BusinessProfile.findOne({ user: userId }).lean();
    if (!biz) return { profile: null };
    if (biz.status !== "active") return { profile: null, error: "business_profile_not_active" };
    if (biz.certifications) {
      if (biz.certifications.files?.length > 0) {
        biz.certifications.files = biz.certifications.files.map((file) => getFullImageUrl(file));
      }
      biz.certifications.optionName = await resolveBadgeOptionName(biz.certifications);
    }
    biz.image = getFullImageUrl(biz.image);
    biz.coverImage = getFullImageUrl(biz.coverImage);
    // Same rating breakdown shown on the business home dashboard — avg, /5,
    // star distribution across all of this business's services/packages.
    const [ratingStats] = await Review.aggregate(reviewStatsPipeline({ business: biz._id }));
    biz.rating = ratingStats || { avgRating: 0, totalReviews: 0, ratingCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    profile = biz;
  } else {
    const up = await UserProfile.findOne({ user: userId });
    if (!up) return { profile: null };
    if (up.status !== "active") return { profile: null, error: "user_profile_not_active" };
    profile = up.toObject();
  }

  return { profile };
};

module.exports = {
  formatUserResponse,
  attachProfile,
};
