const { Packages } = require("@models/Packages");
const { Services } = require("@models/Services");
const Review = require("@models/Review");
const BusinessProfile = require("@models/BusinessProfile");
const { paginationPipeline, finalRes, packagePipeline, reviewStatsPipeline, bookableBusinessPipeline } = require("@utils/aggregationHelper");
const { sendResponse, validateParams, cleanfiles } = require("@utils/responseUtil");
const mongoose = require("mongoose");
const {
  validateServiceSlots,
  validateServiceSlotsAgainstOperatingHours,
  validateSessionConfig,
  deriveSessionConfigFromSlots,
  generateWeeklySlots,
  resolveServiceCategory,
} = require("@utils/serviceUtil");
const { validateBadgeOptionRef } = require("@utils/badgeUtil");
const { getCertificationBlockKey } = require("@utils/certificationUtil");
const { getViewerBusinessId } = require("@utils/viewerUtil");
const { getEntityEarnings } = require("../services/bookingService");

// ─── Create Package Controller ───────────────────────────────────
const createPackage = async (req, res) => {
  const { _id: userId, businessId } = req.user;
  const { name, services, slots, sameAsBusinessHours, preferredServiceType, price, sessionSlotMins, gapBetweenSlotMins } = req.body;

  const validationOptions = {
    formFields: ["name", "price", "category", "services"],
    rawData: ["preferredServiceType"],
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    let actualPrice = 0;
    const { category } = req.body;
    const businessProfile = await BusinessProfile.findOne({ user: userId }).lean();
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

    // Two modes: explicit slots (used as-is; sameAsBusinessHours/session
    // config are ignored) or business-hours mode (sameAsBusinessHours: true +
    // sessionSlotMins, slots generated from operating hours). A `slots` key,
    // when present, must be a valid non-empty array.
    const hasSlots = slots !== undefined;
    let sessionConfig = null;
    if (hasSlots) {
      const formatError = validateServiceSlots(slots);
      if (formatError) return sendResponse({ res, statusCode: 400, ...formatError });

      const slotError = validateServiceSlotsAgainstOperatingHours(slots, businessProfile?.operatingHours || []);
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
        gapBetweenSlotMins:
          gapBetweenSlotMins === undefined ? measured.gapBetweenSlotMins : gapBetweenSlotMins ?? 0,
      };
    } else {
      if (sameAsBusinessHours !== true) {
        return sendResponse({ res, statusCode: 400, translationKey: "slots_or_business_hours_required" });
      }
      const configError = validateSessionConfig(sessionSlotMins, gapBetweenSlotMins);
      if (configError) return sendResponse({ res, statusCode: 400, ...configError });
    }
    const isExisting = await Packages.findOne({
      business: businessId,
      name: name.trim(),
    });

    if (isExisting) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "package_already_exists",
      });
    }
    const badgeRefError = await validateBadgeOptionRef(preferredServiceType);
    if (badgeRefError) {
      return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
    }
    const validServices = await Services.find({
      _id: { $in: services },
      business: businessId,
      isAvailable: true,
      status: "active",
      "preferredServiceType.badgeId": preferredServiceType.badgeId,
      "preferredServiceType.optionId": preferredServiceType.optionId,
    }).select("_id preferredServiceType price");
    if (validServices?.length !== services?.length) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_services",
      });
    }
    actualPrice = validServices.reduce((total, service) => total + service.price, 0);
    if (price >= actualPrice || price <= 0) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_package_price",
      });
    }

    const newPackage = new Packages({
      ...req.body,
      photos: cleanfiles(req?.body?.photos || []),
      coverImage: cleanfiles(req.body.coverImage),
      business: businessId,
      name: name.trim(),
      category: resolvedCategory.id,
      services: validServices?.map((service) => service._id),
      actualPrice,
      // Explicit intervals are stored as-is; business-hours mode stores the
      // auto-generated sessions (operating hours divided by sessionSlotMins,
      // breaks excluded) — regenerated whenever the operating hours change.
      slots: hasSlots
        ? slots
        : generateWeeklySlots(businessProfile?.operatingHours || [], sessionSlotMins, gapBetweenSlotMins ?? 0),
      sameAsBusinessHours: !hasSlots,
      sessionSlotMins: hasSlots ? sessionConfig.sessionSlotMins : sessionSlotMins,
      gapBetweenSlotMins: hasSlots ? sessionConfig.gapBetweenSlotMins : gapBetweenSlotMins ?? 0,
    });

    await newPackage.save();

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "package_created",
      data: newPackage,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "package_creation_error",
      error,
    });
  }
};

