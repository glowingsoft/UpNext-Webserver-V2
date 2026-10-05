const { default: mongoose } = require("mongoose");

const paginationPipeline = ({ page = 1, limit = parseInt(process.env.ITEMPERPAGE) || 10 }) => {
  const skip = (Number(page) - 1) * Number(limit);
  return {
    $facet: {
      metadata: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
          },
        },
      ],
      data: [
        {
          $skip: skip,
        },
        {
          $limit: Number(limit),
        },
      ],
    },
  };
};

const sort = () => {
  return { $sort: { createdAt: -1 } };
};

const finalRes = ({ page, limit, data }) => {
  const { total, _id, ...rest } = (page && limit && data?.[0]?.metadata?.[0]) || {};
  return {
    meta: {
      totalPages: page && limit ? Math.ceil(total / limit) || 1 : data?.length ? data?.length : 1,
      totalRecords: page && limit ? total || 0 : data?.length || 0,
      currentPage: page ? Number(page) : 1,
      limit: limit ? Number(limit) : data?.length || 1,
      ...rest,
    },
    data: page && limit ? data[0]?.data || [] : data,
  };
};

const categoryPipeline = ({ keyword }) => {
  const pipeline = [];
  const search = keyword
    ? {
        $match: {
          $or: [
            { name: { $regex: keyword, $options: "i" } },
            { "subCategories.name": { $regex: keyword, $options: "i" } }, // Search sub-category name
          ],
        },
      }
    : { $match: {} };

  pipeline.push(
    {
      $lookup: {
        from: "categories", // Join with categories
        localField: "_id", // Parent category ID
        foreignField: "parent", // Match parent with sub-category
        as: "subCategories", // Alias for sub-categories
      },
    },
    {
      $unwind: {
        path: "$subCategories", // Unwind sub-categories
        preserveNullAndEmptyArrays: true, // Keep parent if no sub-categories
      },
    },
    search,
    {
      $addFields: {
        "subCategories.icon": s3UrlExpr("$subCategories.icon"), // Add S3 URL to sub-category icon
        icon: s3UrlExpr("$icon"), // Add S3 URL to parent category icon
      },
    },
    {
      $group: {
        _id: "$_id", // Group by parent category ID
        name: { $first: "$name" },
        slug: { $first: "$slug" },
        icon: { $first: "$icon" },
        color: { $first: "$color" },
        parent: { $first: "$parent" },
        sortOrder: { $first: "$sortOrder" },
        status: { $first: "$status" },
        scope: { $first: "$scope" },
        createdAt: { $first: "$createdAt" },
        updatedAt: { $first: "$updatedAt" },
        translations: { $first: "$translations" },
        subCategories: {
          $push: {
            $cond: [{ $ifNull: ["$subCategories._id", false] }, "$subCategories", "$$REMOVE"],
          },
        },
      },
    },
    { $match: { parent: null } }, // Only parent categories
    { $sort: { sortOrder: 1 } }, // Optional: Sort by sortOrder
  );

  return pipeline;
};

// Prefixes an S3 key with S3_BASE_URL, unless it's already a full URL (rows
// saved with the base URL baked in, or third-party image URLs) — plain
// $concat would otherwise double up the base URL for those rows.
// A missing or empty key yields null, not a bare base URL pointing at nothing.
const s3UrlExpr = (fieldExpr) => ({
  $let: {
    vars: { val: { $trim: { input: { $ifNull: [fieldExpr, ""] } } } },
    in: {
      $switch: {
        branches: [
          { case: { $eq: ["$$val", ""] }, then: null },
          { case: { $regexMatch: { input: "$$val", regex: "^https?://" } }, then: "$$val" },
        ],
        default: { $concat: [process.env.S3_BASE_URL, "$$val"] },
      },
    },
  },
});

// Shared placeholder key — the same one the single-image fields default to
// (BusinessProfile.image/coverPhoto, HelpCenter.image, Packages.coverImage).
const PLACEHOLDER_IMAGE_KEY = "noimg.png";

// A gallery array, S3-resolved. A row nobody uploaded photos for comes back
// holding the placeholder instead of `[]`, so clients never have to render an
// empty carousel. Rows that do have photos are untouched.
const photosExpr = (fieldExpr = "$photos") => ({
  $let: {
    vars: { photoList: { $ifNull: [fieldExpr, []] } },
    in: {
      $cond: [
        { $gt: [{ $size: "$$photoList" }, 0] },
        { $map: { input: "$$photoList", as: "photo", in: s3UrlExpr("$$photo") } },
        [s3UrlExpr(PLACEHOLDER_IMAGE_KEY)],
      ],
    },
  },
});

// Localized badge/option display name: translations.<locale> when set and
// non-empty, otherwise the base name.
const translatedNameExpr = (subject, locale) => ({
  $let: {
    vars: { t: { $ifNull: [`${subject}.translations.${locale}`, ""] } },
    in: { $cond: [{ $eq: ["$$t", ""] }, `${subject}.name`, "$$t"] },
  },
});

