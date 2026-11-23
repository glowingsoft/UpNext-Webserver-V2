const mongoose = require("mongoose");
const BookingOffer = require("@models/BookingOffer");
const { safeKeyword } = require("@utils/regexUtil");
const { getFullImageUrl } = require("@utils/imageHelper");

const statuses = BookingOffer.schema.path("status").enumValues;

const getProviderOffers = async ({ businessId, page = 1, limit = 10, status = "pending", keyword = "", now = new Date() }) => {
  if (!businessId) return { error: "booking_offer_unavailable", status: 409 };
  if (status === "") status = "pending";
  if (!mongoose.isValidObjectId(businessId) || !["all", ...statuses].includes(status) || typeof keyword !== "string" ||
      !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { error: "invalid_request", status: 400 };
  }

  const search = safeKeyword(keyword);
  const selectedStatus = status === "all" ? [] : [{ $match: { status } }];
  const [result] = await BookingOffer.aggregate([
    { $match: { business: new mongoose.Types.ObjectId(String(businessId)) } },
    { $lookup: { from: "bookings", localField: "booking", foreignField: "_id", as: "bookingDoc" } },
    { $unwind: "$bookingDoc" },
    {
      $match: {
        $or: [
          { status: { $in: statuses.filter((value) => value !== "pending") } },
          {
            status: "pending",
            expiresAt: { $gt: now },
            "bookingDoc.status": "requested",
            $expr: {
              $and: [
                { $eq: ["$business", "$bookingDoc.business"] },
                { $eq: ["$_id", "$bookingDoc.flow.currentOffer.offerId"] },
                { $eq: ["$expiresAt", "$bookingDoc.offerExpiresAt"] },
                { $or: [
                  { $eq: ["$bookingDoc.flow.currentOffer.pauseAttempt", true] },
                  { $gt: ["$bookingDoc.flow.attemptExpiresAt", now] },
                ] },
              ],
            },
          },
        ],
      },
    },
    ...["services", "packages"].map((from) => ({
      $lookup: {
        from,
        let: { targetId: "$serviceId", providerId: "$business" },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ["$_id", "$$targetId"] },
            { $eq: ["$business", "$$providerId"] },
          ] } } },
          { $project: { name: 1, photos: 1, coverImage: 1 } },
        ],
        as: `original_${from}`,
      },
    })),
    {
      $set: {
        visibleTarget: {
          $let: {
            vars: {
              snapshot: { $filter: {
                input: { $ifNull: ["$bookingDoc.target", []] },
                as: "target",
                cond: { $and: [
                  { $eq: ["$business", "$bookingDoc.business"] },
                  { $eq: ["$$target._id", "$serviceId"] },
                ] },
              } },
              listing: { $ifNull: [
                { $first: "$original_services" },
                { $first: "$original_packages" },
              ] },
            },
            in: { $cond: [
              { $gt: [{ $size: "$$snapshot" }, 0] },
              "$$snapshot",
              { $cond: [
                { $ifNull: ["$$listing", false] },
                [{ _id: "$$listing._id", name: "$$listing.name", price: { $divide: ["$servicePriceCents", 100] } }],
                [],
              ] },
            ] },
          },
        },
      },
    },
    ...(search ? [{ $match: { $or: [
      { "bookingDoc.bookingId": { $regex: search, $options: "i" } },
      { "visibleTarget.name": { $regex: search, $options: "i" } },
    ] } }] : []),
    {
      $facet: {
        statusCounts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        total: [...selectedStatus, { $count: "count" }],
        data: [
          ...selectedStatus,
          { $sort: status === "pending" ? { expiresAt: 1, _id: 1 } : { sentAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: {
            from: "businessprofiles",
            localField: "business",
            foreignField: "_id",
            pipeline: [{ $project: { businessName: 1, image: 1 } }],
            as: "businessInfo",
          } },
          { $project: {
            _id: 0,
            offerId: "$_id",
            bookingId: "$booking",
            status: 1,
            sentAt: 1,
            respondedAt: 1,
            expiresAt: 1,
            servicePriceCents: 1,
            serviceId: 1,
            listing: { $ifNull: [{ $first: "$original_services" }, { $first: "$original_packages" }] },
            businessId: "$business",
            businessInfo: { $first: "$businessInfo" },
            attemptExpiresAt: "$bookingDoc.flow.attemptExpiresAt",
            pauseAttempt: "$bookingDoc.flow.currentOffer.pauseAttempt",
            booking: {
              bookingId: "$bookingDoc.bookingId",
              target: "$visibleTarget",
              date: "$bookingDoc.date",
              slot: "$bookingDoc.slot",
              location: { $cond: [
                { $eq: ["$business", "$bookingDoc.business"] },
                "$bookingDoc.flow.location",
                "$$REMOVE",
              ] },
            },
          } },
        ],
      },
    },
  ]);
  if (!result) throw new Error("Offer list aggregation returned no result");
  const serverNow = new Date();
  const statusCounts = { all: 0, ...Object.fromEntries(statuses.map((value) => [value, 0])) };
  for (const row of result.statusCounts) {
    statusCounts[row._id] = row.count;
    statusCounts.all += row.count;
  }
  const total = result.total[0]?.count || 0;
  return {
    data: result.data
      .filter((offer) => offer.status !== "pending" ||
        (new Date(offer.expiresAt) > serverNow &&
          (offer.pauseAttempt || new Date(offer.attemptExpiresAt) > serverNow)))
      .map(({ attemptExpiresAt, pauseAttempt, serviceId, listing, businessId: id, businessInfo, ...offer }) => ({
        ...offer,
        service: {
          _id: serviceId,
          name: offer.booking?.target?.[0]?.name ?? null,
          image: listing ? getFullImageUrl(listing.coverImage || listing.photos?.[0] || "noimg.png") : null,
        },
        business: {
          _id: id,
          businessName: businessInfo?.businessName ?? null,
          image: getFullImageUrl(businessInfo?.image),
        },
        serverNow,
      })),
    meta: {
      currentPage: page,
      limit,
      totalRecords: total,
      totalPages: Math.ceil(total / limit),
      statusCounts,
    },
  };
};

module.exports = { getProviderOffers };