// ─── Get Single Package Controller ────────────────────────────────
const getPackage = async (req, res) => {
  const { packageId } = req.params;

  const validationOptions = {
    pathParams: ["packageId"],
    objectIdFields: ["packageId"],
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    // The whole req, not just its lat/lng — canBook needs the viewer to tell
    // whether this package belongs to them.
    const { data } = await getPackages({
      filter: { _id: new mongoose.Types.ObjectId(packageId) },
      req,
    });
    const pkg = data[0];
    if (!pkg) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "package_not_found",
      });
    }

    // Rating breakdown for the "Rating" panel (avg, /5, star distribution)
    // — supersedes the flat avgRating/totalReviews from packagePipeline, so drop those to avoid duplication
    const { avgRating, totalReviews, ...pkgRest } = pkg;
    const [ratingStats] = await Review.aggregate(
      reviewStatsPipeline({ reviewType: "packages", object: pkg._id }),
    );
    const rating = ratingStats || { avgRating: 0, totalReviews: 0, ratingCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

    // Revenue stats (totalEarned/thisWeek/thisMonth) — only shown to the
    // owning business viewing their own package, never customers/admins/other businesses
    const isOwner = req.user?.userType === "business" && String(pkg.business?._id) === String(req.user.businessId);
    const stats = isOwner ? await getEntityEarnings({ entityId: pkg._id, timezone: req.user.timezone }) : null;

    // Suggested packages: other bookable packages in the same category,
    // best rated first — trimmed down to just the suggestion-card fields
    let suggestedPackages = [];
    const categoryId = pkg.category?._id;
    if (categoryId) {
      suggestedPackages = await Packages.aggregate([
        {
          $match: {
            _id: { $ne: pkg._id },
            $or: [
              { category: new mongoose.Types.ObjectId(String(categoryId)) },
              { subcategory: new mongoose.Types.ObjectId(String(categoryId)) },
            ],
            status: "active",
            isAvailable: { $ne: false },
          },
        },
        ...packagePipeline({
          userLat: req.query.lat != null ? Number(req.query.lat) : null,
          userLng: req.query.lng != null ? Number(req.query.lng) : null,
          locale: req.language || req.user?.language,
          viewerBusinessId: await getViewerBusinessId(req),
        }),
        { $sort: { avgRating: -1, totalReviews: -1 } },
        { $limit: 4 },
        {
          $project: {
            _id: 1,
            name: 1,
            description: 1,
            coverImage: 1,
            price: 1,
            durationMins: "$sessionSlotMins",
            canBook: 1,
            avgRating: 1,
            totalReviews: 1,
            // The providing business, same shape the list rows carry
            business: 1,
            // packagePipeline already lifts the business location to the top
            // level and derives distanceKm from it when lat/lng are supplied
            location: 1,
            distanceKm: 1,
          },
        },
      ]);
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "package_found",
      data: { ...pkgRest, rating, ...(isOwner ? { stats } : {}), suggestedPackages },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "package_fetch_error",
      error,
    });
  }
};

