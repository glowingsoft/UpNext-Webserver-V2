const { Badge, BadgeStatuses } = require("@models/Badge");
const {
  validateParams,
  sendResponse,
  parsePaginationParams,
  generateMeta,
} = require("@utils/responseUtil");
const { default: mongoose } = require("mongoose");
const { safeKeyword } = require("@helperUtils/regexUtil");
const BusinessProfile = require("@models/BusinessProfile");
const { UserProfile } = require("@models/UserProfile");

// Read off the schemas rather than listed here — a group added to a profile's
// badges must not silently drop out of the in-use guard below, or a badge still
// held by businesses/users reads as unused and becomes deletable.
const BUSINESS_BADGE_KEYS = Object.keys(BusinessProfile.schema.obj.badges);

const USER_BADGE_KEYS = Object.keys(UserProfile.schema.obj.badges);

const BADGE_SCOPES = Badge.schema.path("scope").enumValues;
const BADGE_STATUSES = Object.values(BadgeStatuses);

// A badge scoped "both" belongs to either audience, so ?scope=business returns
// business badges *and* both-badges — that's pre-existing filter behaviour.
const scopeFilterFor = (scope) => ({ $in: [scope, "both"] });

/**
 * Counts for the app's scope tabs, from the same filter getBadges uses minus its
 * own scope — picking a tab must not move the numbers on the tabs, while a
 * keyword narrows all of them together.
 *
 * Each bucket counts what clicking that tab actually returns, so the
 * both-badges are included in "business" and "user" as well as their own
 * bucket. The buckets therefore overlap and do not sum to "all" — "all" is the
 * real number of distinct badges. The admin list counts differently, because it
 * matches scope exactly; see countBadgeScopesExact.
 */
const countBadgeScopes = async (matchConditions) => {
  const baseFilter = { ...matchConditions };
  delete baseFilter.scope;

  const counts = await Badge.aggregate([
    { $match: baseFilter },
    { $group: { _id: "$scope", count: { $sum: 1 } } },
  ]);

  const raw = Object.fromEntries(counts.map(({ _id, count }) => [_id, count]));
  const both = raw.both || 0;

  const scopeList = { all: Object.values(raw).reduce((sum, n) => sum + n, 0) };
  BADGE_SCOPES.forEach((scope) => {
    scopeList[scope] = scope === "both" ? both : (raw[scope] || 0) + both;
  });

  return scopeList;
};

/**
 * Scope tab counts for the paginated list, which matches ?scope exactly rather
 * than folding both-badges into each audience. Buckets are therefore disjoint
 * and user + business + both === all, so each number is exactly what its tab
 * returns.
 *
 * Counted from the list's own filter minus its scope — picking a tab must not
 * move the numbers on the tabs, while a keyword or status narrows all of them
 * together.
 */
const countBadgeScopesExact = async (matchConditions) => {
  const baseFilter = { ...matchConditions };
  delete baseFilter.scope;

  const counts = await Badge.aggregate([
    { $match: baseFilter },
    { $group: { _id: "$scope", count: { $sum: 1 } } },
  ]);

  const raw = Object.fromEntries(counts.map(({ _id, count }) => [_id, count]));

  // Every scope is listed even at zero, so a tab never disappears from the UI
  // just because nothing currently matches the keyword.
  const scopeList = { all: Object.values(raw).reduce((sum, n) => sum + n, 0) };
  BADGE_SCOPES.forEach((scope) => {
    scopeList[scope] = raw[scope] || 0;
  });

  return scopeList;
};

const clean = (v) => (typeof v === "string" ? v.trim() : v);

const findBadgeByName = (name) =>
  Badge.findOne({
    name: { $regex: `^${clean(name)}$`, $options: "i" },
    status: { $ne: BadgeStatuses.DELETED },
  });

