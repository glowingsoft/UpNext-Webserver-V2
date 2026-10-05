const Portfolio = require("@models/Portfolios");
const { sendResponse, validateParams, cleanfiles } = require("@utils/responseUtil");
const { default: mongoose } = require("mongoose");
const { paginationPipeline, finalRes, s3UrlExpr } = require("@utils/aggregationHelper");
const { getMediaType, getFullImageUrl } = require("@utils/imageHelper");
const { attachThumbnails } = require("@utils/thumbnailHelper");
const { tagPortfolioImage } = require("@services/ai/features/tagPortfolioMedia");
const { resolveNaturalSearch } = require("@services/ai/features/naturalSearch");

// `media` is stored as { file, thumbnail } keys; every response exposes each
// entry as { url, media_type, thumbnail } so the client knows whether to render
// a player or an image without sniffing extensions itself, and can paint a grid
// without pulling the full-size asset. The aggregation path resolves its URLs in
// the pipeline while the save paths hand over raw keys — getFullImageUrl passes
// the former through untouched and prefixes the latter.
const formatMedia = (media = []) =>
  media.map((item) => {
    const url = getFullImageUrl(typeof item === "string" ? item : item?.url || item?.file);
    return {
      url,
      media_type: getMediaType(url),
      thumbnail: getFullImageUrl(item?.thumbnail),
      ai_tags: (typeof item === "object" && item?.ai_tags) || emptyTags(),
    };
  });

// Normalizes whatever a client sends into `{ file, thumbnail }` key pairs.
// Accepted per entry:
//   "abc.jpg"                                  bare key or full URL
//   { file, thumbnail }                        straight from the upload endpoint
//   { file, thumbnailUrl }                     ditto, using its URL field
//   { url, media_type, thumbnail }             an object a previous GET returned
// so a client can post the upload response as-is, or round-trip a portfolio it
// just fetched, without unwrapping anything. `cleanfiles` reduces every form to
// the bare key the bucket stores. An entry with no `thumbnail` gets one
// generated downstream; one that carries it is stored as sent.
const mediaEntries = (media) =>
  (Array.isArray(media) ? media : [media])
    .map((item) => (typeof item === "string" ? { file: item } : item || {}))
    .map((item) => ({ file: item.file || item.url, thumbnail: item.thumbnail || item.thumbnailUrl }))
    .filter((item) => item.file)
    .map((item) => ({
      file: cleanfiles(item.file),
      thumbnail: item.thumbnail ? cleanfiles(item.thumbnail) : null,
    }));

const emptyTags = () => ({ description: "", technique: [], style: [], color: [] });

// Vision-tags every portfolio media entry. The stored S3 keys can be
// extensionless, so extension-based media detection would incorrectly skip
// uploaded images before tagPortfolioImage gets a chance to inspect them.
// Runs after thumbnails so it can hand the AI a public URL; failures degrade
// to empty tags per tagPortfolioImage's own contract and never fail the save.
const tagMedia = async (media) => {
  const tagged = await Promise.all(
    media.map(async (item) => {
      const url = getFullImageUrl(item.file);
      const { description, technique, style, color } = await tagPortfolioImage(url);
      return { ...item, ai_tags: { description, technique, style, color } };
    }),
  );
  return tagged;
};

const buildSearchKeywords = ({ media, name, description, businessName }) => {
  const mediaTagValues = media.flatMap((item) => {
    const tags = item.ai_tags || emptyTags();
    return [tags.description, ...tags.technique, ...tags.style, ...tags.color];
  });
  const keywordSources = [name, description, businessName, ...mediaTagValues].filter(Boolean);
  return [
    ...new Set(
      keywordSources.flatMap((text) =>
        String(text)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 1),
      ),
    ),
  ];
};

// ─── Create Portfolio ───────────────────────────────────────────────
const createPortfolio = async (req, res) => {
  const { businessId } = req.user;
  const { name, description, media, businessName } = req.body;

  const validationOptions = {
    formFields: ["name"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    // Only the existence of a match matters — hydrating `media` would cast any
    // unmigrated bare-string entry into a character-indexed object for nothing.
    const isExistingPortfolio = await Portfolio.findOne({ business: businessId, name: name?.trim() }).select("_id");
    if (isExistingPortfolio) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "portfolio_already_exists",
      });
    }

    const thumbnailedMedia = await attachThumbnails(mediaEntries(media || []));
    const taggedMedia = await tagMedia(thumbnailedMedia);
    const trimmedName = name?.trim();
    const trimmedDescription = description?.trim() || "";

    const newPortfolio = new Portfolio({
      business: businessId,
      name: trimmedName,
      description: trimmedDescription,
      media: taggedMedia,
      // businessName: businessName,
      search_keywords: buildSearchKeywords({
        media: taggedMedia,
        name: trimmedName,
        description: trimmedDescription,
        businessName,
      }),
    });

    await newPortfolio.save();

    const portfolioData = newPortfolio.toObject();
    portfolioData.media = formatMedia(portfolioData.media);

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "portfolio_created",
      data: portfolioData,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_creation_error",
      error,
    });
  }
};

// ─── Get Portfolio by ID ────────────────────────────────────────────
const getPortfolio = async (req, res) => {
  const { portfolioId } = req.params;

  const validationOptions = {
    pathParams: ["portfolioId"],
    objectIdFields: ["portfolioId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    const { data } = await getPortfolios({ filter: { _id: new mongoose.Types.ObjectId(portfolioId) } });

    if (!data || data.length === 0) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "portfolio_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "portfolio_fetched",
      data: data[0],
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_fetch_error",
      error,
    });
  }
};