// ─── Update Package Controller ───────────────────────────────────
const updatePackage = async (req, res) => {
    const { packageId } = req.params;
    const { _id: userId, businessId } = req.user;
    const updateData = req.body;

    const validationOptions = {
        pathParams: ["packageId"],
        objectIdFields: ["packageId"],
    };

    if (!validateParams(req, res, validationOptions)) return;

    try {
        const package = await Packages.findOne({ _id: packageId, business: businessId });

        if (!package) {
            return sendResponse({
                res,
                statusCode: 404,
                translationKey: "package_not_found",
            });
        }

        const businessProfile = await BusinessProfile.findOne({ user: req.user._id, status: "active" }).lean();

        if (updateData.preferredServiceType) {
            const badgeRefError = await validateBadgeOptionRef(updateData.preferredServiceType);
            if (badgeRefError) {
                return sendResponse({ res, statusCode: 400, translationKey: badgeRefError });
            }
        }

        // 1. Process and validate services first if they are being updated
        let currentActualPrice = package.actualPrice;

        if (updateData.services) {
            // Bundled services must share the package's (possibly updated) preferred service type
            const targetServiceType = updateData.preferredServiceType || package.preferredServiceType;
            const validServices = await Services.find({
                _id: { $in: updateData.services },
                business: businessId, // FIX 1: Changed from req.user._id to businessId
                ...(targetServiceType
                    ? {
                          "preferredServiceType.badgeId": targetServiceType.badgeId,
                          "preferredServiceType.optionId": targetServiceType.optionId,
                      }
                    : {}),
            }).select("_id preferredServiceType price"); // FIX 2: Added 'price' to the selection projection

            if (validServices.length !== updateData.services.length) {
                return sendResponse({
                    res,
                    statusCode: 400,
                    translationKey: "invalid_services",
                });
            }

            // Recalculate actualPrice based on the incoming updated services
            currentActualPrice = validServices.reduce((total, service) => total + (service.price || 0), 0);
            updateData.actualPrice = currentActualPrice;
            updateData.services = validServices.map((service) => service._id);
        }

        // 2. Validate price against the correct (and potentially updated) actualPrice
        if (updateData.price !== undefined) {
            if (updateData.price >= currentActualPrice || updateData.price <= 0) {
                return sendResponse({
                    res,
                    statusCode: 400,
                    translationKey: "invalid_package_price",
                });
            }
        }

        // 3. Validate slots — explicit slots win over business-hours mode
        // (same contract as createPackage / service controllers)
        const hasSlots = updateData.slots !== undefined;
        if (hasSlots) {
            const formatError = validateServiceSlots(updateData.slots);
            if (formatError) return sendResponse({ res, statusCode: 400, ...formatError });

            const slotError = validateServiceSlotsAgainstOperatingHours(
                updateData.slots,
                businessProfile?.operatingHours || [],
            );
            if (slotError) {
                return sendResponse({ res, statusCode: 400, ...slotError });
            }
            // Session config sent alongside is kept; whatever is omitted gets
            // measured from the intervals further down (as in createPackage).
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

        // Business-hours mode: session config (merged with what's stored) must
        // be valid; the stored slots are regenerated from the operating hours.
        if (updateData.sameAsBusinessHours === true) {
            const effectiveSession =
                updateData.sessionSlotMins !== undefined ? updateData.sessionSlotMins : package.sessionSlotMins;
            const effectiveGap =
                updateData.gapBetweenSlotMins !== undefined ? updateData.gapBetweenSlotMins : package.gapBetweenSlotMins;
            const configError = validateSessionConfig(effectiveSession, effectiveGap);
            if (configError) return sendResponse({ res, statusCode: 400, ...configError });
            updateData.slots = generateWeeklySlots(
                businessProfile?.operatingHours || [],
                effectiveSession,
                effectiveGap ?? 0,
            );
            updateData.sessionSlotMins = effectiveSession;
            updateData.gapBetweenSlotMins = effectiveGap ?? 0;
        }

        // 4. Resolve/validate category (existing id owned by this business, or a freeform name to create)
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

        // 5. Sanitize file arrays
        if (updateData.photos) {
            updateData.photos = cleanfiles(updateData.photos || []);
        }
        if (updateData.coverImage) {
            updateData.coverImage = cleanfiles(updateData.coverImage);
        }

        // 6. Persist changes — explicit slots fill in only the session config
        // the business didn't send. Nothing sent and nothing measurable (every
        // day closed) is the one case that clears the stored values.
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

        const updatedPackage = await Packages.findByIdAndUpdate(packageId, update, { new: true });

        if (!updatedPackage) {
            return sendResponse({
                res,
                statusCode: 404,
                translationKey: "package_not_found",
            });
        }

        return sendResponse({
            res,
            statusCode: 200,
            translationKey: "package_updated",
            data: updatedPackage,
        });
    } catch (error) {
        console.error(error);
        return sendResponse({
            res,
            statusCode: 500,
            translationKey: "package_update_error",
            error,
        });
    }
};

// ─── Delete Package Controller ───────────────────────────────────
const deletePackage = async (req, res) => {
  const { packageId } = req.params;

  const validationOptions = {
    pathParams: ["packageId"],
    objectIdFields: ["packageId"],
  };

  if (!validateParams(req, res, validationOptions)) return;

  try {
    const deletedPackage = await Packages.findByIdAndDelete(packageId);

    if (!deletedPackage) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "package_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "package_deleted",
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "package_delete_error",
      error,
    });
  }
};

