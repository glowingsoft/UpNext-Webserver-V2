const mongoose = require("mongoose");
const BusinessProfile = require("@models/BusinessProfile");
const { Services } = require("@models/Services");
const { sendResponse, validateParams } = require("@utils/responseUtil");
const { validateSlotsFormat, regenerateBusinessHourSlots } = require("@utils/serviceUtil");
const { servicePipeline } = require("@utils/aggregationHelper");
const { getServices } = require("../../app/controllers/serviceController");
const { getPackages } = require("../../app/controllers/packageController");
const { getPromotions } = require("../../app/controllers/promotionController");
const {
  getBusinessBookings,
  paymentStatusLabel,
  bookingPriceBreakdown,
  getNextAvailableSlot,
} = require("../../app/services/bookingService");
const { getProductReviews, moderateReview, deleteReview, getAllReviews } = require("../../app/services/reviewService");
const { getBusinesses, businessSortList, countBusinessStatuses } = require("../../app/controllers/userController");

const findActiveBusiness = (businessId) => BusinessProfile.findById(businessId).select("_id");

// Filter options for the admin businesses list — same tabs as the app's list
const businessTypeList = ["all", "solo", "team"];

// ─── List (Admin) — same shape as app/users/businesses, but admin sees
// every status by default (getBusinesses already branches on req.user.userType) ─
const getAllBusinessesAdmin = async (req, res) => {
  // Same guards the app's list applies — an unknown ?status= or ?sortBy= should
  // 400 here too rather than being silently ignored.
  const validationOptions = {
    enumFields: {
      status: ["pending", "active", "inactive", "suspended", "deleted"],
      sortBy: businessSortList,
    },
    dateFields: { date: "YYYY-MM-DD" },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { data, meta, filter } = await getBusinesses({ req });
    const statusList = await countBusinessStatuses(filter);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data,
      meta: { ...meta, businessTypeList, sortByList: businessSortList, statusList },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Overview (Admin) — single business, same shape as a list item, plus a
// top-3 rated services preview (same block the customer app's overview shows) ─
const getBusinessOverview = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { data } = await getBusinesses({
      filter: { _id: new mongoose.Types.ObjectId(businessId) },
      req,
    });
    const business = data?.[0];

    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    // Soonest bookable slot across the business's services and packages —
    // null when nothing is bookable in the next two weeks.
    const nextAvailableSlot = await getNextAvailableSlot({ businessId });

    // Best-rated services this business offers, trimmed to suggestion-card fields
    const services = await Services.aggregate([
      {
        $match: {
          business: new mongoose.Types.ObjectId(businessId),
          status: "active",
          isAvailable: { $ne: false },
        },
      },
      ...servicePipeline({
        userLat: req.query.lat != null ? Number(req.query.lat) : null,
        userLng: req.query.lng != null ? Number(req.query.lng) : null,
        locale: req.language || req.user?.language,
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
          avgRating: 1,
          totalReviews: 1,
          distanceKm: 1,
        },
      },
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: { ...business, nextAvailableSlot, services },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Services (Admin) ────────────────────────────────────────────────────
const getBusinessServices = async (req, res) => {
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

// ─── Packages (Admin) ────────────────────────────────────────────────────
const getBusinessPackages = async (req, res) => {
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

// ─── Promotions (Admin) ──────────────────────────────────────────────────
const getBusinessPromotions = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { data, meta } = await getPromotions({
      filter: { business: new mongoose.Types.ObjectId(businessId) },
      req,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "promotions_found", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Operating hours (Admin) ─────────────────────────────────────────────
const getOperatingHours = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await BusinessProfile.findById(businessId).select("operatingHours").lean();
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

const updateOperatingHours = async (req, res) => {
  const { businessId } = req.params;
  const { operatingHours } = req.body;

  const validationOptions = {
    pathParams: ["businessId"],
    objectIdFields: ["businessId"],
    formFields: ["operatingHours"],
  };
  if (!validateParams(req, res, validationOptions)) return;

  const formatError = validateSlotsFormat(operatingHours);
  if (formatError) return sendResponse({ res, statusCode: 400, ...formatError });

  try {
    const business = await BusinessProfile.findByIdAndUpdate(businessId, { operatingHours }, { new: true }).select(
      "operatingHours",
    );

    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    // Keep business-hours services/packages in sync with the new hours
    await regenerateBusinessHourSlots(business._id, business.operatingHours);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "operating_hours_updated",
      data: { operatingHours: business.operatingHours },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Bookings (Admin) ────────────────────────────────────────────────────
const getBookings = async (req, res) => {
  const { businessId } = req.params;
  const validationOptions = { pathParams: ["businessId"], objectIdFields: ["businessId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const business = await findActiveBusiness(businessId);
    if (!business) {
      return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
    }

    const { page, limit, status, scope, date, userId, keyword } = req.query;
    const { data, meta } = await getBusinessBookings({
      businessId,
      page,
      limit,
      status,
      scope,
      date,
      userId,
      keyword,
      locale: req.language || req.user?.language,
    });

    const bookings = data.map((booking) => ({
      _id: booking._id,
      bookingId: booking.bookingId,
      client: {
        _id: booking.userInfo?._id,
        name: booking.userInfo?.name,
        profileIcon: booking.userInfo?.profileIcon,
      },
      service: booking.name,
      type: booking.preferredServiceType,
      requestedAt: booking.createdAt,
      date: booking.date,
      slot: booking.slot,
      status: booking.status,
      payment: paymentStatusLabel(booking.paymentInfo?.status),
      // The raw Payment.status alongside the label the tab filters speak —
      // "pending" covers both an authorization hold and an untouched card.
      paymentStatus: booking.paymentInfo?.status ?? null,
      price: bookingPriceBreakdown(booking),
    }));

    return sendResponse({ res, statusCode: 200, translationKey: "bookings_fetched", data: bookings, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Reviews (Admin) ─────────────────────────────────────────────────────
const getReviews = async (req, res) => {
  const { businessId } = req.query;
  const validationOptions = {
    enumFields: { rating: ["1", "2", "3", "4", "5"], status: ["pending", "approved", "rejected"] },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    if (businessId) {
      const business = await findActiveBusiness(businessId);
      if (!business) {
        return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
      }
    }

    const { rating, status, keyword, page, limit } = req.query;
    const { data, meta } = await getProductReviews({
      scope: "business",
      targetId: businessId,
      rating,
      status,
      keyword,
      page,
      limit,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "reviews_fetched", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "reviews_fetch_error", error });
  }
};

const moderateBusinessReview = async (req, res) => {
  const { businessId, reviewId } = req.params;
  const { status } = req.body;
  if (
    !validateParams(req, res, {
      pathParams: ["businessId", "reviewId"],
      formFields: ["status"],
      objectIdFields: ["businessId", "reviewId"],
      enumFields: { status: ["approved", "rejected"] },
    })
  )
    return;

  try {
    const result = await moderateReview({ reviewId, businessId, status });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "review_moderated", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

const deleteBusinessReview = async (req, res) => {
  const { businessId, reviewId } = req.params;
  const validationOptions = {
    pathParams: ["businessId", "reviewId"],
    objectIdFields: ["businessId", "reviewId"],
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const result = await deleteReview({ reviewId, businessId });
    if (result.error) {
      return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    }

    return sendResponse({ res, statusCode: 200, translationKey: "review_deleted" });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

const getAllProductReviews = async (req, res) => {
  const { businessId } = req.query;
  const validationOptions = {
    enumFields: { rating: ["1", "2", "3", "4", "5"], status: ["pending", "approved", "rejected"] },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    if (businessId) {
      const business = await findActiveBusiness(businessId);
      if (!business) {
        return sendResponse({ res, statusCode: 404, translationKey: "business_profile_not_found" });
      }
    }

    const { rating, status, keyword, page, limit, scope, targetId } = req.query;
    const { data, meta } = await getAllReviews({
      scope: scope || "business",
      targetId: targetId || businessId,
      rating,
      status,
      keyword,
      page,
      limit,
    });

    return sendResponse({ res, statusCode: 200, translationKey: "reviews_fetched", data, meta });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "reviews_fetch_error", error });
  }
};

module.exports = {
  getAllBusinessesAdmin,
  getBusinessOverview,
  getBusinessServices,
  getBusinessPackages,
  getBusinessPromotions,
  getOperatingHours,
  updateOperatingHours,
  getBookings,
  getReviews,
  getAllProductReviews,
  moderateBusinessReview,
  deleteBusinessReview,
};
