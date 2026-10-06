const { Services } = require("@models/Services");
const BusinessProfile = require("@models/BusinessProfile");
const Review = require("@models/Review");
const {
  servicePipeline,
  paginationPipeline,
  finalRes,
  reviewStatsPipeline,
  bookableBusinessPipeline,
  nearestFirstStages,
} = require("@utils/aggregationHelper");
const { sendResponse, validateParams, cleanfiles, fireAndForget } = require("@utils/responseUtil");
const { indexEntityKeywords } = require("@services/ai/features/indexEntityKeywords");
const { default: mongoose } = require("mongoose");
const {
  validateServiceSlots,
  validateServiceSlotsAgainstOperatingHours,
  validateSessionConfig,
  deriveSessionConfigFromSlots,
  generateWeeklySlots,
  resolveServiceCategory,
  escapeRegex,
} = require("@utils/serviceUtil");
const ServiceCategory = require("@models/ServiceCategory");
const { validateBadgeOptionRef } = require("@utils/badgeUtil");
const { getCertificationBlockKey } = require("@utils/certificationUtil");
const { getViewerBusinessId } = require("@utils/viewerUtil");
const { getEntityEarnings } = require("../services/bookingService");
const { suggestServiceClassification } = require("@services/ai/features/suggestServiceCategory");

// ─── Create Service Controller ───────────────────────────────────
const createService = async (req, res) => {
  const { _id: userId, businessId, timezone } = req.user; // Get the authenticated user's ID
  const {
    name,
    description,
    preferredServiceType,
    price,
    slots,
    category,
    sameAsBusinessHours,
    sessionSlotMins,
    gapBetweenSlotMins,
  } = req.body;
  // Validate required fields (preferredServiceType is an object, so it goes
  // through rawData — formFields stringifies values)
  const validationOptions = {
    formFields: ["name", "price", "category"],
    rawData: ["preferredServiceType"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    // Looked up without the status filter so an inactive/pending profile gets a
    // meaningful error instead of "not found"
    const businessProfile = await BusinessProfile.findOne({ _id: businessId }).lean();
    if (!businessProfile) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "business_profile_not_found",
      });
    }
    // Certifications under review (or rejected) block publishing new work —
    // checked before the profile status so the reason surfaces to the business
    const certificationBlockKey = getCertificationBlockKey(businessProfile.certifications);
    if (certificationBlockKey) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: certificationBlockKey,
      });
    }
    if (businessProfile.status !== "active") {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "business_profile_not_active",
      });
    }
    const resolvedCategory = await resolveServiceCategory(businessId, category);
    if (resolvedCategory.errorKey) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: resolvedCategory.errorKey,
      });
    }
    const badgeRefError = await validateBadgeOptionRef(preferredServiceType);
    if (badgeRefError) {
      return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
    }
    // Two modes: explicit slots (used as-is; sameAsBusinessHours/session
    // config are ignored) or business-hours mode (sameAsBusinessHours: true +
    // sessionSlotMins, slots generated from operating hours). A `slots` key,
    // when present, must be a valid non-empty array.
    const hasSlots = slots !== undefined;
    let sessionConfig = null;
    if (hasSlots) {
      const formatError = validateServiceSlots(slots);
      if (formatError) return sendResponse({ res, statusCode: 400, ...formatError });

      const slotError = validateServiceSlotsAgainstOperatingHours(slots, businessProfile.operatingHours);
      if (slotError) return sendResponse({ res, statusCode: 400, ...slotError });

      // Session config alongside explicit slots: whatever the business sends is
      // stored as-is; anything omitted is measured back from the intervals
      // (averaged when their length/gap varies) so both fields stay populated.
      if (sessionSlotMins !== undefined && (!Number.isInteger(sessionSlotMins) || sessionSlotMins <= 0)) {
        return sendResponse({ res, statusCode: 400, translationKey: "session_slot_mins_invalid" });
      }
      if (gapBetweenSlotMins != null && (!Number.isInteger(gapBetweenSlotMins) || gapBetweenSlotMins < 0)) {
        return sendResponse({ res, statusCode: 400, translationKey: "gap_between_slot_mins_invalid" });
      }
      const measured = deriveSessionConfigFromSlots(slots);
      sessionConfig = {
        sessionSlotMins: sessionSlotMins ?? measured.sessionSlotMins ?? undefined,
        // An explicit null means "no gap" (same as business-hours mode); only
        // an omitted key falls back to what the intervals measure.
        gapBetweenSlotMins: gapBetweenSlotMins === undefined ? measured.gapBetweenSlotMins : (gapBetweenSlotMins ?? 0),
      };
    } else {
      if (sameAsBusinessHours !== true) {
        return sendResponse({ res, statusCode: 400, translationKey: "slots_or_business_hours_required" });
      }
      const configError = validateSessionConfig(sessionSlotMins, gapBetweenSlotMins);
      if (configError) return sendResponse({ res, statusCode: 400, ...configError });
    }

    const isExistingService = await Services.findOne({ business: businessId, name: name?.trim() });
    if (isExistingService) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "service_already_exists",
      });
    }

    const newService = new Services({
      ...req.body,
      business: businessId,
      name,
      description,
      preferredServiceType,
      price,
      category: resolvedCategory.id,
      photos: cleanfiles(req?.body?.photos || []),
      // Explicit intervals are stored as-is; business-hours mode stores the
      // auto-generated sessions (operating hours divided by sessionSlotMins,
      // breaks excluded) — regenerated whenever the operating hours change.
      slots: hasSlots
        ? slots
        : generateWeeklySlots(businessProfile.operatingHours, sessionSlotMins, gapBetweenSlotMins ?? 0),
      sameAsBusinessHours: !hasSlots,
      sessionSlotMins: hasSlots ? sessionConfig.sessionSlotMins : sessionSlotMins,
      gapBetweenSlotMins: hasSlots ? sessionConfig.gapBetweenSlotMins : (gapBetweenSlotMins ?? 0),
    });

    await newService.save();
    fireAndForget(indexEntityKeywords(Services, newService), "service search index");

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "service_created",
      data: newService,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_creation_error",
      error,
    });
  }
};

