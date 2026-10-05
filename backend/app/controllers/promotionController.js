const { Packages } = require("@models/Packages");
const { Promotion } = require("@models/Promotions");
const PromotionUsage = require("@models/PromotionUsage");
const { Services } = require("@models/Services");
const {
  promotionPipeline,
  promotionTargetsPipeline,
  finalRes,
  paginationPipeline,
  bookableBusinessPipeline,
} = require("@utils/aggregationHelper");
const { sendResponse, validateParams, cleanfiles } = require("@utils/responseUtil");
const { default: mongoose } = require("mongoose");

// "expires July 14" means valid THROUGH July 14 — a bare date (no time part)
// is stored as end-of-day so the promotion doesn't die the moment that day starts.
// Values that include an explicit time are stored as-is.
const parseExpiresAt = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
};

// ─── Create Promotion Controller ───────────────────────────────────
const createPromotion = async (req, res) => {
  const { _id: userId, businessId } = req.user;
  const {
    name,
    description,
    promoType,
    promoCode,
    discountType,
    discount,
    totalUsageLimit,
    perUserLimit,
    scope,
    targetId: rawTargetId,
    photos,
    expiresAt,
  } = req.body;

  const validationOptions = {
    formFields: [
      "name",
      "promoType",
      "promoCode",
      "discountType",
      "discount",
      "totalUsageLimit",
      "perUserLimit",
      "scope",
      "expiresAt",
      // targetId is validated manually below, not here — validateParams'
      // formFields pass mutates arrays into a joined string, which would
      // corrupt a multi-target request before objectId validation ever runs.
    ],
    enumFields: { scope: ["services", "packages", "both"] },
  };

  if (!validateParams(req, res, validationOptions)) return;

  // targetId can be a single id or an array of ids — one promotion can bundle multiple targets
  const targetId = Array.isArray(rawTargetId) ? rawTargetId : rawTargetId ? [rawTargetId] : [];
  if (targetId.length === 0 || !targetId.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "invalid_target_id",
    });
  }

  try {
    // Check if promotion already exists for the business
    const isExisting = await Promotion.findOne({
      business: businessId,
      promoCode: promoCode?.trim(), // Ensure the promo code is unique
    });

    if (isExisting) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "promotion_already_exists",
      });
    }
    // "both" checks every targetId against services and packages both — each
    // target may be either type, we just don't restrict it to one
    const isValidTarget = await validateTarget({ scope, targetId, businessId });
    if (!isValidTarget) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_target_id",
      });
    }
    // Create new promotion
    let newPromotion = new Promotion({
      name,
      description,
      promoType,
      promoCode,
      discountType,
      discount,
      totalUsageLimit,
      perUserLimit,
      scope,
      targetId,
      business: businessId, // Link the promotion to the business
      photos: cleanfiles(photos || []), // Handle photos if provided
      expiresAt: parseExpiresAt(expiresAt), // bare dates become end-of-day (valid through that day)
    });

    newPromotion = await newPromotion.save();

    const { data } = await getPromotions({ filter: { _id: newPromotion._id }, req });

    return sendResponse({
      res,
      statusCode: 201,
      data: data?.[0] || newPromotion,
      translationKey: "promotion_created_successfully",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "server_error",
      message: "Failed to create promotion",
    });
  }
};