const addBadge = async (req, res) => {
  try {
    if (!validateParams(req, res, { rawData: ["name"] })) return;

    const { name, translations = {}, options = [], scope, sortOrder } = req.body;

    const exists = await findBadgeByName(name);
    if (exists) {
      return sendResponse({ res, statusCode: 400, translationKey: "badge_already_exists" });
    }

    const badge = await Badge.create({
      name: clean(name),
      translations,
      options,
      scope,
      sortOrder,
    });

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "badge_created_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

/**
 * GET /badges — the app-facing list, and only that. The admin panel reads
 * GET /admin/badges (getBadgesList) instead, which is where pagination, the
 * ?status filter and exact scope matching now live.
 *
 * Everything here is fixed to what an app is allowed to see: active badges,
 * active options, and the whole list in one response — the apps build their
 * profile forms from it, so slicing it would quietly drop options off those
 * screens.
 */
const getBadges = async (req, res) => {
  // An unknown scope silently returned an empty list before; 400 instead.
  const validationOptions = { enumFields: { scope: BADGE_SCOPES } };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { keyword, scope } = req.query;

    // Inactive and soft-deleted badges are never the apps' business, so there
    // is no way to ask for them here at all.
    const filter = { status: BadgeStatuses.ACTIVE };

    if (keyword) {
      const lng = req.language || req.user?.language || "en";

      filter.$or = [
        { name: { $regex: keyword, $options: "i" } },
        { [`translations.${lng}`]: { $regex: keyword, $options: "i" } },
      ];
    }
    if (scope) filter.scope = scopeFilterFor(scope);

    const [badges, scopeList] = await Promise.all([
      Badge.find(filter).sort({ sortOrder: 1 }).lean(),
      countBadgeScopes(filter),
    ]);

    badges.forEach((badge) => {
      badge.options = (badge.options || []).filter((option) => option.status === BadgeStatuses.ACTIVE);
    });
    formatBadgeResponse({ req, badges });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badges_fetched_successfully",
      data: badges,
      meta: { scopeList },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

/**
 * GET /admin/badges — the admin panel's paginated badge list. Admin-gated at the
 * route, like the other write handlers here.
 *
 * A separate endpoint from getBadges rather than flags on it, because the two
 * differ in ways that cannot coexist on one route:
 *
 *  - getBadges paginates for admins only. The apps read it to build their
 *    profile forms and need every badge in one response, so paginating it for
 *    them would silently drop options off those screens. This one always
 *    paginates.
 *  - ?scope matches exactly here. getBadges treats a both-badge as belonging to
 *    either audience ($in: [scope, "both"]), so ?scope=business returns
 *    business *and* both badges. Changing that in place would move results
 *    under the existing callers.
 *
 * Translation follows the same rule as every other badge response: the caller's
 * locale via formatBadgeResponse, with the keyword matched against that same
 * locale's translation as well as the stored name.
 */
const getBadgesList = async (req, res) => {
  const validationOptions = {
    enumFields: { scope: BADGE_SCOPES, status: BADGE_STATUSES },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { status, keyword, scope } = req.query;

    // Deleted is a soft-delete tombstone, so it stays out of the default list —
    // an admin sees it only by asking for ?status=deleted by name.
    const filter = { status: status || { $ne: BadgeStatuses.DELETED } };

    if (keyword) {
      const lng = req.language || req.user?.language || "en";
      const safe = safeKeyword(keyword);

      filter.$or = [
        { name: { $regex: safe, $options: "i" } },
        { [`translations.${lng}`]: { $regex: safe, $options: "i" } },
      ];
    }

    // Exact match — a "both" badge belongs to the "both" tab and nowhere else.
    if (scope) filter.scope = scope;

    const { page, limit, skip } = parsePaginationParams(req);

    const [badges, totalRecords, scopeList] = await Promise.all([
      Badge.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limit).lean(),
      Badge.countDocuments(filter),
      countBadgeScopesExact(filter),
    ]);

    formatBadgeResponse({ req, badges });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badges_fetched_successfully",
      data: badges,
      meta: {
        ...generateMeta(page, limit, totalRecords),
        scopeList,
        statusTypeList: BADGE_STATUSES,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

/**
 * GET /badges/:name — the app-facing single badge, matching getBadges: only an
 * active badge resolves, and only its active options come back. An inactive or
 * soft-deleted badge is a 404 here for everyone; the admin panel reads those
 * through GET /admin/badges.
 */
const getBadgeByName = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["name"] })) return;

    const badge = await findBadgeByName(req.params.name);

    if (!badge || badge.status !== BadgeStatuses.ACTIVE) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    badge.options = badge.options.filter((option) => option.status === BadgeStatuses.ACTIVE);
    formatBadgeResponse({ req, badges: badge });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_fetched_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

const updateBadge = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["badgeId"] })) return;

    const { badgeId } = req.params;
    const { name, translations, status, sortOrder } = req.body;

    if (status && !Object.values(BadgeStatuses).includes(status)) {
      return sendResponse({ res, statusCode: 400, translationKey: "invalid_badge_status" });
    }

    if (name) {
      const exists = await Badge.findOne({
        name: { $regex: `^${clean(name)}$`, $options: "i" },
        status: { $ne: BadgeStatuses.DELETED },
      });

      if (exists && clean(exists.name).toLowerCase() !== clean(name).toLowerCase()) {
        return sendResponse({ res, statusCode: 400, translationKey: "badge_already_exists" });
      }
    }

    const updateData = {};
    if (name) updateData.name = clean(name);
    if (translations) updateData.translations = translations;
    if (status) updateData.status = status;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
    const badge = await Badge.findOneAndUpdate(
      {
        _id: badgeId,
        status: { $ne: BadgeStatuses.DELETED },
      },
      updateData,
      { new: true },
    );

    if (!badge) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_updated_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