// ─── Get Service Controller ───────────────────────────────────
const getService = async (req, res) => {
  const { serviceId } = req.params;

  // Validate the serviceId parameter
  const validationOptions = {
    pathParams: ["serviceId"],
    objectIdFields: ["serviceId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Validation failed, response already sent
  }

  try {
    // req is passed so canBook can tell whether the viewer owns this service
    const { data } = await getServices({ filter: { _id: new mongoose.Types.ObjectId(serviceId) }, req });
    const service = data[0]; // getServices returns an array, we need the first item

    if (!service) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "service_not_found", // Custom translation for service not found
      });
    }

    // Rating breakdown for the "Rating" panel (avg, /5, star distribution)
    // — supersedes the flat avgRating/totalReviews from servicePipeline, so drop those to avoid duplication
    const { avgRating, totalReviews, ...serviceRest } = service;
    const [ratingStats] = await Review.aggregate(reviewStatsPipeline({ reviewType: "services", object: service._id }));
    const rating = ratingStats || { avgRating: 0, totalReviews: 0, ratingCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

    // Revenue stats (totalEarned/thisWeek/thisMonth) — only shown to the
    // owning business viewing their own service, never customers/admins/other businesses
    const isOwner = req.user?.userType === "business" && String(service.business?._id) === String(req.user.businessId);
    const stats = isOwner ? await getEntityEarnings({ entityId: service._id, timezone: req.user.timezone }) : null;

    // Suggested services: other bookable services in the same category,
    // best rated first — trimmed down to just the suggestion-card fields.
    // Customer-facing only — businesses/admins viewing a service don't need it.
    const isCustomer = req.user?.userType === "user";
    let suggestedServices = [];
    const categoryId = isCustomer ? service.category?._id : null;
    if (categoryId) {
      suggestedServices = await Services.aggregate([
        {
          $match: {
            _id: { $ne: service._id },
            $or: [
              { category: new mongoose.Types.ObjectId(String(categoryId)) },
              { subcategory: new mongoose.Types.ObjectId(String(categoryId)) },
            ],
            status: "active",
            isAvailable: { $ne: false },
          },
        },
        ...servicePipeline({
          userLat: req.query.lat != null ? Number(req.query.lat) : null,
          userLng: req.query.lng != null ? Number(req.query.lng) : null,
          locale: req.language || req.user?.language,
          viewerBusinessId: await getViewerBusinessId(req),
        }),
        { $sort: { avgRating: -1, totalReviews: -1 } },
        { $limit: 3 },
        {
          $project: {
            _id: 1,
            name: 1,
            description: 1,
            photos: 1,
            price: 1,
            durationMins: "$sessionSlotMins",
            canBook: 1,
            avgRating: 1,
            totalReviews: 1,
            // The providing business, same shape the list rows carry
            business: 1,
            // A service has no location of its own — servicePipeline hangs the
            // business location (and the distance from the caller's lat/lng)
            // off `business`, so the card lifts both out. Without lat/lng in
            // the query there is no distanceKm to lift and the key is omitted,
            // same as in the list response.
            location: "$business.location",
            distanceKm: "$business.distanceKm",
          },
        },
      ]);
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_found", // Custom translation for successful retrieval
      data: { ...serviceRest, rating, ...(isOwner ? { stats } : {}), ...(isCustomer ? { suggestedServices } : {}) },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_fetch_error", // Custom translation for error
      error,
    });
  }
};

