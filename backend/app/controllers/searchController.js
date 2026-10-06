const { sendResponse } = require("@utils/responseUtil");
const { safeKeyword } = require("@helperUtils/regexUtil");
const { resolveNaturalSearch } = require("@services/ai/features/naturalSearch");
const bookingService = require("../services/bookingService");
const { getBusinesses } = require("./userController");
const { getServices } = require("./serviceController");
const { getPackages } = require("./packageController");
const { getPortfolios } = require("./portfolioController");

const TYPES = ["businesses", "services", "packages", "portfolios", "bookings"];

// getServices/getPackages overwrite `filter.$or` for a categoryId filter, so the
// text match is nested under $and to survive it.
const scoped = ({ status, $or }) => ({ status, $and: [{ $or }] });

// GET /search?query=&imageUrl=&types=services,packages&page=&limit=
// One text and/or image query fanned out to each entity's existing list
// function, so visibility rules, filters (lat/lng, categoryId, sortBy, status…)
// and pagination behave exactly as on the individual endpoints. Results stay
// in per-entity buckets: their relevance isn't comparable across entities.
const search = async (req, res) => {
  const query = String(req.query.query || "").trim();
  const { imageUrl, page, limit, status, scope, date } = req.query;

  if (!query && !imageUrl) {
    return sendResponse({ res, statusCode: 400, translationKey: "missing_query_parameters" });
  }

  try {
    const requested = String(req.query.types || "")
      .split(",")
      .filter((type) => TYPES.includes(type));
    const types = new Set(requested.length ? requested : TYPES);
    const { userType } = req.user;

    const naturalSearch = await resolveNaturalSearch(query, { imageUrl });
    const entityReq = {
      user: req.user,
      language: req.language,
      query: { ...req.query, keyword: undefined },
    };

    const jobs = {
      businesses: () => getBusinesses({ req: entityReq, filter: {}, naturalSearch }),
      services: () => getServices({ filter: scoped(naturalSearch.serviceFilter), req: entityReq }),
      packages: () => getPackages({ filter: scoped(naturalSearch.packageFilter), req: entityReq }),
      portfolios: () => getPortfolios({ filter: { ...naturalSearch.portfolioFilter }, req: entityReq }),
    };
    // Bookings are private and match on id / item name only, so they need a
    // text query and a signed-in customer or business.
    const bookingBase = { page, limit, status, scope, date, keyword: safeKeyword(query), locale: req.language };
    if (query && userType === "user") {
      jobs.bookings = () => bookingService.getUserBookings({ ...bookingBase, userId: req.user._id });
    } else if (query && userType === "business") {
      jobs.bookings = () => bookingService.getBusinessBookings({ ...bookingBase, businessId: req.user.businessId });
    }

    const names = Object.keys(jobs).filter((name) => types.has(name));
    const results = await Promise.all(names.map((name) => jobs[name]()));

    const data = {};
    const meta = {};
    names.forEach((name, i) => {
      data[name] = results[i].data || [];
      meta[name] = results[i].meta;
    });

    return sendResponse({ res, statusCode: 200, translationKey: "data_fetched_successfully", data, meta });
  } catch (error) {
    console.error(error);
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = { search };
