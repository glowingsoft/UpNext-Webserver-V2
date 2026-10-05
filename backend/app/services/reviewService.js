const mongoose = require("mongoose");
const Review = require("@models/Review");
const Booking = require("@models/Bookings");
const { s3UrlExpr } = require("@utils/aggregationHelper");

const getProductReviews = async ({ scope, targetId, rating, status = "approved", page, limit }) => {
  const p = parseInt(page) || 1;
  const l = parseInt(limit) || 10;

  // scope "business" is internal-only (business review tabs in app/admin
  // business routes): all reviews left on the business's services/packages,
  // matched via the BusinessProfile id every review stores in `business`.
  // The public /reviews endpoints only accept "service" and "package".
  const match =
    scope === "business"
      ? targetId
        ? { business: new mongoose.Types.ObjectId(String(targetId)) }
        : {}
      : {
          reviewType: scope === "service" ? "services" : "packages",
          ...(targetId ? { object: new mongoose.Types.ObjectId(String(targetId)) } : {}),
        };

  // rating filters only the review list — the stats/star-breakdown above the
  // list tabs always reflects the full, unfiltered set
  const statusMatch = status ? { ...match, status } : match;
  const reviewsMatch = rating ? { ...statusMatch, rating: Number(rating) } : statusMatch;

  const [result] = await Review.aggregate([
    {
      $facet: {
        stats: [
          { $match: statusMatch },
          {
            $group: {
              _id: null,
              averageRating: { $avg: "$rating" },
              totalReviews: { $sum: 1 },
              // rating accepts decimals (e.g. 4.5) — bucket by nearest whole
              // star (round-half-up) instead of pushing the raw value, or a
              // review like 4.5 would fail every exact-integer bucket match.
              distribution: { $push: { $floor: { $add: ["$rating", 0.5] } } },
            },
          },
          {
            $addFields: {
              averageRating: { $round: ["$averageRating", 1] },
              distribution: {
                $arrayToObject: {
                  $map: {
                    input: [1, 2, 3, 4, 5],
                    as: "star",
                    in: {
                      k: { $toString: "$$star" },
                      v: {
                        $size: {
                          $filter: {
                            input: "$distribution",
                            cond: { $eq: ["$$this", "$$star"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        reviews: [
          { $match: reviewsMatch },
          { $sort: { createdAt: -1 } },
          { $skip: (p - 1) * l },
          { $limit: l },
          {
            $lookup: {
              from: "users",
              localField: "subject",
              foreignField: "_id",
              as: "reviewer",
              pipeline: [
                {
                  $project: {
                    name: 1,
                    // profileIcon can already be a full URL (e.g. OAuth avatar) —
                    // only prefix S3_BASE_URL when it isn't, to avoid double-prefixing.
                    profileIcon: {
                      $cond: [
                        { $regexMatch: { input: { $ifNull: ["$profileIcon", ""] }, regex: "^https?:\/\/" } },
                        "$profileIcon",
                        s3UrlExpr("$profileIcon"),
                      ],
                    },
                  },
                },
              ],
            },
          },
          { $addFields: { reviewer: { $first: "$reviewer" } } },
          { $project: { reviewType: 0, object: 0, subject: 0, __v: 0 } },
        ],
        total: [{ $match: reviewsMatch }, { $count: "count" }],
      },
    },
  ]);

  const stats = result.stats[0] ?? { averageRating: 0, totalReviews: 0, distribution: {} };
  const total = result.total[0]?.count ?? 0;

  return {
    data: {
      stats,
      reviews: result.reviews,
    },
    meta: { page: p, limit: l, total },
  };
};

const getAllReviews = async ({ scope, targetId, rating, status, keyword, page, limit }) => {
  const p = parseInt(page) || 1;
  const l = parseInt(limit) || 10;

  // scope "business" is internal-only (business review tabs in app/admin
  // business routes): all reviews left on the business's services/packages,
  // matched via the BusinessProfile id every review stores in `business`.
  // The public /reviews endpoints only accept "service" and "package".
  const match =
    scope === "business"
      ? targetId
        ? { business: new mongoose.Types.ObjectId(String(targetId)) }
        : {}
      : {
          reviewType: scope === "service" ? "services" : "packages",
          ...(targetId ? { object: new mongoose.Types.ObjectId(String(targetId)) } : {}),
        };

  // keyword searches the reviewer's name, the reviewed business/service/package
  // name, the booking id, and the comment — all only resolvable after the joins
  // below, so it's applied post-lookup rather than folded into `match`.
  const keywordMatch = keyword
    ? {
        $or: [
          { comment: { $regex: keyword, $options: "i" } },
          { reviewerName: { $regex: keyword, $options: "i" } },
          { businessName: { $regex: keyword, $options: "i" } },
          { objectName: { $regex: keyword, $options: "i" } },
          { bookingCode: { $regex: keyword, $options: "i" } },
        ],
      }
    : {};

  // rating filters only the review list — the stats/star-breakdown above the
  // list tabs always reflects the full, unfiltered set. statusCounts ignores
  // both status and rating so the admin tab counters always show the totals
  // for the current scope/keyword regardless of which tab/rating is selected.
  const statusMatch = status ? { ...keywordMatch, status } : keywordMatch;
  const reviewsMatch = rating ? { ...statusMatch, rating: Number(rating) } : statusMatch;

  const [result] = await Review.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "users",
        localField: "subject",
        foreignField: "_id",
        as: "reviewer",
        pipeline: [
          {
            $project: {
              name: 1,
              // profileIcon can already be a full URL (e.g. OAuth avatar) —
              // only prefix S3_BASE_URL when it isn't, to avoid double-prefixing.
              profileIcon: {
                $cond: [
                  { $regexMatch: { input: { $ifNull: ["$profileIcon", ""] }, regex: "^https?:\/\/" } },
                  "$profileIcon",
                  s3UrlExpr("$profileIcon"),
                ],
              },
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "businessprofiles",
        localField: "business",
        foreignField: "_id",
        as: "businessInfo",
        pipeline: [{ $project: { businessName: 1 } }],
      },
    },
    {
      $lookup: {
        from: "bookings",
        localField: "booking",
        foreignField: "_id",
        as: "bookingInfo",
        pipeline: [{ $project: { bookingId: 1, date: 1, target: 1 } }],
      },
    },
    // object's model depends on reviewType ("services" | "packages") — try both
    // collections, only the matching one will return a hit for a given review.
    {
      $lookup: {
        from: "services",
        localField: "object",
        foreignField: "_id",
        as: "serviceObj",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $lookup: {
        from: "packages",
        localField: "object",
        foreignField: "_id",
        as: "packageObj",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $addFields: {
        reviewer: { $first: "$reviewer" },
        businessName: { $first: "$businessInfo.businessName" },
        objectName: { $ifNull: [{ $first: "$serviceObj.name" }, { $first: "$packageObj.name" }] },
        booking: { $first: "$bookingInfo" },
        bookingCode: { $first: "$bookingInfo.bookingId" },
      },
    },
    { $addFields: { reviewerName: "$reviewer.name" } },
    { $project: { businessInfo: 0, serviceObj: 0, packageObj: 0, bookingInfo: 0 } },
    {
      $facet: {
        statusCounts: [{ $match: keywordMatch }, { $group: { _id: "$status", count: { $sum: 1 } } }],
        stats: [
          { $match: statusMatch },
          {
            $group: {
              _id: null,
              averageRating: { $avg: "$rating" },
              totalReviews: { $sum: 1 },
              // rating accepts decimals (e.g. 4.5) — bucket by nearest whole
              // star (round-half-up) instead of pushing the raw value, or a
              // review like 4.5 would fail every exact-integer bucket match.
              distribution: { $push: { $floor: { $add: ["$rating", 0.5] } } },
            },
          },
          {
            $addFields: {
              averageRating: { $round: ["$averageRating", 1] },
              distribution: {
                $arrayToObject: {
                  $map: {
                    input: [1, 2, 3, 4, 5],
                    as: "star",
                    in: {
                      k: { $toString: "$$star" },
                      v: {
                        $size: {
                          $filter: {
                            input: "$distribution",
                            cond: { $eq: ["$$this", "$$star"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        reviews: [
          { $match: reviewsMatch },
          { $sort: { createdAt: -1 } },
          { $skip: (p - 1) * l },
          { $limit: l },
          { $project: { reviewType: 0, object: 0, subject: 0, reviewerName: 0, bookingCode: 0, __v: 0 } },
        ],
        total: [{ $match: reviewsMatch }, { $count: "count" }],
      },
    },
  ]);

  const stats = result.stats[0] ?? { averageRating: 0, totalReviews: 0, distribution: {} };
  const total = result.total[0]?.count ?? 0;

  const statusCounts = { pending: 0, approved: 0, rejected: 0 };
  for (const { _id, count } of result.statusCounts) {
    if (_id in statusCounts) statusCounts[_id] = count;
  }

  return {
    data: {
      stats,
      statusCounts,
      reviews: result.reviews,
    },
    meta: { page: p, limit: l, total },
  };
};

const createReview = async ({ userId, bookingId, rating, comment }) => {
  // Review is tied to one specific completed booking — not just "the user has
  // some completed booking for this target" — so a booking id is required and
  // must actually match the reviewer and be eligible for review. scope/targetId
  // are never taken from the caller — they're derived from the booking itself
  // so a review can never be attached to a different target than what was booked.
  const booking = await Booking.findOne({
    _id: bookingId,
    user: userId,
    $or: [{ status: "completed" }, { status: "scheduled", date: { $lt: new Date() } }],
  });
  if (!booking) return { error: "review_no_completed_booking", status: 403 };

  const alreadyReviewed = await Review.exists({ booking: booking._id });
  if (alreadyReviewed) return { error: "review_already_submitted", status: 400 };

  const review = await Review.create({
    reviewType: booking.scope === "service" ? "services" : "packages",
    object: booking.target[0]._id,
    subject: userId,
    booking: booking._id,
    rating,
    comment: comment || "",
    business: booking.business,
  });

  return { data: review };
};

const updateReview = async ({ userId, reviewId, rating, comment }) => {
  // Scoped to { _id: reviewId, subject: userId } — only the user who left the
  // review can update it; a mismatch (wrong reviewer, or no such review) both
  // resolve to review_not_found so ownership isn't leaked.
  const review = await Review.findOne({ _id: reviewId, subject: userId });
  if (!review) return { error: "review_not_found", status: 404 };

  const changed = rating !== undefined || comment !== undefined;
  if (rating !== undefined) review.rating = rating;
  if (comment !== undefined) review.comment = comment;
  // Any customer edit needs a fresh moderation decision before it is visible.
  if (changed) review.status = "pending";
  await review.save();

  return { data: review };
};

const moderateReview = async ({ reviewId, businessId, status }) => {
  const review = await Review.findOne({ _id: reviewId, business: businessId });
  if (!review) return { error: "review_not_found", status: 404 };

  review.status = status;
  await review.save();
  return { data: review };
};

const deleteReview = async ({ reviewId, businessId }) => {
  const review = await Review.findById(reviewId);
  if (!review) return { error: "review_not_found", status: 404 };
  if (businessId && review.business?.toString() !== businessId.toString()) {
    return { error: "review_not_found", status: 404 };
  }

  await review.deleteOne();
  return { data: null };
};

module.exports = { getProductReviews, createReview, updateReview, moderateReview, deleteReview, getAllReviews };
