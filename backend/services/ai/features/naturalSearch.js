const Portfolio = require("@models/Portfolios");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const ServiceCategory = require("@models/ServiceCategory");
const { expandPortfolioSearchQuery } = require("./expandPortfolioSearch");
const { extractAvailability } = require("@utils/availabilityHelper");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NO_TERMS = { technique: [], style: [], color: [], keywords: [] };

// `extraTerms` are pre-resolved search terms from another source (e.g. the
// image-search tags) that join the text terms; this module knows nothing about
// where they came from.
//
// Day/time phrases in the query ("open Monday", "this weekend", "at 2pm") are
// pulled out first: they come back as `availability` — request-param shaped, to
// be spread under the caller's query so the list functions filter on it — and
// never reach the text match. A query that was only such a phrase has no text
// left (`hasText: false`): the filters then match every active entity and
// `businessIds` is empty, so callers must skip the text clause for businesses.
async function resolveNaturalSearch(query, { extraTerms = [] } = {}) {
  const { text, availability } = extractAvailability(query);
  const queryText = text.trim().slice(0, 100);
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
  if (!regexes.length) {
    return {
      regexes,
      hasText: false,
      availability,
      portfolioFilter: {},
      serviceFilter: { status: "active" },
      packageFilter: { status: "active" },
      businessIds: [],
    };
  }

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
    hasText: true,
    availability,
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