// Enriches a { badgeId, optionId } badge reference (e.g. preferredServiceType)
// into { badgeId, optionId, badgeName, optionName } with names localized to
// `locale`. Docs without the reference pass through untouched.
const badgeOptionRefPipeline = ({ field = "preferredServiceType", locale = "en" } = {}) => {
  // locale lands in a field path — restrict to 2-letter codes, fall back to en
  const lng = /^[a-z]{2}$/.test(locale || "") ? locale : "en";
  return [
    {
      $lookup: {
        from: "badges",
        localField: `${field}.badgeId`,
        foreignField: "_id",
        as: "__badgeRef",
      },
    },
    {
      $addFields: {
        [field]: {
          $cond: [
            { $ifNull: [`$${field}.badgeId`, false] },
            {
              $let: {
                vars: { badge: { $first: "$__badgeRef" } },
                in: {
                  $let: {
                    vars: {
                      option: {
                        $first: {
                          $filter: {
                            input: { $ifNull: ["$$badge.options", []] },
                            as: "opt",
                            cond: { $eq: ["$$opt._id", `$${field}.optionId`] },
                          },
                        },
                      },
                    },
                    in: {
                      badgeId: `$${field}.badgeId`,
                      optionId: `$${field}.optionId`,
                      badgeName: { $ifNull: [translatedNameExpr("$$badge", lng), null] },
                      optionName: { $ifNull: [translatedNameExpr("$$option", lng), null] },
                    },
                  },
                },
              },
            },
            `$${field}`,
          ],
        },
      },
    },
    { $unset: "__badgeRef" },
  ];
};

const haversineKmExpr = (latField, lngField, userLat, userLng) => {
  const R = 6371;
  const PI_180 = Math.PI / 180;
  const lat2 = { $multiply: [PI_180, latField] };
  const lat1 = { $multiply: [PI_180, userLat] };
  const dLat = { $multiply: [PI_180, { $subtract: [latField, userLat] }] };
  const dLng = { $multiply: [PI_180, { $subtract: [lngField, userLng] }] };
  const a = {
    $add: [
      { $pow: [{ $sin: { $divide: [dLat, 2] } }, 2] },
      {
        $multiply: [{ $cos: lat1 }, { $cos: lat2 }, { $pow: [{ $sin: { $divide: [dLng, 2] } }, 2] }],
      },
    ],
  };
  return {
    $round: [{ $multiply: [R, { $multiply: [2, { $atan2: [{ $sqrt: a }, { $sqrt: { $subtract: [1, a] } }] }] }] }, 1],
  };
};

const servicePipeline = ({ keyword, userLat, userLng, locale, viewerBusinessId = null }) => {
  const pipeline = [];

  pipeline.push(
    // Before the stages below rewrite `business` into an object — canBook
    // compares against the raw ObjectId.
    ...canBookPipeline({ viewerBusinessId }),
    ...badgeOptionRefPipeline({ locale }),
    {
      $lookup: {
        from: "servicecategories",
        localField: "category",
        foreignField: "_id",
        as: "category",
      },
    },
    {
      $unwind: {
        path: "$category",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $addFields: {
        "category.icon": s3UrlExpr("$category.icon"),
        // $ifNull so the key is present even on docs saved before the field existed
        description: { $ifNull: ["$description", ""] },
        photos: photosExpr(),
      },
    },
    ...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "services" } }),
    {
      $lookup: {
        from: "businessprofiles",
        localField: "business",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              _id: 1,
              businessName: 1,
              image: s3UrlExpr("$image"),
              location: 1,
              isAvailable: 1,
            },
          },
        ],
        as: "businessDetails",
      },
    },
    {
      $addFields: {
        business:
          userLat != null && userLng != null
            ? {
                $let: {
                  vars: { b: { $first: "$businessDetails" } },
                  in: {
                    $mergeObjects: [
                      "$$b",
                      {
                        distanceKm: haversineKmExpr(
                          { $arrayElemAt: ["$$b.location.coordinates", 1] },
                          { $arrayElemAt: ["$$b.location.coordinates", 0] },
                          Number(userLat),
                          Number(userLng),
                        ),
                      },
                    ],
                  },
                },
              }
            : { $first: "$businessDetails" },
      },
    },
    { $unset: "businessDetails" },
  );

  // Keyword matches after the lookups so business/category names are searchable too
  if (keyword) {
    pipeline.push({
      $match: {
        $or: [
          { name: { $regex: keyword, $options: "i" } },
          { "business.businessName": { $regex: keyword, $options: "i" } },
          { "category.name": { $regex: keyword, $options: "i" } },
        ],
      },
    });
  }
  return pipeline;
};

