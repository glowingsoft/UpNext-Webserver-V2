const Portfolio = require("@models/Portfolios");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const ServiceCategory = require("@models/ServiceCategory");
const { getFullImageUrl } = require("@utils/imageHelper");
const { cleanfiles } = require("@utils/responseUtil");
const { expandPortfolioSearchQuery } = require("./expandPortfolioSearch");
const { tagPortfolioImage } = require("./tagPortfolioMedia");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NO_TERMS = { technique: [], style: [], color: [], keywords: [] };

// `imageUrl` (an upload key/URL from our own bucket — cleanfiles keeps only the
// key, so nothing arbitrary is ever fetched) is described by the vision model
// and its tags join the text terms, so one search covers both inputs.
async function resolveNaturalSearch(query, { imageUrl } = {}) {
  const queryText = String(query || "")
    .trim()
    .slice(0, 100);
  const [expanded, imageTags] = await Promise.all([
    queryText ? expandPortfolioSearchQuery(queryText) : NO_TERMS,
    imageUrl ? tagPortfolioImage(getFullImageUrl(cleanfiles(imageUrl))) : NO_TERMS,
  ]);
  const terms = [
    ...new Set(
      [
        ...expanded.technique,
        ...expanded.style,
        ...expanded.color,
        ...expanded.keywords,
        ...imageTags.technique,
        ...imageTags.style,
        ...imageTags.color,
        queryText,
      ].filter(Boolean),
    ),
  ];
  const regexes = terms.map((term) => new RegExp(escapeRegex(term), "i"));
  const portfolioFilter = {
    $or: [
      { name: { $in: regexes } },
      { description: { $in: regexes } },
      { businessName: { $in: regexes } },
      { search_keywords: { $in: regexes } },
      { "media.ai_tags.description": { $in: regexes } },
      { "media.ai_tags.technique": { $in: regexes } },
      { "media.ai_tags.style": { $in: regexes } },
      { "media.ai_tags.color": { $in: regexes } },
    ],
  };
  const [portfolioBusinessIds, serviceCategoryIds] = await Promise.all([
    Portfolio.distinct("business", portfolioFilter),
    ServiceCategory.distinct("_id", {
      $or: [{ name: { $in: regexes } }, { description: { $in: regexes } }],
    }),
  ]);
  const catalogFilter = {
    status: "active",
    $or: [
      { name: { $in: regexes } },
      { description: { $in: regexes } },
      { search_keywords: { $in: regexes } },
      { category: { $in: serviceCategoryIds } },
      { subcategory: { $in: serviceCategoryIds } },
    ],
  };
  const serviceFilter = catalogFilter;
  const packageFilter = catalogFilter;
  const [serviceBusinessIds, packageBusinessIds] = await Promise.all([
    Services.distinct("business", serviceFilter),
    Packages.distinct("business", packageFilter),
  ]);

  return {
    regexes,
    portfolioFilter,
    serviceFilter,
    packageFilter,
    businessIds: [
      ...new Map(
        [...portfolioBusinessIds, ...serviceBusinessIds, ...packageBusinessIds].map((id) => [String(id), id]),
      ).values(),
    ],
  };
}

module.exports = { resolveNaturalSearch };