const addBadgeOption = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["badgeId"], rawData: ["option"] })) return;

    const { badgeId } = req.params;
    const { option } = req.body;

    if (!option?.name) {
      return sendResponse({ res, statusCode: 400, translationKey: "option_name_required" });
    }

    const badge = await Badge.findById(badgeId);

    if (!badge) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    const exists = badge.options.some((item) => clean(item.name).toLowerCase() === clean(option.name).toLowerCase());

    if (exists) {
      return sendResponse({ res, statusCode: 400, translationKey: "option_already_exists" });
    }

    badge.options.push({
      name: clean(option.name),
      translations: option.translations || {},
      status: option.status || BadgeStatuses.ACTIVE,
    });

    await badge.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_option_added_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

const updateBadgeOption = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["badgeId", "optionId"] })) return;

    const { badgeId, optionId } = req.params;
    const { optionName, translations, status } = req.body;

    if (status && !Object.values(BadgeStatuses).includes(status)) {
      return sendResponse({ res, statusCode: 400, translationKey: "invalid_option_status" });
    }

    const badge = await Badge.findById(badgeId);

    if (!badge) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    const option = badge.options.id(optionId);

    if (!option) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_option_not_found" });
    }

    if (optionName) {
      const duplicate = badge.options.some(
        (item) =>
          item._id.toString() !== optionId && clean(item.name).toLowerCase() === clean(optionName).toLowerCase(),
      );

      if (duplicate) {
        return sendResponse({ res, statusCode: 400, translationKey: "option_already_exists" });
      }

      option.name = clean(optionName);
    }

    if (translations) option.translations = translations;
    if (status) option.status = status;

    await badge.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_option_updated_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

const deleteBadgeOption = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["badgeId", "optionId"] })) return;

    const { badgeId, optionId } = req.params;

    const badge = await Badge.findById(badgeId);

    if (!badge) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    const option = badge.options.id(optionId);

    if (!option) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_option_not_found" });
    }

    option.deleteOne();
    await badge.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_option_deleted_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

const deleteBadge = async (req, res) => {
  try {
    if (!validateParams(req, res, { pathParams: ["badgeId"] })) return;

    const { badgeId } = req.params;

    const [businessUsage, userUsage] = await Promise.all([
      BusinessProfile.findOne({
        $or: BUSINESS_BADGE_KEYS.map((key) => ({ [`badges.${key}.badgeId`]: badgeId })),
      }).lean(),
      UserProfile.findOne({
        $or: USER_BADGE_KEYS.map((key) => ({ [`badges.${key}.badgeId`]: badgeId })),
      }).lean(),
    ]);

    if (businessUsage || userUsage) {
      return sendResponse({ res, statusCode: 400, translationKey: "badge_in_use" });
    }

    const badge = await Badge.findOneAndUpdate(
      {
        _id: badgeId,
        status: { $ne: BadgeStatuses.DELETED },
      },
      { status: BadgeStatuses.DELETED },
      { new: true },
    );

    if (!badge) {
      return sendResponse({ res, statusCode: 404, translationKey: "badge_not_found" });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "badge_deleted_successfully",
      data: badge,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: error.message, error });
  }
};

// A translation only wins when it actually says something. translationSchema
// defaults every locale to "", and `??` guards null/undefined only — so that
// empty default used to overwrite the real name, and any badge created without
// an explicit translations object came back as name: "" in every response.
//
// Treating "" as "not translated" also gives a partially translated badge its
// base name for the locales it is missing, and matches translatedNameExpr in
// @utils/aggregationHelper, which the aggregation path already does this way.
const translatedName = (translations, lng, fallback) => {
  const value = translations?.[lng];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
};

const formatBadgeResponse = ({ req, badges }) => {
  const lng = req.language || req.user?.language;
  if (!lng || !badges) return;

  const applyTranslations = (badge) => {
    badge.name = translatedName(badge.translations, lng, badge.name);

    badge.options?.forEach((option) => {
      option.name = translatedName(option.translations, lng, option.name);
    });
  };
  const list = Array.isArray(badges) ? badges : [badges];

  list.forEach(applyTranslations);
};
module.exports = {
  addBadge,
  getBadges,
  getBadgesList,
  getBadgeByName,
  updateBadge,
  deleteBadge,
  addBadgeOption,
  updateBadgeOption,
  deleteBadgeOption,
};