const packagePipeline = ({ keyword, userLat, userLng, locale, viewerBusinessId = null }) => {
  const pipeline = [...canBookPipeline({ viewerBusinessId })];

  if (keyword) {
    pipeline.push({
      $match: {
        name: { $regex: keyword, $options: "i" },
      },
    });
  }
  pipeline.push(
    ...badgeOptionRefPipeline({ locale }),
    {
      $lookup: {
        from: "servicecategories",
        localField: "category",
        foreignField: "_id",
        as: "category",
      },
    },
    {
      $unwind: {
        path: "$category",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "services",
        let: { serviceIds: "$services" },
        pipeline: [
          { $match: { $expr: { $in: ["$_id", "$$serviceIds"] } } },
          {
            $project: {
              _id: 1,
              name: 1,
              // $ifNull so the key is present even on docs saved before the field existed
              description: { $ifNull: ["$description", ""] },
              preferredServiceType: 1,
              price: 1,
              business: 1,
              photos: photosExpr(),
            },
          },
          ...badgeOptionRefPipeline({ locale }),
          ...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "services" } }),
          {
            $lookup: {
              from: "businessprofiles",
              localField: "business",
              foreignField: "_id",
              pipeline: [{ $project: { _id: 0, location: 1 } }],
              as: "businessDetails",
            },
          },
          { $addFields: { location: { $first: "$businessDetails.location" } } },
          ...(userLat != null && userLng != null
            ? [
                {
                  $addFields: {
                    distanceKm: haversineKmExpr(
                      { $arrayElemAt: ["$location.coordinates", 1] },
                      { $arrayElemAt: ["$location.coordinates", 0] },
                      Number(userLat),
                      Number(userLng),
                    ),
                  },
                },
              ]
            : []),
          { $unset: ["businessDetails", "business"] },
        ],
        as: "services",
      },
    },
    {
      $addFields: {
        coverImage: s3UrlExpr("$coverImage"),
        "category.icon": s3UrlExpr("$category.icon"),
        // $ifNull so the key is present even on docs saved before the field existed
        description: { $ifNull: ["$description", ""] },
        photos: photosExpr(),
      },
    },
    ...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "packages" } }),
    {
      $lookup: {
        from: "businessprofiles",
        localField: "business",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              _id: 1,
              businessName: 1,
              image: s3UrlExpr("$image"),
              location: 1,
              isAvailable: 1,
            },
          },
        ],
        as: "packageBusinessDetails",
      },
    },
    {
      $addFields: {
        business: { $first: "$packageBusinessDetails" },
        location: { $first: "$packageBusinessDetails.location" },
      },
    },
    ...(userLat != null && userLng != null
      ? [
          {
            $addFields: {
              distanceKm: haversineKmExpr(
                { $arrayElemAt: ["$location.coordinates", 1] },
                { $arrayElemAt: ["$location.coordinates", 0] },
                Number(userLat),
                Number(userLng),
              ),
            },
          },
        ]
      : []),
    { $unset: "packageBusinessDetails" },
  );
  return pipeline;
};
// Applies the promotion's own discount/discountType (passed in via `let` as
// $$discountType/$$discount) to the target's own $price — mirrors
// bookingService.js's resolveAmount() so the promo listing shows the same
// final price a booking would actually charge.
const promotionFinalPriceExpr = {
  $max: [
    0,
    {
      $cond: [
        { $eq: ["$$discountType", "percentage"] },
        { $subtract: ["$price", { $divide: [{ $multiply: ["$price", "$$discount"] }, 100] }] },
        { $subtract: ["$price", "$$discount"] },
      ],
    },
  ],
};