// ─── Update Service Controller ───────────────────────────────────
const updateService = async (req, res) => {
  const { _id: userId, businessId } = req.user;
  const { serviceId } = req.params;
  const updateData = req.body;
  if (updateData.photos) {
    updateData.photos = cleanfiles(updateData.photos);
  }
  // Validate the serviceId parameter and the update data
  const validationOptions = {
    pathParams: ["serviceId"],
    objectIdFields: ["serviceId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Validation failed, response already sent
  }

  try {
    if (updateData.preferredServiceType) {
      const badgeRefError = await validateBadgeOptionRef(updateData.preferredServiceType);
      if (badgeRefError) {
        return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
      }
    }

    // Explicit slots win: they force sameAsBusinessHours off. Session config
    // sent alongside is kept; whatever is omitted gets measured from the
    // intervals further down (same contract as createService).
    const hasSlots = updateData.slots !== undefined;
    if (hasSlots) {
      const formatError = validateServiceSlots(updateData.slots);
      if (formatError) return sendResponse({ res, statusCode: 400, ...formatError });
      updateData.sameAsBusinessHours = false;
    }
    if (updateData.gapBetweenSlotMins === null) updateData.gapBetweenSlotMins = 0;

    // Session config still has to be sane in either mode.
    if (
      updateData.sessionSlotMins !== undefined &&
      (!Number.isInteger(updateData.sessionSlotMins) || updateData.sessionSlotMins <= 0)
    ) {
      return sendResponse({ res, statusCode: 400, translationKey: "session_slot_mins_invalid" });
    }
    if (
      updateData.gapBetweenSlotMins !== undefined &&
      (!Number.isInteger(updateData.gapBetweenSlotMins) || updateData.gapBetweenSlotMins < 0)
    ) {
      return sendResponse({ res, statusCode: 400, translationKey: "gap_between_slot_mins_invalid" });
    }

    // Effective business-hours mode: an explicit sameAsBusinessHours in the
    // request wins; otherwise fall back to whatever's already stored, so a
    // session-only edit (sessionSlotMins/gapBetweenSlotMins with no
    // sameAsBusinessHours resent) still regenerates slots instead of quietly
    // leaving them stale.
    let existing = null;
    let effectiveSameAsBusinessHours = false;
    if (hasSlots) {
      effectiveSameAsBusinessHours = false;
    } else if (
      updateData.sameAsBusinessHours !== undefined ||
      updateData.sessionSlotMins !== undefined ||
      updateData.gapBetweenSlotMins !== undefined
    ) {
      existing = await Services.findOne({ _id: serviceId, business: businessId }).lean();
      if (!existing) {
        return sendResponse({ res, statusCode: 404, translationKey: "service_not_found" });
      }
      effectiveSameAsBusinessHours =
        updateData.sameAsBusinessHours !== undefined ? !!updateData.sameAsBusinessHours : existing.sameAsBusinessHours;
    }

    let businessProfile = null;
    const needsBizProfile = updateData.category || hasSlots || effectiveSameAsBusinessHours;

    if (needsBizProfile) {
      businessProfile = await BusinessProfile.findOne({ user: userId }).lean();

      if (updateData.category) {
        const resolvedCategory = await resolveServiceCategory(businessId, updateData.category);
        if (resolvedCategory.errorKey) {
          return sendResponse({
            res,
            statusCode: 400,
            translationKey: resolvedCategory.errorKey,
          });
        }
        updateData.category = resolvedCategory.id;
      }

      if (hasSlots) {
        const slotError = validateServiceSlotsAgainstOperatingHours(
          updateData.slots,
          businessProfile?.operatingHours || [],
        );
        if (slotError) {
          return sendResponse({ res, statusCode: 400, ...slotError });
        }
      }
    }

    // Business-hours mode: session config (merged with what's stored) must be
    // valid; the stored slots are regenerated from the operating hours.
    if (effectiveSameAsBusinessHours) {
      const effectiveSession =
        updateData.sessionSlotMins !== undefined ? updateData.sessionSlotMins : existing.sessionSlotMins;
      const effectiveGap =
        updateData.gapBetweenSlotMins !== undefined ? updateData.gapBetweenSlotMins : existing.gapBetweenSlotMins;
      const configError = validateSessionConfig(effectiveSession, effectiveGap);
      if (configError) return sendResponse({ res, statusCode: 400, ...configError });
      updateData.slots = generateWeeklySlots(
        businessProfile?.operatingHours || [],
        effectiveSession,
        effectiveGap ?? 0,
      );
      updateData.sameAsBusinessHours = true;
      updateData.sessionSlotMins = effectiveSession;
      updateData.gapBetweenSlotMins = effectiveGap ?? 0;
    }

    if (updateData.name) {
      const isExistingService = await Services.findOne({
        business: businessId,
        name: updateData.name?.trim(),
        _id: { $ne: serviceId },
      });
      if (isExistingService) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "service_already_exists",
        });
      }
    }

    // Explicit slots: fill in only the session config the business didn't
    // send. Nothing sent and nothing measurable (every day closed) is the one
    // case that clears the stored values.
    let update = updateData;
    if (hasSlots) {
      const measured = deriveSessionConfigFromSlots(updateData.slots);
      if (updateData.sessionSlotMins === undefined) updateData.sessionSlotMins = measured.sessionSlotMins;
      if (updateData.gapBetweenSlotMins === undefined) updateData.gapBetweenSlotMins = measured.gapBetweenSlotMins;

      if (updateData.sessionSlotMins == null) {
        delete updateData.sessionSlotMins;
        delete updateData.gapBetweenSlotMins;
        update = { $set: updateData, $unset: { sessionSlotMins: "", gapBetweenSlotMins: "" } };
      }
    }

    const updatedService = await Services.findOneAndUpdate({ _id: serviceId, business: businessId }, update, {
      new: true,
    });

    if (!updatedService) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "service_not_found", // Custom translation for service not found
      });
    }

    if (["name", "description", "photos"].some((key) => key in updateData)) {
      fireAndForget(indexEntityKeywords(Services, updatedService), "service search index");
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_updated", // Custom translation for successful update
      data: updatedService,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_update_error", // Custom translation for error
      error,
    });
  }
};