// ─── Update Promotion Controller ───────────────────────────────────
const updatePromotion = async (req, res) => {
  const { _id: userId, businessId } = req.user;
  const { promotionId } = req.params;
  const {
    name,
    description,
    promoType,
    promoCode,
    discountType,
    discount,
    totalUsageLimit,
    perUserLimit,
    scope,
    targetId,
    status,
    photos,
    expiresAt,
  } = req.body;

  const validationOptions = {
    pathParams: ["promotionId"],
    objectIdFields: ["promotionId", ...(targetId ? ["targetId"] : [])],
    enumFields: { scope: ["services", "packages", "both"] },
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    const promotion = await Promotion.findOne({ _id: promotionId, business: businessId });

    if (!promotion) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "promotion_not_found",
      });
    }

    const effectiveScope = scope || promotion.scope;
    const effectiveTargetId =
      targetId !== undefined ? (Array.isArray(targetId) ? targetId : [targetId]) : promotion.targetId;

    // "both" checks every targetId against services and packages both — each
    // target may be either type, we just don't restrict it to one
    const isValidTarget = await validateTarget({ scope: effectiveScope, targetId: effectiveTargetId, businessId });
    if (!isValidTarget) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_target_id",
      });
    }

    // Update promotion details
    promotion.name = name || promotion.name;
    if (description !== undefined) promotion.description = description;
    promotion.promoType = promoType || promotion.promoType;
    promotion.promoCode = promoCode || promotion.promoCode;
    promotion.discountType = discountType || promotion.discountType;
    promotion.discount = discount || promotion.discount;
    promotion.totalUsageLimit = totalUsageLimit || promotion.totalUsageLimit;
    promotion.perUserLimit = perUserLimit || promotion.perUserLimit;
    promotion.scope = effectiveScope;
    promotion.targetId = effectiveTargetId;
    promotion.status = status || promotion.status;
    if (expiresAt) promotion.expiresAt = parseExpiresAt(expiresAt); // bare dates become end-of-day
    promotion.business = businessId; // Ensure the promotion remains linked to the business
    if (photos) {
      promotion.photos = cleanfiles(photos);
    }

    await promotion.save();

    const { data } = await getPromotions({ filter: { _id: promotion._id }, req });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "promotion_updated_successfully",
      data: data?.[0] || promotion,
    });
  } catch (error) {
    console.error("Error updating promotion:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "server_error",
      message: "Failed to update promotion",
    });
  }
};

// ─── Delete Promotion Controller ───────────────────────────────────
const deletePromotion = async (req, res) => {
  const { _id: userId, businessId } = req.user;
  const { promotionId } = req.params;

  try {
    const promotion = await Promotion.findOne({ _id: promotionId, business: businessId });

    if (!promotion) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "promotion_not_found",
      });
    }

    await promotion.deleteOne();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "promotion_deleted_successfully",
    });
  } catch (error) {
    console.error("Error deleting promotion:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "server_error",
      message: "Failed to delete promotion",
    });
  }
};