const promotionPipeline = ({ keyword, locale, userLat = null, userLng = null }) => {
  const hasUserCoords = userLat != null && userLng != null;
  // Distance off the promoting business's own coordinates — every target of a
  // promotion belongs to that one business (validateTarget enforces it), so
  // the promotion, its business and each of its targets all share one distance.
  const businessDistanceExpr = (locationField) =>
    haversineKmExpr(
      { $arrayElemAt: [`${locationField}.coordinates`, 1] },
      { $arrayElemAt: [`${locationField}.coordinates`, 0] },
      Number(userLat),
      Number(userLng),
    );
  const pipeline = [];

  pipeline.push(
    // targetId is an array — one promotion can bundle multiple services/packages.
    // Matched by targetId alone (not gated by scope) — a "both" promotion's
    // targets can be a mix of services and packages, so both need checking.
    // A given id can only ever be a real document in one of the two
    // collections, so each id ends up in exactly one of the two lookups.
    {
      $lookup: {
        from: "services",
        let: {
          targetIds: "$targetId",
          discountType: "$discountType",
          discount: "$discount",
        },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$_id", "$$targetIds"] },
            },
          },
          ...badgeOptionRefPipeline({ locale }),
          // Same rating the service list/detail endpoints report, so a promotion
          // card can show stars without a follow-up call per target.
          ...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "services" } }),
          {
            $project: {
              _id: 1,
              name: "$name",
              // Which collection this target came from. `target` is a mixed
              // array once scope is "both", and the two lookups are the only
              // place that distinction survives — the promotion's own `scope`
              // can't tell you what any individual row is.
              scope: "services",
              // $ifNull so the key is present even on docs saved before the field existed
              description: { $ifNull: ["$description", ""] },
              type: "$preferredServiceType",
              price: 1,
              finalPrice: promotionFinalPriceExpr,
              rating: { avgRating: "$avgRating", totalReviews: "$totalReviews" },
              photos: photosExpr(),
            },
          },
        ],
        as: "serviceDetails",
      },
    },
    {
      $lookup: {
        from: "packages",
        let: {
          targetIds: "$targetId",
          discountType: "$discountType",
          discount: "$discount",
        },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$_id", "$$targetIds"] },
            },
          },
          ...badgeOptionRefPipeline({ locale }),
          ...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "packages" } }),
          {
            $project: {
              _id: 1,
              name: "$name",
              scope: "packages",
              // $ifNull so the key is present even on docs saved before the field existed
              description: { $ifNull: ["$description", ""] },
              type: "$preferredServiceType",
              price: 1,
              finalPrice: promotionFinalPriceExpr,
              rating: { avgRating: "$avgRating", totalReviews: "$totalReviews" },
              photos: photosExpr(),
            },
          },
        ],
        as: "packageDetails",
      },
    },
    {
      $lookup: {
        from: "businessprofiles",
        localField: "business",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              _id: 1,
              businessName: 1,
              image: s3UrlExpr("$image"),
              location: 1,
              isAvailable: 1,
            },
          },
        ],
        as: "businessDetails",
      },
    },
    // Usage & limits (business promotion detail) — redemptionsUsed is a live
    // count from PromotionUsage, not a stored counter, so it can never drift.
    // perUserLimit itself is unchanged/untouched here, only surfaced as-is.
    {
      $lookup: {
        from: "promotionusages",
        localField: "_id",
        foreignField: "promotion",
        as: "usageDocs",
      },
    },
    {
      // target is always the combined array of matched services/packages —
      // for scope "services"/"packages" one of these arrays is simply empty
      $addFields: {
        target: {
          // Services and packages hold no location of their own — it is the
          // business's, resolved the same way servicePipeline/packagePipeline do
          // it. Every target of a promotion belongs to that one business
          // (validateTarget enforces it), so the profile already looked up above
          // serves all of them and no per-target lookup is needed.
          $let: {
            // $ifNull so the key is present even when the profile no longer
            // resolves — without it $mergeObjects drops a missing value and the
            // targets of an orphaned business come back with no `location` key
            // at all rather than a null one.
            vars: { businessLocation: { $ifNull: [{ $first: "$businessDetails.location" }, null] } },
            in: {
              $map: {
                input: { $concatArrays: ["$serviceDetails", "$packageDetails"] },
                as: "item",
                in: {
                  $mergeObjects: [
                    "$$item",
                    {
                      location: "$$businessLocation",
                      // Only when the caller sent lat/lng, matching how the
                      // service/package lists omit the key rather than null it
                      ...(hasUserCoords ? { distanceKm: businessDistanceExpr("$$businessLocation") } : {}),
                    },
                  ],
                },
              },
            },
          },
        },
        business: { $first: "$businessDetails" },
        // $ifNull so the key is present even on promotions saved before the field existed
        description: { $ifNull: ["$description", ""] },
        photos: photosExpr(),
        redemptionsUsed: { $size: "$usageDocs" },
        redemptionsRemaining: {
          $max: [0, { $subtract: ["$totalUsageLimit", { $size: "$usageDocs" }] }],
        },
      },
    },
    {
      $project: {
        serviceDetails: 0,
        packageDetails: 0,
        businessDetails: 0,
        usageDocs: 0,
      },
    },
  );

  // Same distance on the business object the card renders, so a client showing
  // "2.4 km away" next to the business name doesn't have to reach into target[0]
  if (hasUserCoords) {
    pipeline.push({ $addFields: { "business.distanceKm": businessDistanceExpr("$business.location") } });
  }

  // Keyword match runs after the target lookup so service/package names are searchable too
  if (keyword) {
    pipeline.push({
      $match: {
        $or: [
          { name: { $regex: keyword, $options: "i" } },
          { promoCode: { $regex: keyword, $options: "i" } },
          { "target.name": { $regex: keyword, $options: "i" } },
        ],
      },
    });
  }

  pipeline.push(...reviewRatingPipeline({ matchTo: "object", targetId: "_id", filter: { reviewType: "packages" } }));

  return pipeline;
};

// Same discount formula as promotionFinalPriceExpr, but for stages running
// directly on a Promotion document (discountType/discount are plain fields
// here, not $$let vars passed into a lookup sub-pipeline).
const promotionTargetFinalPriceExpr = (priceField) => ({
  $max: [
    0,
    {
      $cond: [
        { $eq: ["$discountType", "percentage"] },
        { $subtract: [priceField, { $divide: [{ $multiply: [priceField, "$discount"] }, 100] }] },
        { $subtract: [priceField, "$discount"] },
      ],
    },
  ],
});