// ─── Delete Service Controller ───────────────────────────────────
const deleteService = async (req, res) => {
  const { serviceId } = req.params;
  const { businessId } = req.user;
  // Validate the serviceId parameter
  const validationOptions = {
    pathParams: ["serviceId"],
    objectIdFields: ["serviceId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Validation failed, response already sent
  }

  try {
    const deletedService = await Services.findOneAndDelete({ _id: serviceId, business: businessId });

    if (!deletedService) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "service_not_found", // Custom translation for service not found
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_deleted", // Custom translation for successful deletion
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_delete_error", // Custom translation for error
      error,
    });
  }
};

const getServices = async ({ filter = {}, req = {}, includeCounts = false }) => {
  const { keyword, page, limit, business, lat, lng, serviceType, categoryId, status, sortBy } = req?.query || {};
  const userType = req.user?.userType;
  if (business) {
    filter.business = new mongoose.Types.ObjectId(business);
  }
  // serviceType filter now takes a badge option id (preferredServiceType.optionId)
  if (serviceType && serviceType !== "all" && mongoose.Types.ObjectId.isValid(serviceType)) {
    filter["preferredServiceType.optionId"] = new mongoose.Types.ObjectId(serviceType);
  }
  if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
    const categoryObjectId = new mongoose.Types.ObjectId(categoryId);
    filter.$or = [{ category: categoryObjectId }, { subcategory: categoryObjectId }];
  }
  if (userType === "business") {
    filter.business = new mongoose.Types.ObjectId(req.user.businessId);
  }

  // Customers and guests only ever see active services — the status filter
  // below is forced, so an inactive one never surfaces, not even through a
  // keyword search or a `status` query param. Availability is deliberately not
  // filtered: an unavailable service still lists (flagged by canBook), and
  // saying so is left to the slots endpoint.
  const isCustomerView = userType === "user" || userType === "guest";

  // Snapshot before status is applied so statusCounts (all/active/inactive)
  // stay stable regardless of which status tab is selected. Soft-deleted
  // services are excluded from both the list and the counts entirely —
  // "deleted" isn't a browsable tab.
  const countFilter = { ...filter, status: { $ne: "deleted" } };

  if (isCustomerView) {
    filter = { ...filter, status: "active" };
  } else {
    filter.status = status || { $ne: "deleted" };
  }

  const pipeline = [{ $match: filter }];
  if (isCustomerView) {
    // Hide services of businesses that can't be paid yet (Stripe onboarding incomplete)
    pipeline.push(...bookableBusinessPipeline());
  }

  // Keyword search runs inside servicePipeline, i.e. after the $match above —
  // it narrows that result set, it can never widen it back to inactive items.
  pipeline.push(
    ...servicePipeline({
      keyword,
      userLat: lat != null ? Number(lat) : null,
      userLng: lng != null ? Number(lng) : null,
      locale: req.language || req.user?.language,
      viewerBusinessId: await getViewerBusinessId(req),
    }),
  );

  // Nearest-first, before the pagination stage below — sorting after it would
  // only reorder whichever page happened to come back, not surface the closest
  // ones. Ignored without lat/lng, since there'd be no distance to sort on.
  if (sortBy === "distance_near_far" && lat != null && lng != null) {
    pipeline.push(...nearestFirstStages("$business.distanceKm"));
  }
  if (sortBy === "price_low_high") {
    pipeline.push({ $sort: { price: 1 } });
  }
  if (sortBy === "price_high_low") {
    pipeline.push({ $sort: { price: -1 } });
  }

  page && limit && pipeline.push(paginationPipeline({ page, limit }));

  const [res, statusCountsAgg] = await Promise.all([
    Services.aggregate(pipeline),
    includeCounts
      ? Services.aggregate([{ $match: countFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      : Promise.resolve(null),
  ]);
  const { data, meta } = finalRes({ page, limit, data: res }) || {};

  if (includeCounts) {
    const statusCounts = { all: 0, active: 0, inactive: 0 };
    statusCountsAgg.forEach(({ _id, count }) => {
      statusCounts.all += count;
      if (statusCounts[_id] !== undefined) statusCounts[_id] += count;
    });
    return { meta: { ...meta, statusCounts }, data };
  }

  return {
    meta,
    data,
  };
};

// Filter options for the app's service tabs
const serviceTypeList = ["all", "onsite"];
const statusTypeList = ["active", "inactive"];

// ─── Get All Services Controller ───────────────────────────────────
const getAllServices = async (req, res) => {
  if (!validateParams(req, res, { enumFields: { status: statusTypeList } })) return;

  try {
    const { data: services, meta } = await getServices({ req, includeCounts: true });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "services_found", // Custom translation for successful retrieval
      data: services,
      meta: { ...meta, serviceTypeList, statusTypeList },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "services_fetch_error", // Custom translation for error
      error,
    });
  }
};

