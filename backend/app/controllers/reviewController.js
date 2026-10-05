const { sendResponse, validateParams } = require("@utils/responseUtil");
const { getProductReviews, createReview, updateReview } = require("../services/reviewService");

const getReviews = async (req, res) => {
  const { scope, rating } = req.query;
  let { targetId } = req.query;

  if (
    !validateParams(req, res, {
      queryParams: ["scope"],
      enumFields: { scope: ["service", "package", "business"], rating: ["1", "2", "3", "4", "5"] },
    })
  )
    return;

  if (scope === "business") {
    // Business fetches its own received reviews (across all its services/packages)
    // implicitly from the auth token — no targetId needed on this scope.
    if (!req.user.businessId) {
      return sendResponse({ res, statusCode: 403, translationKey: "business_profile_not_found" });
    }
    targetId = req.user.businessId;
  } else if (!validateParams(req, res, { queryParams: ["targetId"], objectIdFields: ["targetId"] })) {
    return;
  }

  try {
    const result = await getProductReviews({
      scope,
      targetId,
      rating,
      // Providers and public callers see only reviews approved by an admin.
      status: "approved",
      page: req.query.page,
      limit: req.query.limit,
    });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "reviews_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "reviews_fetch_error", error });
  }
};

const submitReview = async (req, res) => {
  const { bookingId, rating, comment } = req.body;

  if (
    !validateParams(req, res, {
      formFields: ["bookingId", "rating"],
      objectIdFields: ["bookingId"],
    })
  )
    return;

  if (typeof rating !== "number" || rating < 1 || rating > 5) {
    return sendResponse({ res, statusCode: 400, translationKey: "review_invalid_rating" });
  }

  try {
    const result = await createReview({
      userId: req.user._id,
      bookingId,
      rating,
      comment,
    });
    if (result.error)
      return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 201, translationKey: "review_created", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "review_create_error", error });
  }
};

const updateReviewController = async (req, res) => {
  const { rating, comment } = req.body;

  if (!validateParams(req, res, { pathParams: ["reviewId"], objectIdFields: ["reviewId"] })) return;

  if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
    return sendResponse({ res, statusCode: 400, translationKey: "review_invalid_rating" });
  }

  try {
    const result = await updateReview({
      userId: req.user._id,
      reviewId: req.params.reviewId,
      rating,
      comment,
    });
    if (result.error)
      return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "review_updated", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "review_update_error", error });
  }
};

module.exports = { getReviews, submitReview, updateReview: updateReviewController };