// Target-centric view of promotions: one row per (promotion, target) pair
// instead of one row per promotion with a nested target array. Run on top of
// a Promotion match+pagination pipeline so pagination operates over targets
// — a promotion bundling 5 services pages as 5 items, not 1.
const promotionTargetsPipeline = ({ keyword, locale, userLat = null, userLng = null }) => {
  const hasUserCoords = userLat != null && userLng != null;
  const pipeline = [
    { $unwind: "$targetId" },
    {
      $lookup: {
        from: "services",
        let: { targetId: "$targetId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$targetId"] } } },
          ...badgeOptionRefPipeline({ locale }),
          {
            $project: {
              _id: 1,
              name: 1,
              description: { $ifNull: ["$description", ""] },
              type: "$preferredServiceType",
              price: 1,
              photos: photosExpr(),
            },
          },
        ],
        as: "serviceTarget",
      },
    },
    {
      $lookup: {
        from: "packages",
        let: { targetId: "$targetId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$targetId"] } } },
          ...badgeOptionRefPipeline({ locale }),
          {
            $project: {
              _id: 1,
              name: 1,
              description: { $ifNull: ["$description", ""] },
              type: "$preferredServiceType",
              price: 1,
              photos: photosExpr(),
            },
          },
        ],
        as: "packageTarget",
      },
    },
    {
      $lookup: {
        from: "businessprofiles",
        let: { businessId: "$business" },
        pipeline: [
          // status: "active" gated here (not left to the caller's filter) so a
          // deactivated business's promotions never leak into an unscoped
          // (all-businesses) request
          { $match: { $expr: { $eq: ["$_id", "$$businessId"] }, status: "active" } },
          {
            $project: {
              _id: 1,
              businessName: 1,
              image: s3UrlExpr("$image"),
              location: 1,
              isAvailable: 1,
            },
          },
        ],
        as: "businessTarget",
      },
    },
    {
      $addFields: {
        target: { $first: { $concatArrays: ["$serviceTarget", "$packageTarget"] } },
        businessInfo: { $first: "$businessTarget" },
        scope: {
          $cond: [
            { $gt: [{ $size: "$serviceTarget" }, 0] },
            "service",
            { $cond: [{ $gt: [{ $size: "$packageTarget" }, 0] }, "package", null] },
          ],
        },
      },
    },
    // Drop rows whose target or business no longer resolves (deleted service/package, deactivated business, etc.)
    { $match: { target: { $ne: null }, businessInfo: { $ne: null } } },
  ];

  if (keyword) {
    pipeline.push({
      $match: {
        $or: [
          { name: { $regex: keyword, $options: "i" } },
          { promoCode: { $regex: keyword, $options: "i" } },
          { "target.name": { $regex: keyword, $options: "i" } },
        ],
      },
    });
  }

  pipeline.push({
    $project: {
      _id: "$target._id",
      scope: 1,
      name: "$target.name",
      description: "$target.description",
      type: "$target.type",
      price: "$target.price",
      finalPrice: promotionTargetFinalPriceExpr("$target.price"),
      photos: "$target.photos",
      businessInfo: 1,
      // A row here is a service/package, which has no location of its own — it
      // is the promoting business's, lifted out of businessInfo so the card
      // reads the same as a service/package list item.
      location: "$businessInfo.location",
      ...(hasUserCoords
        ? {
            distanceKm: haversineKmExpr(
              { $arrayElemAt: ["$businessInfo.location.coordinates", 1] },
              { $arrayElemAt: ["$businessInfo.location.coordinates", 0] },
              Number(userLat),
              Number(userLng),
            ),
          }
        : {}),
      promotion: {
        _id: "$_id",
        name: "$name",
        promoCode: "$promoCode",
        discountType: "$discountType",
        discount: "$discount",
        photos: photosExpr(),
        expiresAt: "$expiresAt",
      },
    },
  });

  return pipeline;
};

const categoryHelperPipeline = (field) => [
  {
    $lookup: {
      from: "categories",
      let: { categoryId: `$${field}` },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$categoryId"] } } },
        {
          $project: {
            _id: 1,
            name: 1,
            color: 1,
            icon: s3UrlExpr("$icon"), // Add S3 URL for category icon
          },
        },
      ],
      as: `${field}`,
    },
  },
  {
    $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true },
  },
];

const userRatingPipeline = (field) => {
  return [
    {
      $lookup: {
        from: "reviews",
        localField: field + "._id",
        foreignField: "seekerId",
        as: "reviews",
      },
    },
    {
      $addFields: {
        [`${field}.avgRating`]: {
          $cond: {
            if: { $gt: [{ $size: "$reviews" }, 0] },
            then: { $avg: "$reviews.rating" },
            else: 0,
          },
        },
      },
    },
  ];
};
const userHelperPipeline = (field) => [
  {
    $lookup: {
      from: "users",
      let: { userId: `$${field}` },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
        {
          $project: {
            _id: 1,
            name: 1,
            skills: 1,
            profileIcon: s3UrlExpr("$profileIcon"), // Add S3 URL for profile icon
          },
        },
      ],
      as: `${field}`,
    },
  },
  {
    $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true },
  },
];

const userStatsPipeline = ({ filter = {} }) => {
  return [
    { $match: filter },

    {
      $lookup: {
        from: "jobapplications",
        localField: "_id",
        foreignField: "userId",
        as: "jobApplications",
      },
    },

    {
      $addFields: {
        totalAppliedJobs: {
          $size: {
            $filter: {
              input: "$jobApplications",
              as: "application",
              cond: { $eq: ["$$application.seekerStatus", "applied"] },
            },
          },
        },
        totalCompletedJobs: {
          $size: {
            $filter: {
              input: "$jobApplications",
              as: "application",
              cond: { $eq: ["$$application.posterStatus", "completed"] },
            },
          },
        },
      },
    },

    {
      $lookup: {
        from: "paymentrecords",
        localField: "_id",
        foreignField: "paidTo",
        as: "payments",
      },
    },

    {
      $addFields: {
        totalEarnings: {
          $sum: "$payments.amount",
        },
      },
    },

    // All reviews for rating/count
    {
      $lookup: {
        from: "reviews",
        localField: "_id",
        foreignField: "seekerId",
        as: "reviews",
      },
    },

    // Latest review only
    {
      $lookup: {
        from: "reviews",
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ["$seekerId", "$$userId"],
              },
            },
          },
          {
            $sort: {
              createdAt: -1,
            },
          },
          {
            $limit: 1,
          },
          ...reviewHelperPipeline(), // Add user details for latest review
        ],
        as: "latestReview",
      },
    },

    {
      $addFields: {
        avgRating: {
          $cond: {
            if: { $gt: [{ $size: "$reviews" }, 0] },
            then: { $avg: "$reviews.rating" },
            else: 0,
          },
        },
        totalReviews: {
          $size: "$reviews",
        },
        latestReview: {
          $ifNull: [{ $arrayElemAt: ["$latestReview", 0] }, null],
        },
      },
    },

    {
      $project: {
        _id: 1,
        totalAppliedJobs: 1,
        totalCompletedJobs: 1,
        totalEarnings: 1,
        avgRating: 1,
        latestReview: 1,
        totalReviews: 1,
      },
    },
  ];
};