// ─── Validate a promo code against a specific target (checkout "Apply Promo
// Code" flow) — checks the same eligibility rule bookingService.createBooking
// enforces at booking time (active, unexpired, actually bundles this target),
// so a code that validates here is guaranteed to also apply at booking time.
const validatePromoCode = async (req, res) => {
  const { promoCode, scope, targetId } = req.body;

  const validationOptions = {
    formFields: ["promoCode", "scope", "targetId"],
    enumFields: { scope: ["service", "package"] },
    objectIdFields: ["targetId"],
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const Model = scope === "service" ? Services : Packages;
    const entity = await Model.findById(targetId).select("name price status isAvailable").lean();
    if (!entity ) {
      return sendResponse({ res, statusCode: 404, translationKey: "invalid_target_id" });
    }

      if (entity.status !== "active") {
          return sendResponse({
              res,
              statusCode: 409,
              translationKey: scope === "package" ? "package_inactive" : "service_inactive"
          });
      }
    // An unavailable target isn't a bad id — it's the same "can't be booked
    // right now" state getSlots/createBooking report, so say that instead.
    if (entity.isAvailable === false) {
      return sendResponse({
        res,
        statusCode: 409,
        translationKey: scope === "package" ? "package_unavailable" : "service_unavailable",
      });
    }

    const promotion = await Promotion.findOne({
      promoCode: promoCode.trim(),
      targetId: new mongoose.Types.ObjectId(targetId),
      status: "active",
      expiresAt: { $gt: new Date() },
    }).lean();

    if (!promotion) {
      return sendResponse({ res, statusCode: 404, translationKey: "promo_code_invalid" });
    }

    // Same limits createBooking enforces — checked here too so the checkout
    // screen doesn't show a code as valid only to have it rejected at booking time.
    const [totalUsed, userUsed] = await Promise.all([
      PromotionUsage.countDocuments({ promotion: promotion._id }),
      PromotionUsage.countDocuments({ promotion: promotion._id, user: req.user._id }),
    ]);
    if (totalUsed >= promotion.totalUsageLimit) {
      return sendResponse({ res, statusCode: 400, translationKey: "promotion_usage_limit_reached" });
    }
    if (userUsed >= promotion.perUserLimit) {
      return sendResponse({ res, statusCode: 400, translationKey: "promotion_user_limit_reached" });
    }

    const price = entity.price;
    const finalPrice =
      promotion.discountType === "percentage"
        ? Math.max(0, price - (price * promotion.discount) / 100)
        : Math.max(0, price - promotion.discount);
    const discountAmount = parseFloat((price - finalPrice).toFixed(2));

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "promo_code_valid",
      data: {
        promotionId: promotion._id,
        promoCode: promotion.promoCode,
        name: promotion.name,
        discountType: promotion.discountType,
        discount: promotion.discount,
        price,
        discountAmount,
        finalPrice,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

const getPromotionById = async (req, res) => {
  const { promotionId } = req.params;
  try {
    const { data } = await getPromotions({ filter: { _id: new mongoose.Types.ObjectId(promotionId) }, req });
    const promotion = data?.[0] || null;
    if (!promotion) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "promotion_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "promotion_found",
      data: promotion,
    });
  } catch (error) {
    console.error("Error fetching promotion:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "server_error",
      message: "Failed to fetch promotion",
    });
  }
};

const getPromotions = async ({ filter = {}, req = {}, includeCounts = false }) => {
  const { keyword, page, limit, business, status, scope, discountType, expired, targetId, lat, lng } = req?.query || {};
  if (business) {
    filter.business = new mongoose.Types.ObjectId(business);
  }
  if (req.user.userType === "business") {
    filter.business = new mongoose.Types.ObjectId(req.user.businessId);
  }
  if (status) {
    filter.status = status;
  }
  if (scope) {
    filter.scope = scope;
  }
  if (expired === "true") {
    filter.expiresAt = { $lt: new Date() };
  } else if (expired === "false") {
    filter.expiresAt = { $gte: new Date() };
  }
  if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
    // Every promotion now has a real targetId regardless of scope, so this
    // works uniformly for "services"/"packages"/"both" — e.g. "does this
    // specific service/package have a promotion?"
    filter.targetId = new mongoose.Types.ObjectId(targetId);
  }

  // Snapshot the filter before discountType is applied so the all/percentage/fixed
  // tab counts stay stable regardless of which discountType tab is selected.
  const countFilter = { ...filter };

  if (discountType) {
    filter.discountType = discountType;
  }

  const pipeline = [{ $match: filter }];
  if (req.user?.userType === "user") {
    // Hide promotions of businesses that can't be paid yet (Stripe onboarding incomplete)
    pipeline.push(...bookableBusinessPipeline());
  }

  pipeline.push(
    ...promotionPipeline({
      keyword,
      locale: req.language || req.user?.language,
      userLat: lat != null ? Number(lat) : null,
      userLng: lng != null ? Number(lng) : null,
    }),
  );

  page && limit && pipeline.push(paginationPipeline({ page, limit }));

  const [result, discountTypeCountsAgg] = await Promise.all([
    Promotion.aggregate(pipeline),
    includeCounts
      ? Promotion.aggregate([{ $match: countFilter }, { $group: { _id: "$discountType", count: { $sum: 1 } } }])
      : Promise.resolve(null),
  ]);

  const { data, meta } =
    finalRes({
      page,
      limit,
      data: result,
    }) || {};

  if (includeCounts) {
    const discountTypeCounts = { all: 0, percentage: 0, fixed: 0 };
    discountTypeCountsAgg.forEach(({ _id, count }) => {
      discountTypeCounts.all += count;
      if (discountTypeCounts[_id] !== undefined) discountTypeCounts[_id] += count;
    });
    return { data, meta: { ...meta, discountTypeCounts } };
  }

  return { data, meta };
};