// ─── Get My Service Categories ───────────────────────────────────
// Freeform categories this business has created, for the service-form
// picker (existing categories + a "create new" option client-side).
const getServiceCategories = async (req, res) => {
  const { businessId } = req.user;
  const { keyword, status } = req.query;

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);

  try {
    const matchStage = {
      business: new mongoose.Types.ObjectId(businessId),
    };
    if (status) {
      matchStage.status = status;
    }

    if (keyword && keyword.trim()) {
      matchStage.name = {
        $regex: escapeRegex(keyword.trim()),
        $options: "i",
      };
    }

    const pipeline = [
      { $match: matchStage },
      { $sort: { createdAt: -1 } },
      { $project: { _id: 1, name: 1, status: 1 } },
      paginationPipeline({ page, limit }),
    ];

    const result = await ServiceCategory.aggregate(pipeline);

    const { data, meta } =
      finalRes({
        page,
        limit,
        data: result,
      }) || {};

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_categories_fetched",
      data,
      meta,
    });
  } catch (error) {
    console.error("getServiceCategories error:", error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_categories_fetch_error",
      error,
    });
  }
};

// ─── Create Service Category ───────────────────────────────────
// Explicit "Create New Category" action from the service-form picker —
// same freeform, per-business category used by createService/updateService.
const createServiceCategory = async (req, res) => {
  const { businessId } = req.user;
  const { name, description } = req.body;

  if (!validateParams(req, res, { formFields: ["name"] })) {
    return;
  }

  try {
    const trimmedName = name.trim();
    const existing = await ServiceCategory.findOne({
      business: businessId,
      name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
    }).lean();
    if (existing) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "service_category_already_exists",
      });
    }

    const category = await ServiceCategory.create({
      business: businessId,
      name: trimmedName,
      description: description?.trim(),
    });
    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "service_category_created",
      data: category,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_category_creation_error",
      error,
    });
  }
};

