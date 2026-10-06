const Portfolio = require("@models/Portfolios");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const ServiceCategory = require("@models/ServiceCategory");
const { expandPortfolioSearchQuery } = require("./expandPortfolioSearch");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NO_TERMS = { technique: [], style: [], color: [], keywords: [] };

// `extraTerms` are pre-resolved search terms from another source (e.g. the
// image-search tags) that join the text terms; this module knows nothing about
// where they came from.
async function resolveNaturalSearch(query, { extraTerms = [] } = {}) {
  const queryText = String(query || "")
    .trim()
    .slice(0, 100);
  const expanded = queryText ? await expandPortfolioSearchQuery(queryText) : NO_TERMS;
  const terms = [
    ...new Set(
      [
        ...expanded.technique,
        ...expanded.style,
        ...expanded.color,
        ...expanded.keywords,
        ...extraTerms,
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
