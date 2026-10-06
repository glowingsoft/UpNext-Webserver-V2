const { resolveNaturalSearch } = require("@services/ai/features/naturalSearch");
const { getBusinesses } = require("../../controllers/userController");
const { getServices } = require("../../controllers/serviceController");
const { getPackages } = require("../../controllers/packageController");
const { getPortfolios } = require("../../controllers/portfolioController");
const { analyzeImage } = require("./imageAnalysis");

// getServices/getPackages overwrite `filter.$or` for a categoryId filter, so the
// tag match is nested under $and to survive it.
const scoped = ({ status, $or }) => ({ status, $and: [{ $or }] });

const EMPTY = { data: { businesses: [], services: [], packages: [], portfolios: [] }, meta: {} };

// Describe the image, turn its tags (plus an optional keyword) into the shared
// match filters, then fan out to each entity's list function so visibility
// rules, lat/lng, categoryId, sortBy and pagination behave as on the plain
// list endpoints. `source` is a bucket URL or a data URL from imageInput.
async function searchByImage({ source, keyword = "", req }) {
  const imageAnalysis = await analyzeImage(source);
  const naturalSearch = await resolveNaturalSearch(keyword, { extraTerms: imageAnalysis.terms });

  // Nothing identifiable in the image and no keyword: skip the database.
  if (!naturalSearch.regexes.length) return { ...EMPTY, imageAnalysis };

  const entityReq = {
    user: req.user,
    language: req.language,
    query: { ...naturalSearch.availability, ...req.query, keyword: undefined },
  };

  const [businesses, services, packages, portfolios] = await Promise.all([
    getBusinesses({ req: entityReq, filter: {}, naturalSearch }),
    getServices({ filter: scoped(naturalSearch.serviceFilter), req: entityReq }),
    getPackages({ filter: scoped(naturalSearch.packageFilter), req: entityReq }),
    getPortfolios({ filter: { ...naturalSearch.portfolioFilter }, req: entityReq }),
  ]);

  return {
    data: {
      businesses: businesses.data || [],
      services: services.data || [],
      packages: packages.data || [],
      portfolios: portfolios.data || [],
    },
    meta: {
      businesses: businesses.meta,
      services: services.meta,
      packages: packages.meta,
      portfolios: portfolios.meta,
    },
    imageAnalysis,
  };
}

module.exports = { searchByImage };