// ─── Update (Rename) Service Category ───────────────────────────
const updateServiceCategory = async (req, res) => {
  const { businessId } = req.user;
  const { categoryId } = req.params;
  const { name, status, description } = req.body;

  if (!validateParams(req, res, { pathParams: ["categoryId"], objectIdFields: ["categoryId"], formFields: ["name"] })) {
    return;
  }

  try {
    const category = await ServiceCategory.findOne({ _id: categoryId, business: businessId });
    if (!category) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "service_category_not_found",
      });
    }

    const trimmedName = name.trim();
    const duplicate = await ServiceCategory.findOne({
      _id: { $ne: categoryId },
      business: businessId,
      name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
    }).lean();
    if (duplicate) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "service_category_already_exists",
      });
    }

    category.name = trimmedName;
    category.status = status;
    category.description = description?.trim();
    await category.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_category_updated",
      data: category,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "service_category_update_error",
      error,
    });
  }
};

// ─── AI: Suggest Service Category ────────────────────────────────
const suggestServiceCategoryForService = async (req, res) => {
  const { businessId } = req.user;
  const { name, description, selectedCategoryId } = req.body;

  if (!name || !description) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "service_category_suggest_missing_input",
    });
  }

  try {
    const result = await suggestServiceClassification({ businessId, name, description, selectedCategoryId });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_category_suggested",
      data: result,
    });
  } catch (error) {
    // AI enrichment must never block the provider's workflow — degrade to
    // "no suggestion" rather than a 500, same as thumbnail generation does.
    console.log(error);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "service_category_suggested",
      data: {
        matched: false,
        categoryId: null,
        gap: true,
        suggestedCategoryName: null,
        suggestedCategoryDescription: null,
        reason: "ai_unavailable",
      },
    });
  }
};

module.exports = {
  createService,
  getService,
  updateService,
  getServiceCategories,
  createServiceCategory,
  updateServiceCategory,
  deleteService,
  getAllServices,
  getServices,
  suggestServiceCategoryForService,
};