// Target-centric promotions listing: one row per (promotion, target) instead
// of one row per promotion with a nested target array — pagination operates
// over targets, so a promotion bundling N services/packages pages as N items.
const getPromotionTargets = async ({ filter = {}, req = {} }) => {
  const { keyword, page, limit, lat, lng } = req?.query || {};

  const pipeline = [{ $match: filter }];
  if (req.user?.userType === "user") {
    // Hide promotions of businesses that can't be paid yet (Stripe onboarding incomplete)
    pipeline.push(...bookableBusinessPipeline());
  }

  pipeline.push(
    ...promotionTargetsPipeline({
      keyword,
      locale: req.language || req.user?.language,
      userLat: lat != null ? Number(lat) : null,
      userLng: lng != null ? Number(lng) : null,
    }),
  );

  page && limit && pipeline.push(paginationPipeline({ page, limit }));

  const result = await Promotion.aggregate(pipeline);

  const { data, meta } =
    finalRes({
      page,
      limit,
      data: result,
    }) || {};

  return { data, meta };
};

// Filter options for the app's promotions filters
const statusTypeList = ["active", "inactive"];
const scopeTypeList = ["services", "packages", "both"];
const discountTypeList = ["percentage", "fixed"];

// ─── Get All Promotions Controller ─────────────────────────────────
const getAllPromotions = async (req, res) => {
  const validationOptions = {
    enumFields: {
      status: statusTypeList,
      scope: scopeTypeList,
      discountType: discountTypeList,
      expired: ["true", "false"],
    },
    objectIdFields: [...(req.query.targetId ? ["targetId"] : [])],
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { data: promotions, meta } = await getPromotions({ req, includeCounts: true });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "promotions_found",
      data: promotions,
      meta: { ...meta, statusTypeList, scopeTypeList, discountTypeList },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "promotions_fetch_error",
      error,
    });
  }
};

// Verifies every id in targetId[] resolves to a real active service/package
// for the given business. Returns true only if ALL ids are found.
//
// isAvailable is deliberately not checked: it's a live "not bookable right now"
// toggle, not eligibility to carry a promotion. Gating on it also made a
// promotion un-editable — updatePromotion re-validates the stored targetId even
// when the request doesn't touch it, so flipping one target unavailable froze
// the whole promotion. Booking an unavailable target is blocked in
// bookingService (service_unavailable / package_unavailable) instead.
const validateTarget = async ({ scope, targetId, businessId }) => {
    const targetIds = Array.isArray(targetId) ? targetId : [targetId];
    const query = { _id: { $in: targetIds }, business: businessId, status: "active" };

    let foundIds;
    if (scope === "both") {
        // each id may belong to either model — accept whichever one has it
        const [services, packages] = await Promise.all([
            Services.find(query).select("_id"),
            Packages.find(query).select("_id"),
        ]);
        foundIds = new Set([...services, ...packages].map((doc) => doc._id.toString()));
    } else {
        const modelMap = {
            services: Services,
            packages: Packages
        };

        const Model = modelMap[scope];
        if (!Model) return false;

        const found = await Model.find(query).select("_id");
        foundIds = new Set(found.map((doc) => doc._id.toString()));
    }

    return targetIds.every((id) => foundIds.has(id.toString()));
};
module.exports = {
  createPromotion,
  getPromotionById,
  updatePromotion,
  deletePromotion,
  getAllPromotions,
  getPromotions,
  getPromotionTargets,
  validatePromoCode,
};