const reviewHelperPipeline = () => {
  return [
    {
      $lookup: {
        from: "users",
        let: { reviewPosterId: "$posterId" }, // change if needed: "$reviewPosterId" / "$posterId"
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$_id", "$$reviewPosterId"] },
            },
          },
          {
            $project: {
              _id: 1,
              name: 1,
              email: 1,
              profileIcon: s3UrlExpr("$profileIcon"), // Add S3 URL for profile icon
            },
          },
        ],
        as: "user",
      },
    },
    {
      $lookup: {
        from: "jobs",
        let: { jobId: "$jobId" }, // change if needed: "$reviewPosterId" / "$posterId"
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$_id", "$$jobId"] },
            },
          },
          {
            $project: {
              _id: 1,
              title: 1,
              description: 1,
            },
          },
        ],
        as: "job",
      },
    },
    {
      $addFields: {
        user: { $arrayElemAt: ["$user", 0] },
        job: { $arrayElemAt: ["$job", 0] },
      },
    },
  ];
};

const reviewStatsPipeline = (filter) => [
  {
    // Only moderated reviews contribute to customer/provider-facing ratings.
    $match: { ...filter, status: "approved" },
  },
  {
    // rating accepts decimals (e.g. 4.5) — bucket by nearest whole star
    // (round-half-up) so every review still lands in exactly one of the
    // 1-5 buckets instead of falling through an exact-integer match.
    $addFields: {
      roundedRating: { $floor: { $add: ["$rating", 0.5] } },
    },
  },
  {
    $group: {
      _id: null,
      avgRating: { $avg: "$rating" },
      totalReviews: { $sum: 1 },
      one: {
        $sum: { $cond: [{ $eq: ["$roundedRating", 1] }, 1, 0] },
      },
      two: {
        $sum: { $cond: [{ $eq: ["$roundedRating", 2] }, 1, 0] },
      },
      three: {
        $sum: { $cond: [{ $eq: ["$roundedRating", 3] }, 1, 0] },
      },
      four: {
        $sum: { $cond: [{ $eq: ["$roundedRating", 4] }, 1, 0] },
      },
      five: {
        $sum: { $cond: [{ $eq: ["$roundedRating", 5] }, 1, 0] },
      },
    },
  },
  {
    $project: {
      _id: 0,
      avgRating: { $ifNull: ["$avgRating", 0] },
      totalReviews: 1,
      ratingCount: {
        1: "$one",
        2: "$two",
        3: "$three",
        4: "$four",
        5: "$five",
      },
    },
  },
];

const usersPipeline = ({ keyword }) => {
  const pipeline = [];
  if (keyword) {
    pipeline.push({
      $match: {
        $or: [{ name: { $regex: keyword, $options: "i" } }, { email: { $regex: keyword, $options: "i" } }],
      },
    });
  }
  pipeline.push({
    $project: {
      _id: 1,
      name: 1,
      email: 1,
      phoneNumber: 1,
      bio: 1,
      profileIcon: s3UrlExpr("$profileIcon"),
      accountState: 1,
      createdAt: 1,
    },
  });

  return pipeline;
};
const countStatusPipeline = ({ statusFields }) => {
  const facet = {};

  statusFields.forEach((field) => {
    const facetKey = field.replace(/\./g, "_");

    facet[facetKey] = [
      {
        $group: {
          _id: `$${field}`, // ✅ reads accountState.status from user document
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          status: "$_id",
          count: 1,
        },
      },
    ];
  });

  return [
    {
      $facet: facet,
    },
  ];
};

const normStatusCounts = (countRes = {}, list) => {
  return Object.fromEntries(
    Object.entries(countRes).map(([field, counts = []]) => {
      const normalizedCounts = (list || counts).reduce((acc, item) => {
        if (typeof item === "string") {
          const found = counts.find((x) => x.status === item);

          acc[item] = found?.count || 0;
        } else if (item?.status) {
          acc[item.status] = item.count || 0;
        }

        return acc;
      }, {});

      return [field, normalizedCounts];
    }),
  );
};
const statusCounts = (statuses = [], matchTo = "status", filter = {}) => {
  const group = {
    _id: null,
    total: { $sum: 1 },
  };

  statuses.forEach((status) => {
    group[status] = {
      $sum: {
        $cond: [{ $eq: [`$${matchTo}`, status] }, 1, 0],
      },
    };
  });

  return [
    {
      $match: filter,
    },
    {
      $group: group,
    },
    {
      $project: {
        _id: 0,
      },
    },
  ];
};