// ─── Internal Get Packages (aggregation like services) ───────────
const getPackages = async ({ filter = {}, req = {}, includeCounts = false }) => {
  const { keyword, page, limit, business, lat, lng, status } = req?.query || {};
  const userType = req.user?.userType;
  if (business) {
    filter.business = new mongoose.Types.ObjectId(business);
  }
  if (userType === "business") {
    filter.business = new mongoose.Types.ObjectId(req.user.businessId);
  }

  // Customers and guests only ever see active packages — the status filter
  // below is forced, so an inactive one never surfaces, not even through a
  // keyword search or a `status` query param. Availability is deliberately not
  // filtered: an unavailable package still lists (flagged by canBook), and
  // saying so is left to the slots endpoint.
  const isCustomerView = userType === "user" || userType === "guest";

  // Snapshot before status is applied so statusCounts (all/active/inactive)
  // stay stable regardless of which status tab is selected. Soft-deleted
  // packages are excluded from both the list and the counts entirely —
  // "deleted" isn't a browsable tab.
  const countFilter = { ...filter, status: { $ne: "deleted" } };

  if (isCustomerView) {
    filter = { ...filter, status: "active" };
  } else {
    filter.status = status || { $ne: "deleted" };
  }

  const pipeline = [{ $match: filter }];
  if (isCustomerView) {
    // Hide packages of businesses that can't be paid yet (Stripe onboarding incomplete)
    pipeline.push(...bookableBusinessPipeline());
  }

  // Keyword search runs inside packagePipeline, i.e. after the $match above —
  // it narrows that result set, it can never widen it back to inactive items.
  pipeline.push(
    ...packagePipeline({
      keyword,
      userLat: lat != null ? Number(lat) : null,
      userLng: lng != null ? Number(lng) : null,
      locale: req.language || req.user?.language,
      viewerBusinessId: await getViewerBusinessId(req),
    }),
  );

  page && limit && pipeline.push(paginationPipeline({ page, limit }));

  const [result, statusCountsAgg] = await Promise.all([
    Packages.aggregate(pipeline),
    includeCounts
      ? Packages.aggregate([{ $match: countFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      : Promise.resolve(null),
  ]);

  const { data, meta } =
    finalRes({
      page,
      limit,
      data: result,
    }) || {};

  if (includeCounts) {
    const statusCounts = { all: 0, active: 0, inactive: 0 };
    statusCountsAgg.forEach(({ _id, count }) => {
      statusCounts.all += count;
      if (statusCounts[_id] !== undefined) statusCounts[_id] += count;
    });
    return { data, meta: { ...meta, statusCounts } };
  }

  return { data, meta };
};

// Filter options for the app's package tabs
const statusTypeList = ["active", "inactive"];

// ─── Get All Packages Controller ─────────────────────────────────
const getAllPackages = async (req, res) => {
  if (!validateParams(req, res, { enumFields: { status: statusTypeList } })) return;

  try {
    const { data: packages, meta } = await getPackages({ req, includeCounts: true });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "packages_found",
      data: packages,
      meta: { ...meta, statusTypeList },
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "packages_fetch_error",
      error,
    });
  }
};

module.exports = {
  createPackage,
  getPackage,
  updatePackage,
  deletePackage,
  getAllPackages,
  getPackages,
};
