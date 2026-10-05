const mongoose = require("mongoose");
const BusinessProfile = require("@models/BusinessProfile");
const { Services } = require("@models/Services");
const Review = require("@models/Review");
const { sendResponse, validateParams, fireAndForget } = require("@utils/responseUtil");
const BusinessAnalyticsEvent = require("@models/BusinessAnalyticsEvent");
const { servicePipeline, bookableBusinessPipeline, reviewStatsPipeline } = require("@utils/aggregationHelper");
const { getBusinesses } = require("./userController");
const { getViewerBusinessId } = require("@utils/viewerUtil");
const { getServices } = require("./serviceController");
const { getPackages } = require("./packageController");
const { getPromotionTargets } = require("./promotionController");
const { getPortfolios } = require("./portfolioController");
const { getUserBookings } = require("../services/bookingService");
const { getProductReviews } = require("../services/reviewService");

// Customers may only browse business-detail tabs for a business that's actually live
const findActiveBusiness = (businessId) => BusinessProfile.findOne({ _id: businessId, status: "active" }).select("_id");

// ─── Overview — business profile fields + a top-3 services preview ────────
const getBusinessOverview = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    // businessHelperPipeline trims to list-card fields, so overview-only
    // profile fields are fetched alongside it
    const [{ data }, profileExtras] = await Promise.all([
      getBusinesses({ filter: { _id: new mongoose.Types.ObjectId(businessId) }, req }),
      BusinessProfile.findById(businessId).select("description socialLinks badges").lean(),
    ]);
    const business = data?.[0];

    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    // Analytics: this route is customer-only (roleMiddleware(["user"]) on the
    // whole router), so every hit here is a genuine profile view, never a
    // business viewing its own profile.
    fireAndForget(
      BusinessAnalyticsEvent.create({ business: business._id, type: "profile_view", user: req.user._id }),
      "profile_view tracking",
    );

    // Best-rated services this business offers, trimmed to suggestion-card fields
    const services = await Services.aggregate([
      {
        $match: {
          business: new mongoose.Types.ObjectId(businessId),
          status: "active",
          isAvailable: { $ne: false },
        },
      },
      // Route is customer-only — hide services when the business can't be paid yet
      ...bookableBusinessPipeline(),
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
          // business location (and the distance from the caller's lat/lng) off
          // `business`, so the card lifts both out. Without lat/lng in the
          // query there is no distanceKm to lift and the key is omitted.
          location: "$business.location",
          distanceKm: "$business.distanceKm",
        },
      },
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: {
        ...business,
        description: profileExtras?.description || "",
        socialLinks: profileExtras?.socialLinks || null,
        badges: profileExtras?.badges || {},
        services,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Public profile — logged-out "View Profile" page ──────────────────────
// Platform-wide booking policy copy — not stored per-business (no schema
// field for this yet); revisit if businesses need to customize it.
const defaultBookingNotes = [
  "Address details are shared after booking confirmation.",
  "Please arrive on time and ready for your selected service.",
  "You can select a service first or jump straight to the next available opening.",
];

const getPublicBusinessProfile = async (req, res) => {
  const { businessId } = req.params;

  if (
    !validateParams(req, res, {
      pathParams: ["businessId"],
    })
  )
    return;

  const businessObjId = mongoose.isValidObjectId(businessId)
    ? businessId
    : (await BusinessProfile.findOne({ nameSlug: businessId }).select("_id").lean())?._id;

  if (!businessObjId) {
    return sendResponse(res, 404, "Business profile not found");
  }

  return resolvePublicBusinessProfile({
    req,
    res,
    businessId: businessObjId.toString(),
  });
};

// Same profile payload, resolved from the public-facing slug instead of the _id
const getPublicBusinessProfileBySlug = async (req, res) => {
  const { nameSlug } = req.params;

  const business = await BusinessProfile.findOne({ nameSlug }).select("_id").lean();
  if (!business) {
    return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
  }

  return resolvePublicBusinessProfile({ req, res, businessId: business._id.toString() });
};

const resolvePublicBusinessProfile = async ({ req, res, businessId }) => {
  try {
    const businessObjId = new mongoose.Types.ObjectId(businessId);

    const [{ data }, ratingStats, rawServices] = await Promise.all([
      getBusinesses({ filter: { _id: businessObjId }, req }),
      Review.aggregate(reviewStatsPipeline({ business: businessObjId })),
      Services.aggregate([
        { $match: { business: businessObjId, status: "active", isAvailable: true } },
        // Same "can this business actually be paid" gate customers get elsewhere
        ...bookableBusinessPipeline(),
        ...servicePipeline({ locale: req.language, viewerBusinessId: await getViewerBusinessId(req) }),
        {
          $project: {
            _id: 1,
            name: 1,
            price: 1,
            durationMins: "$sessionSlotMins",
            canBook: 1,
            // Same numbers as durationMins, under the names the service/package
            // documents use — kept alongside it so existing clients reading
            // durationMins don't break.
            sessionSlotMins: 1,
            gapBetweenSlotMins: 1,
            category: { _id: "$category._id", name: "$category.name" },
            preferredServiceType: 1,
            slots: 1,
            howLateCanBook: 1,
            howLateCanCancel: 1,
            refundPercentage: 1,
          },
        },
        { $sort: { "category.name": 1, name: 1 } },
      ]),
    ]);

    const business = data?.[0];
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    // Analytics: only attributable when the viewer is actually logged in —
    // anonymous/public views aren't tied to a user record.
    if (req.user?._id) {
      fireAndForget(
        BusinessAnalyticsEvent.create({ business: business._id, type: "profile_view", user: req.user._id }),
        "profile_view tracking",
      );
    }

    const categoryCounts = new Map();
    rawServices.forEach((s) => {
      const key = String(s.category?._id || "uncategorized");
      const entry = categoryCounts.get(key) || {
        _id: s.category?._id || null,
        name: s.category?.name || "Other",
        count: 0,
      };
      entry.count += 1;
      categoryCounts.set(key, entry);
    });

    const rating = ratingStats[0] || { avgRating: 0, totalReviews: 0, ratingCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    rating.avgRating = Math.round((rating.avgRating || 0) * 10) / 10;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: {
        ...business,
        rating,
        certificationBadge: business.certifications?.status === "approved" ? business.certifications.optionName : null,
        services: {
          categories: [{ _id: "all", name: "All", count: rawServices.length }, ...categoryCounts.values()],
          items: rawServices,
        },
        bookingNotes: defaultBookingNotes,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Services tab — getServices already restricts customers to active services
const getBusinessServicesTab = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { data, meta } = await getServices({
      filter: { business: new mongoose.Types.ObjectId(businessId) },
      req,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "services_found", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Packages tab — getPackages restricts customers to active packages
const getBusinessPackagesTab = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { data, meta } = await getPackages({
      filter: { business: new mongoose.Types.ObjectId(businessId) },
      req,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "packages_found", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Promotions tab — paginated targets (services/packages) with their
// promotion (and businessInfo) attached, not paginated promotions.
// businessId is optional — omit it to fetch targets across every business
// (promotionTargetsPipeline itself gates out deactivated businesses either way).
// getPromotionTargets has no built-in customer status/expiry gate, so it's applied here.
const getBusinessPromotionsTab = async (req, res) => {
  const { businessId } = req.query;
  const validationOptions = { objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const filter = { status: "active", expiresAt: { $gt: new Date() } };

    if (businessId) {
      const business = await findActiveBusiness(businessId);
      if (!business) {
        return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
      }
      filter.business = new mongoose.Types.ObjectId(businessId);
    }

    const { data, meta } = await getPromotionTargets({ filter, req });

    return sendResponse({ res, statusCode: 200, translationKey: "promotions_found", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Operating hours tab — read only for customers ─────────────────────────
const getOperatingHours = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await BusinessProfile.findOne({ _id: businessId, status: "active" })
      .select("operatingHours")
      .lean();
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "operating_hours_fetched",
      data: { operatingHours: business.operatingHours },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Bookings tab — only the caller's own bookings with this business ──────
const getBookings = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { page, limit, status, scope, date, keyword } = req.query;
    // userId is forced to the caller, not read from the query — a customer can
    // only ever see their own bookings with this business, never anyone else's.
    // Same shape as GET /bookings (getUserBookings), just scoped to one business.
    const { data, meta } = await getUserBookings({
      userId: req.user._id,
      business: businessId,
      page,
      limit,
      status,
      scope,
      date,
      keyword,
      locale: req.language || req.user?.language,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "bookings_fetched", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Reviews tab ─────────────────────────────────────────────────────────
const getReviews = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = {
    pathParams: ["businessId"],
    objectIdFields: ["businessId"],
    enumFields: { rating: ["1", "2", "3", "4", "5"] },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { rating, page, limit } = req.query;
    const { data, meta } = await getProductReviews({
      scope: "business",
      targetId: businessId,
      rating,
      status: "approved",
      page,
      limit,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "reviews_fetched", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "reviews_fetch_error", error });
  }
};

// ─── Portfolios tab ──────────────────────────────────────────────────────
const getBusinessPortfolios = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { data, meta } = await getPortfolios({
      filter: { business: new mongoose.Types.ObjectId(businessId) },
      req,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "portfolios_fetched", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = {
  getBusinessOverview,
  getPublicBusinessProfile,
  getPublicBusinessProfileBySlug,
  getBusinessServicesTab,
  getBusinessPackagesTab,
  getBusinessPromotionsTab,
  getOperatingHours,
  getBookings,
  getReviews,
  getBusinessPortfolios,
};