const graphPipeline = ({ filter = {} }) => {
  return [
    // Match jobs based on the provided filter
    {
      $match: filter,
    },

    // Project year, month, and status
    {
      $project: {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        status: 1, // Include status for grouping
      },
    },

    // Group by year, month, and status, and count the jobs
    {
      $group: {
        _id: { year: "$year", month: "$month", status: "$status" },
        count: { $sum: 1 },
      },
    },

    // Group by year and month to consolidate status counts into individual fields
    {
      $group: {
        _id: { year: "$_id.year", month: "$_id.month" },
        open: {
          $sum: {
            $cond: [{ $eq: ["$_id.status", JobStatus.OPEN] }, "$count", 0],
          },
        },
        assigned: {
          $sum: {
            $cond: [{ $eq: ["$_id.status", JobStatus.ASSIGNED] }, "$count", 0],
          },
        },
        canceled: {
          $sum: {
            $cond: [{ $eq: ["$_id.status", JobStatus.CANCELED] }, "$count", 0],
          },
        },
        completed: {
          $sum: {
            $cond: [{ $eq: ["$_id.status", JobStatus.COMPLETED] }, "$count", 0],
          },
        },
      },
    },

    // Sort by year and month
    {
      $sort: { "_id.year": 1, "_id.month": 1 },
    },
  ];
};
const reviewRatingPipeline = ({ filter = {}, matchTo = "business", targetId = "_id" } = {}) => {
  return [
    {
      $lookup: {
        from: "reviews",
        let: { targetId: `$${targetId}` },
        pipeline: [
          {
            $match: {
              ...filter,
              status: "approved",
              $expr: {
                $eq: [`$${matchTo}`, "$$targetId"],
              },
            },
          },
          {
            $group: {
              _id: null,
              avgRating: { $avg: "$rating" },
              totalReviews: { $sum: 1 },
            },
          },
        ],
        as: "reviewStats",
      },
    },
    {
      $addFields: {
        avgRating: {
          $ifNull: [{ $round: [{ $first: "$reviewStats.avgRating" }, 1] }, 0],
        },
        totalReviews: {
          $ifNull: [{ $first: "$reviewStats.totalReviews" }, 0],
        },
      },
    },
    {
      $project: {
        reviewStats: 0,
      },
    },
  ];
};

// Customer-facing visibility guard: keep only items whose business can actually
// be paid — BusinessProfile "active" AND the owner's Stripe onboarding complete.
// Never apply to a business's own listings, or they couldn't see (and fix) their
// items while onboarding is incomplete.
/**
 * canBook — whether the viewer could actually create a booking for this
 * service/package right now, as a boolean field instead of a filter. Mirrors
 * the gates createBooking enforces server-side:
 *
 *  - the entity is active and available,
 *  - the owning business is active and payable — Stripe onboarding finished,
 *    charges/payouts enabled (same conditions as bookableBusinessPipeline),
 *  - the viewer isn't the business that owns it. resolveEntity refuses
 *    self-booking, which is what a dual-role account hits after switching to
 *    its customer side and opening its own listing.
 *
 * viewerBusinessId is the viewer's BusinessProfile _id (req.user.businessId),
 * absent for customers, guests and admins — in which case the ownership leg
 * is simply true.
 */