const getPortfolios = async ({ filter = {}, req = {} }) => {
  const { keyword, page, limit, business } = req?.query || {};

  // business filter from query or user scope
  if (business) {
    filter.business = new mongoose.Types.ObjectId(business);
  }

  if (req.user?.userType === "business") {
    filter.business = new mongoose.Types.ObjectId(req.user.businessId);
  }

  // keyword search (name + businessName)
  if (keyword) {
    filter.$or = [
      { name: { $regex: keyword, $options: "i" } },
      { businessName: { $regex: keyword, $options: "i" } },
      { search_keywords: { $regex: keyword, $options: "i" } },
    ];
  }

  const pipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    {
      $addFields: {
        media: {
          $map: {
            input: { $ifNull: ["$media", []] },
            as: "item",
            in: {
              // Rows written before thumbnails existed hold a bare key string
              // rather than a { file, thumbnail } object — those simply come
              // back with a null thumbnail until the migration backfills them.
              $let: {
                vars: { isObject: { $eq: [{ $type: "$$item" }, "object"] } },
                in: {
                  url: s3UrlExpr({ $cond: ["$$isObject", "$$item.file", "$$item"] }),
                  thumbnail: s3UrlExpr({ $cond: ["$$isObject", "$$item.thumbnail", null] }),
                  ai_tags: { $cond: ["$$isObject", "$$item.ai_tags", null] },
                },
              },
            },
          },
        },
      },
    },
  ];

  if (page && limit) {
    pipeline.push(paginationPipeline({ page, limit }));
  }

  const result = await Portfolio.aggregate(pipeline);

  const { data, meta } =
    finalRes({
      page,
      limit,
      data: result,
    }) || {};

  return {
    data: (data || []).map((portfolio) => ({ ...portfolio, media: formatMedia(portfolio.media) })),
    meta,
  };
};

// ─── Get All Portfolios for Business ────────────────────────────────
const getAllPortfolios = async (req, res) => {
  try {
    const { data, meta } = await getPortfolios({ req });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "portfolios_fetched",
      data,
      meta,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_fetch_error",
      error,
    });
  }
};

// ─── Update Portfolio ───────────────────────────────────────────────
const updatePortfolio = async (req, res) => {
  const { businessId } = req.user;
  const { portfolioId } = req.params;
  const { name, description, media, businessName } = req.body;

  const validationOptions = {
    pathParams: ["portfolioId"],
    objectIdFields: ["portfolioId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    // Only the ownership field is hydrated: a row still holding the pre-thumbnail
    // `media: [String]` shape would fail to cast into the sub-schema, and a
    // rename has no business depending on the media migration having run.
    const portfolio = await Portfolio.findById(portfolioId).select("business");

    if (!portfolio) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "portfolio_not_found",
      });
    }

    if (portfolio.business.toString() !== businessId.toString()) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "unauthorized_access",
      });
    }

    const updates = {};
    if (name) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    if (businessName !== undefined) updates.businessName = businessName;

    if (media) {
      const thumbnailedMedia = await attachThumbnails(mediaEntries(media));
      updates.media = await tagMedia(thumbnailedMedia);
    }

    if (updates.media || updates.name || updates.description !== undefined || updates.businessName !== undefined) {
      const current = await Portfolio.findById(portfolioId).select("name description businessName media").lean();
      updates.search_keywords = buildSearchKeywords({
        media: updates.media || current?.media || [],
        name: updates.name ?? current?.name,
        description: updates.description ?? current?.description,
        businessName: updates.businessName ?? current?.businessName,
      });
    }

    const updated = await Portfolio.findByIdAndUpdate(
      portfolioId,
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    const portfolioData = { ...updated, media: formatMedia(updated.media) };

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "portfolio_updated",
      data: portfolioData,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_update_error",
      error,
    });
  }
};

// ─── Delete Portfolio ───────────────────────────────────────────────
const deletePortfolio = async (req, res) => {
  const { businessId } = req.user;
  const { portfolioId } = req.params;

  const validationOptions = {
    pathParams: ["portfolioId"],
    objectIdFields: ["portfolioId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    const portfolio = await Portfolio.findById(portfolioId).select("business");

    if (!portfolio) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "portfolio_not_found",
      });
    }

    if (portfolio.business.toString() !== businessId.toString()) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "unauthorized_access",
      });
    }

    await Portfolio.findByIdAndDelete(portfolioId);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "portfolio_deleted",
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_delete_error",
      error,
    });
  }
};

// ─── AI: Natural-Language Portfolio Search ──────────────────────────
// A client types free text ("soft glam highlights", "short coffin nails with
// chrome") — the AI expands it into the same technique/style/color
// vocabulary photos are tagged with, then it is matched against the nested
// per-media tags rather than a duplicated portfolio-level rollup.
const buildNaturalLanguagePortfolioFilter = async (query) => {
  const { portfolioFilter } = await resolveNaturalSearch(query);
  return portfolioFilter;
};

const searchPortfolios = async (req, res) => {
  const { query, page, limit } = req.query;

  const validationOptions = {
    queryParams: ["query"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    const filter = await buildNaturalLanguagePortfolioFilter(query);

    const { data, meta } = await getPortfolios({ filter, req: { query: { page, limit } } });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "portfolios_fetched",
      data,
      meta,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "portfolio_fetch_error",
      error,
    });
  }
};

module.exports = {
  createPortfolio,
  getPortfolio,
  getAllPortfolios,
  searchPortfolios,
  getPortfolios,
  updatePortfolio,
  deletePortfolio,
};
