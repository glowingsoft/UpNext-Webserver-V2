const jwt = require("jsonwebtoken");
const { User } = require("@models/UserModel");
const { sendResponse } = require("@utils/responseUtil");
const { i18nConfig } = require("@config/i18nConfig");
const BusinessProfile = require("@models/BusinessProfile");
const { UserProfile } = require("@models/UserProfile");
const { isSessionValid } = require("@models/Session");
const { resolveProfileFlags, persistProfileFlags } = require("@utils/profileFlagsUtil");
const { LanguageCodes } = require("@models/Models");

const acceptedLanguageCodes = Object.values(LanguageCodes);

const auth = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");

    if (!authHeader) {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "auth_header_missing",
      });
    }

    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "auth_token_missing",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded._id;
    const sessionId = decoded.sid;
    const deviceType = decoded.deviceType || "web";

    const sessionValid = await isSessionValid({ userId, sessionId });
    if (!sessionValid) {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "invalid_token",
      });
    }

    // userCache is a per-process node-cache instance, but this app runs under
    // PM2 in cluster mode (multiple worker processes) — a cache bust on the
    // worker that handles a mutation (e.g. switch-account) never reaches the
    // other workers' copies, so a later request can be served stale data for
    // up to the cache's TTL depending on which worker picks it up. Bypassing
    // the read here entirely until userCache moves to a shared store (Redis).
    const selectFields = "name email timezone language accountState currency stripe";
    let user = await User.findById(userId).select(selectFields);

    if (!user) {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "user_not",
      });
    }

    if (user.accountState.status === "restricted" || user.accountState.status === "suspended") {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "your_account_2",
      });
    }

    // Immediately convert user to a plain object for modification
    user = user.toObject();
    user.userType = user.accountState.userType;
    user.roles = user.accountState.roles || ["user"];
    // Flattened alongside userType/roles because accountState is deleted below.
    // These are the *stored* values; attachProfiles resolves the real ones and
    // overwrites them, comparing against these to decide whether to persist.
    user.hasUserProfile = Boolean(user.accountState.hasUserProfile);
    user.hasBusinessProfile = Boolean(user.accountState.hasBusinessProfile);
    delete user.accountState;

    // Explicit x-language/language header or ?lang= wins over the account's
    // stored preference — clients must be able to override per-request instead
    // of always getting whatever language is saved on the user document.
    const requestedLanguage = req.headers["x-language"] || req.headers.language || req.query.lang;
    const explicitLanguage = acceptedLanguageCodes.includes(requestedLanguage) ? requestedLanguage : null;
    req.language = explicitLanguage || user.language || "en";
    i18nConfig.setLocale(req, req.language);
    req.token = token;
    user.deviceType = deviceType;
    req.user = user;
    req.sessionId = sessionId;

    const result = await attachProfiles(req);

    if (result.error) {
      return sendResponse({
        res,
        statusCode: result.statusCode,
        translationKey: result.translationKey,
      });
    }

    next(); // Move to the next middleware/route handler
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "token_expired",
      });
    }
    return sendResponse({
      res,
      statusCode: 401,
      translationKey: "invalid_token",
      error: error,
    });
  }
};

const attachProfiles = async (req) => {
  const userId = req.user._id;
  const user = req.user;
  const skipRoutes = ["/auth", "profile", "/categories", "/badges", "/switch-account", "/tags"];
  const skipProfileCheck = skipRoutes.some(
    (route) => req.originalUrl?.includes(route) || req.route?.path?.includes(route),
  );

  // Both profiles are looked up regardless of the active mode, because
  // accountState.hasUserProfile/hasBusinessProfile describe the whole account,
  // not the mode it happens to be in. The status filter moved out of the query
  // so one lookup answers both questions: whether the profile exists at all
  // (the flag) and whether it is active (the gate below, unchanged).
  const [userProfile, businessProfile] = await Promise.all([
    UserProfile.findOne({ user: userId }).select("_id status"),
    BusinessProfile.findOne({ user: userId }).select("_id status isAvailable"),
  ]);

  const flags = await resolveProfileFlags(userId, [userProfile, businessProfile]);

  // Compared before the assign below: `user` is the same object as `req.user`,
  // so overwriting first would leave nothing to compare against and the write
  // would either never fire or fire on every single request.
  const drifted = user.hasUserProfile !== flags.hasUserProfile || user.hasBusinessProfile !== flags.hasBusinessProfile;

  Object.assign(req.user, flags);

  // Persist only when it actually changed. Creating or deleting a profile
  // happens in several controllers; rather than make each remember to update
  // the user, the account corrects itself on its next authenticated request.
  if (drifted) {
    persistProfileFlags(userId, flags);
  }

  // BUSINESS PROFILE
  // if (user.userType === "business" || user.roles?.includes("business")) {
  if (user.userType === "business") {
    const active = businessProfile?.status === "active" ? businessProfile : null;

    if (!active && !skipProfileCheck) {
      return {
        error: true,
        statusCode: 403,
        translationKey: "business_profile_inactive",
      };
    }

    req.user.businessId = active?._id || null;
    req.user.isAvailable = active?.isAvailable ?? false;
  }

  // USER PROFILE
  // if (user.userType === "user" || user.roles?.includes("user")) {
  if (user.userType === "user") {
    const active = userProfile?.status === "active" ? userProfile : null;

    if (!active && !skipProfileCheck) {
      return {
        error: true,
        statusCode: 403,
        translationKey: "user_profile_inactive",
      };
    }

    req.user.profileId = active?._id || null;
  }

  return { error: false };
};

module.exports = auth;