const canBookPipeline = ({ viewerBusinessId = null, businessField = "business" } = {}) => [
  {
    $lookup: {
      from: "businessprofiles",
      localField: businessField,
      foreignField: "_id",
      pipeline: [
        { $match: { status: "active" } },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            pipeline: [
              {
                $match: {
                  "stripe.onboardingComplete": true,
                  "stripe.chargesEnabled": true,
                  "stripe.payoutsEnabled": true,
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "owner",
          },
        },
        { $match: { owner: { $ne: [] } } },
        { $project: { _id: 1 } },
      ],
      as: "payableBusiness",
    },
  },
  {
    $addFields: {
      canBook: {
        $and: [
          { $gt: [{ $size: "$payableBusiness" }, 0] },
          { $eq: ["$status", "active"] },
          { $ne: ["$isAvailable", false] },
          viewerBusinessId ? { $ne: [{ $toString: `$${businessField}` }, String(viewerBusinessId)] } : true,
        ],
      },
    },
  },
  { $unset: "payableBusiness" },
];

const bookableBusinessPipeline = ({ businessField = "business" } = {}) => [
  {
    $lookup: {
      from: "businessprofiles",
      localField: businessField,
      foreignField: "_id",
      pipeline: [
        { $match: { status: "active" } },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            pipeline: [
              {
                $match: {
                  "stripe.onboardingComplete": true,
                  "stripe.chargesEnabled": true,
                  "stripe.payoutsEnabled": true,
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "owner",
          },
        },
        { $match: { owner: { $ne: [] } } },
        { $project: { _id: 1 } },
      ],
      as: "bookableBusiness",
    },
  },
  { $match: { bookableBusiness: { $ne: [] } } },
  { $unset: "bookableBusiness" },
];

// Ascending distance, with anything undistanceable parked at the end.
// distanceKm is absent whenever the business has no stored coordinates, and a
// missing field sorts *ahead* of every real number in MongoDB — so sorting on
// it directly would lead the list with the results that have no location at
// all. The substitute key is temporary and unset once the sort is done.
const NO_DISTANCE_SORT_KEY = Number.MAX_SAFE_INTEGER;
const nearestFirstStages = (distanceField) => [
  { $addFields: { __distanceSort: { $ifNull: [distanceField, NO_DISTANCE_SORT_KEY] } } },
  { $sort: { __distanceSort: 1 } },
  { $unset: "__distanceSort" },
];

const businessHelperPipeline = ({ filter = {}, userLat = null, userLng = null }) => {
  return [
    {
      $match: filter,
    },
    ...reviewRatingPipeline({
      matchTo: "business",
      targetId: "_id",
    }),
    {
      $lookup: {
        from: "users",
        let: { userId: "$user" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
          {
            $project: {
              _id: 1,
              name: 1,
              email: 1,
              profileIcon: s3UrlExpr("$profileIcon"),
            },
          },
        ],
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "services",
        let: { businessId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$business", "$$businessId"] }, status: "active" } },
          { $project: { _id: 0, price: 1 } },
        ],
        as: "activeServices",
      },
    },
    {
      $lookup: {
        from: "packages",
        let: { businessId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$business", "$$businessId"] }, status: "active" } },
          { $project: { _id: 0, price: 1 } },
        ],
        as: "activePackages",
      },
    },
    {
      $lookup: {
        from: "bookings",
        let: { businessId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$business", "$$businessId"] }, status: "completed" } },
          { $count: "count" },
        ],
        as: "bookingsStats",
      },
    },
    {
      $addFields: {
        bookingsCount: { $ifNull: [{ $first: "$bookingsStats.count" }, 0] },
      },
    },
    {
      $addFields: {
        allPrices: {
          $concatArrays: [
            { $map: { input: "$activeServices", as: "s", in: "$$s.price" } },
            { $map: { input: "$activePackages", as: "p", in: "$$p.price" } },
          ],
        },
      },
    },
    {
      $addFields: {
        priceRange: {
          $cond: [
            { $gt: [{ $size: "$allPrices" }, 0] },
            { min: { $min: "$allPrices" }, max: { $max: "$allPrices" } },
            { min: 0, max: 0 },
          ],
        },
        rating: { avgRating: "$avgRating", totalReviews: "$totalReviews" },
      },
    },
    {
      $lookup: {
        from: "badges",
        localField: "certifications.badgeId",
        foreignField: "_id",
        as: "__certBadge",
      },
    },
    {
      $addFields: {
        certificationOptionName: {
          $let: {
            vars: {
              option: {
                $first: {
                  $filter: {
                    input: { $ifNull: [{ $first: "$__certBadge.options" }, []] },
                    as: "opt",
                    cond: { $eq: ["$$opt._id", "$certifications.optionId"] },
                  },
                },
              },
            },
            in: "$$option.name",
          },
        },
      },
    },
    {
      $project: {
        _id: 1,
        user: 1,
        businessName: 1,
        nameSlug: 1,
        businessType: 1,
        teamSize: 1,
        yearsOfExperience: 1,
        description: 1,
        image: s3UrlExpr("$image"),
        coverImage: s3UrlExpr("$coverImage"),
        // One combined array of { _id, name }
        categories: 1,
        tags: 1,
        rating: 1,
        bookingsCount: 1,
        skills: 1,
        priceRange: 1,
        location: 1,
        isAvailable: 1,
        // The profile's own status. Non-admin callers only ever see active
        // businesses (getBusinesses forces the filter), so this is constant for
        // them; the admin list needs it for its Status column.
        status: 1,
        updatedAt: 1,
        certifications: {
          name: "$certifications.name",
          status: "$certifications.status",
          badgeId: "$certifications.badgeId",
          optionId: "$certifications.optionId",
          optionName: "$certificationOptionName",
          files: {
            $map: {
              input: "$certifications.files",
              as: "file",
              in: s3UrlExpr("$$file"),
            },
          },
        },
      },
    },
    // Distance from the caller — after the $project, which is what puts
    // `location` on the doc. Same haversine the service/package pipelines use,
    // so a business card reads the same distanceKm whichever list it came
    // from; no lat/lng in the query means no key at all, as elsewhere.
    ...(userLat != null && userLng != null
      ? [
          {
            $addFields: {
              distanceKm: haversineKmExpr(
                { $arrayElemAt: ["$location.coordinates", 1] },
                { $arrayElemAt: ["$location.coordinates", 0] },
                Number(userLat),
                Number(userLng),
              ),
            },
          },
        ]
      : []),
  ];
};
module.exports = {
  s3UrlExpr,
  paginationPipeline,
  sort,
  finalRes,
  categoryPipeline,
  userStatsPipeline,
  reviewHelperPipeline,
  reviewStatsPipeline,
  countStatusPipeline,
  usersPipeline,
  normStatusCounts,
  statusCounts,
  graphPipeline,
  servicePipeline,
  packagePipeline,
  promotionPipeline,
  promotionTargetsPipeline,
  bookableBusinessPipeline,
  canBookPipeline,
  businessHelperPipeline,
  badgeOptionRefPipeline,
  nearestFirstStages,
  haversineKmExpr,
};
