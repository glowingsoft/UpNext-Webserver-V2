const moment = require("moment-timezone");
const { sendResponse, getStartAndEndOfWeek } = require("@utils/responseUtil");
const { fetchEvents } = require("@utils/events");
const { getCategories } = require("@controllersCommonModules/categoryController");
const { getServices } = require("./serviceController");
const { getUserBookings, getBusinessBookings, countBookingStatuses } = require("../services/bookingService");
const { getBusinesses } = require("./userController");
const Bookings = require("@models/Bookings");
const { User } = require("@models/UserModel");
const BusinessProfile = require("@models/BusinessProfile");
const Review = require("@models/Review");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { reviewStatsPipeline } = require("@utils/aggregationHelper");
const { getFullImageUrl } = require("@utils/imageHelper");
const { checkOnboardingStatus, getConnectBalance } = require("@services/stripeAccount");
const { getOutstandingDebt } = require("../services/paymentService");
const { resolveBadgeOptionName } = require("@utils/badgeUtil");
const { getPortfolios } = require("./portfolioController");
const { resolveNaturalSearch } = require("@services/ai/features/naturalSearch");

const { default: mongoose } = require("mongoose");

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const toMinor = (amount) => Math.round((amount || 0) * 100);

// Period-over-period change, in whole percent. A previous period of zero has no
// meaningful ratio, so any growth off it reads as +100% and flat-zero as 0%.
const growthPercentage = (current, previous) => {
  if (previous > 0) return Math.round(((current - previous) / previous) * 100);
  return current > 0 ? 100 : 0;
};

const getEvents = async (req, res) => {
  try {
    const { data, meta } = await fetchEvents(req.query);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data,
      meta,
      error: null,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: error.response?.status || 500,
      translationKey: "internal_server",
      error: error.response?.data || error.message,
    });
  }
};

const getHome = async (req, res) => {
  try {
    const user = req.user;
    const isBusiness = user?.userType === "business";
    const homeData = isBusiness ? await getBusinessHome({ req }) : await getCustomerHome({ req });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: homeData,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error?.message || "internal_server",
      error: error,
    });
  }
};
const getReq = (req, extraQuery = {}) => ({ ...req, query: { ...req.query, limit: 5, page: 1, ...extraQuery } });

// Home renders the distance inside the location object it was measured from,
// as one { type, coordinates, address, distanceKm } blob, rather than as a
// sibling of it. Reshaped here and nowhere else on purpose: the list endpoints
// these two widgets reuse keep distanceKm where their own clients read it.
const nestDistanceInLocation = (business) => {
  if (!business?.location) return business;
  const { distanceKm, ...rest } = business;
  return distanceKm == null ? business : { ...rest, location: { ...business.location, distanceKm } };
};

// Filter options for the app's booking/service tabs
const serviceTypeList = ["all", "onsite"];
const statusList = ["all", "scheduled", "requested", "ongoing", "expired", "canceled", "completed"];
const getCustomerHome = async ({ req }) => {
  try {
    const user = req.user;
    const userObjId = new mongoose.Types.ObjectId(String(user._id));

    const nearestFirst =
      req.query?.lat != null && req.query?.lng != null ? { sortBy: req.query.sortBy || "distance_near_far" } : {};
    const keyword = req.query.keyword?.trim();
    const naturalSearch = keyword ? await resolveNaturalSearch(keyword) : null;
    // Day/time phrases in the keyword ("open Monday") apply as availability filters.
    const searchReq = naturalSearch?.availability
      ? { ...req, query: { ...naturalSearch.availability, ...req.query } }
      : req;

    // 1. First fetch only 5 businesses
    const businessReq = getBusinesses({
      req: getReq(searchReq, {
        ...nearestFirst,
        limit: 5,
        page: 1,
        keyword: undefined,
      }),
      naturalSearch,
    });

    const businessData = await businessReq;

    const businesses = businessData?.data || [];

    // 2. Extract business IDs
    const businessIds = businesses
      .map((business) => business?._id)
      .filter(Boolean)
      .map((id) => new mongoose.Types.ObjectId(String(id)));

    // 3. Extract category IDs from those businesses
    const categoryIds = [
      ...new Set(
        businesses.flatMap(
          (business) => business?.categories?.map((category) => String(category?._id)).filter(Boolean) || [],
        ),
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    // 4. Fetch categories belonging to those businesses
    const categoryReq = getCategories({
      req: getReq(req),
      filter: {
        _id: {
          $in: categoryIds,
        },
      },
    });

    // 5. Fetch services belonging to those businesses
    const servicesReq = getServices({
      req: getReq(searchReq, {
        ...nearestFirst,
        keyword: undefined,
      }),
      filter: {
        ...(naturalSearch?.hasText
          ? {
              $or: [
                { business: { $in: naturalSearch.businessIds } },
                { name: { $in: naturalSearch.regexes } },
                { description: { $in: naturalSearch.regexes } },
              ],
            }
          : { business: { $in: businessIds } }),
      },
    });

    const portfolioReq = naturalSearch?.hasText
      ? getPortfolios({ filter: naturalSearch.portfolioFilter, req: { query: { page: 1, limit: 5 } } })
      : Promise.resolve({ data: [] });

    const bookingReq = getUserBookings({
      userId: user._id,
      page: 1,
      limit: 5,
      filter: {},
      date: req.query.date || null,
      locale: req.language || req.user?.language,
      keyword: req.query.keyword || "",
    });

    const eventsReq = fetchEvents({
      ...req.query,
      limit: 5,
      page: 1,
    }).catch((err) => {
      console.warn("Customer home suggestedEvents unavailable:", err.message);
      return { data: [] };
    });

    const summaryReq = getCustomerSummary({
      userObjId,
      currency: user.currency,
    });

    const bookingStatusReq = countBookingStatuses({
      user: userObjId,
    });

    const bookingsOverTimeReq = getBookingsOverTime({
      matchFilter: { user: userObjId },
      year: req.query.year,
    });

    const debtReq = getOutstandingDebt(userObjId);

    const [
      categories,
      services,
      portfolios,
      bookings,
      events,
      summary,
      bookingStatusCounts,
      bookingsOverTime,
      outstandingDebt,
    ] = await Promise.all([
      categoryReq,
      servicesReq,
      portfolioReq,
      bookingReq,
      eventsReq,
      summaryReq,
      bookingStatusReq,
      bookingsOverTimeReq,
      debtReq,
    ]);

    const bookingStatusItems = Object.entries(bookingStatusCounts).map(([status, count]) => ({
      status,
      count,
    }));

    const formtData = {
      categories: categories?.data || [],

      suggestedBusinesses: (businesses || []).map(nestDistanceInLocation),

      suggestedServices: (services?.data || []).map((service) => ({
        ...service,
        business: nestDistanceInLocation(service.business),
      })),

      suggestedPortfolios: portfolios?.data || [],

      todaysSchedules: bookings?.data || [],

      suggestedEvents: (events?.data || []).slice(0, services?.data?.length || 0),

      summary,
      outstandingDebt,

      bookingStatus: {
        total: bookingStatusItems.reduce((sum, item) => sum + item.count, 0),
        items: bookingStatusItems,
      },

      bookingsOverTime,
      serviceTypeList,
      statusList,
    };

    return formtData;
  } catch (error) {
    throw new Error(error?.message || "Error fetching customer home data");
  }
};

const getBusinessHome = async ({ req }) => {
  try {
    const user = req.user;
    const businessId = user.businessId;
    const businessObjId = new mongoose.Types.ObjectId(String(businessId));
    const timezone = user.timezone || "UTC";
    const currency = user.currency || "usd";

    const businessProfileReq = getBusinesses({ filter: { _id: businessId } });
    const getBookingStatsReq = Bookings.countDocuments({ business: businessId, date: { $gte: new Date() } });
    const statsReq = getBusinessStats(user);
    const bookingReq = getBusinessBookings({
      businessId,
      page: 1,
      limit: 5,
      locale: req.language || req.user?.language,
      keyword: req.query.keyword || "",
    });
    // businessHelperPipeline trims to list-card fields (it also feeds public
    // listings), so owner-only profile fields are fetched separately
    const certificationsReq = BusinessProfile.findById(businessId)
      .select("certifications description socialLinks")
      .lean();
    // Rating breakdown (avg, /5, star distribution) across all of the
    // business's services/packages — same match as reviews?scope=business
    const ratingReq = Review.aggregate(reviewStatsPipeline({ business: businessObjId }));

    const summaryReq = getDashboardSummary({ businessObjId, timezone, currency });
    const revenueGrowthReq = getRevenueGrowth({ businessObjId, currency, year: req.query.year });
    const topCustomersReq = getTopCustomers({ businessObjId, currency });
    const recentReviewsReq = getRecentReviews({ businessObjId });
    const bookingStatusReq = countBookingStatuses({ business: businessObjId });

    const [
      bookings,
      toadyCount,
      stats,
      profile,
      certDoc,
      ratingStats,
      summaryBase,
      revenueGrowth,
      topCustomers,
      recentReviews,
      bookingStatusCounts,
    ] = await Promise.all([
      bookingReq,
      getBookingStatsReq,
      statsReq,
      businessProfileReq,
      certificationsReq,
      ratingReq,
      summaryReq,
      revenueGrowthReq,
      topCustomersReq,
      recentReviewsReq,
      bookingStatusReq,
    ]);

    const stripeStatus = await checkOnboardingStatus(user, user.deviceType);

    // Live Stripe balance beats the booking-derived estimate: `withdrawable`
    // becomes what Stripe will actually pay out, and `pendingBalance` is money
    // captured but still in the payout window. Falls back silently to the
    // estimate if the balance call fails (e.g. onboarding bypass, Stripe down).
    if (stats && stripeStatus?.onboardingComplete && stripeStatus?.accountId) {
      try {
        const balance = await getConnectBalance(stripeStatus.accountId);
        stats.withdrawable = balance.available;
        stats.pendingBalance = balance.pending;
        stats.balanceCurrency = balance.currency;
      } catch (err) {
        console.warn("Business home live balance unavailable:", err.message);
      }
    }

    const certifications = certDoc?.certifications || null;
    if (certifications) {
      if (certifications.files?.length) {
        certifications.files = certifications.files.map((file) => getFullImageUrl(file));
      }
      certifications.optionName = await resolveBadgeOptionName(certifications);
    }

    const rating = ratingStats[0] || { avgRating: 0, totalReviews: 0, ratingCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    // rating supersedes the flat avgRating/totalReviews from businessHelperPipeline, so drop those to avoid duplication
    const { avgRating, totalReviews, ...profileRest } = profile?.data[0] || {};

    const bookingStatusItems = Object.entries(bookingStatusCounts).map(([status, count]) => ({ status, count }));

    const formtData = {
      business: {
        id: businessId,
        name: user.name,
        businessName: profileRest.businessName,
        profileImage: profileRest.image,
        timezone,
        currency,
      },
      summary: {
        ...summaryBase,
        averageRating: { average: rating.avgRating || 0, reviewCount: rating.totalReviews || 0 },
      },
      // Same underlying data as `bookings` below — just exposed under the
      // dashboard-mockup's key name too, per explicit request.
      todaysSchedules: bookings?.data || [],
      revenueGrowth,
      topCustomers,
      recentReviews,
      bookingStatus: {
        total: bookingStatusItems.reduce((sum, item) => sum + item.count, 0),
        items: bookingStatusItems,
      },

      bookings: bookings?.data || [],
      toadyCount: toadyCount || 0,
      stats: stats || { avgRating: 0, grossRevenue: 0, netEarned: 0, withdrawable: 0, performanceChart: [] },
      profile: profile?.data[0]
        ? {
            ...profileRest,
            certifications,
            description: certDoc?.description || "",
            socialLinks: certDoc?.socialLinks || null,
            rating,
          }
        : null,
      stripe: stripeStatus,
      serviceTypeList,
      statusList,
    };
    return formtData;
  } catch (error) {
    throw new Error(error?.message || "Error fetching business home data");
  }
};

// ─── Dashboard summary cards ────────────────────────────────────────────────
// conversionRate (leads) and unansweredMessages/profileViews have no backing
// data source anywhere in the schema yet (no lead/CRM, messaging, or
// profile-view-tracking model exists) — they're returned zeroed out rather
// than omitted, so the response shape stays stable for clients already
// reading these keys.
const getDashboardSummary = async ({ businessObjId, timezone, currency }) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const { start: weekStart, end: weekEnd } = getStartAndEndOfWeek(now, timezone);
  // Comparison windows for the week-over-week / day-over-day deltas. All derived
  // in the business's own timezone so "today" and "this week" mean what the
  // business sees on its wall clock.
  const inTz = () => moment.tz(now, timezone);
  const lastWeekStart = inTz().subtract(1, "week").startOf("week").toDate();
  const lastWeekEnd = inTz().subtract(1, "week").endOf("week").toDate();
  const todayStart = inTz().startOf("day").toDate();
  const todayEnd = inTz().endOf("day").toDate();
  const yesterdayStart = inTz().subtract(1, "day").startOf("day").toDate();
  const yesterdayEnd = inTz().subtract(1, "day").endOf("day").toDate();
  // Same revenue basis as getRevenueGrowth/getBusinessStats: money the customer
  // was actually charged, taken from the booking's own price snapshot.
  const capturedMatch = { paymentStatus: { $in: ["captured", "partially_captured"] } };
  const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };
  const earnedBetween = (start, end) =>
    Bookings.aggregate([
      { $match: { business: businessObjId, ...capturedMatch, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: bookingAmount } } },
    ]);

  const [
    customerAgg,
    totalBookings,
    newBookingsThisMonth,
    completedBookings,
    weekCount,
    weekUpcomingCount,
    pendingRequestsCount,
    pendingRequestsNewThisWeek,
    weekEarningAgg,
    lastWeekEarningAgg,
    todayBookingsCount,
    yesterdayBookingsCount,
  ] = await Promise.all([
    Bookings.aggregate([
      { $match: { business: businessObjId } },
      { $group: { _id: "$user", firstBookingAt: { $min: "$createdAt" } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          newThisMonth: { $sum: { $cond: [{ $gte: ["$firstBookingAt", startOfMonth] }, 1, 0] } },
        },
      },
    ]),
    Bookings.countDocuments({ business: businessObjId }),
    Bookings.countDocuments({ business: businessObjId, createdAt: { $gte: startOfMonth } }),
    Bookings.countDocuments({ business: businessObjId, status: "completed" }),
    (async () => {
      const { start, end } = getStartAndEndOfWeek(now, timezone);
      return Bookings.countDocuments({ business: businessObjId, date: { $gte: start, $lte: end } });
    })(),
    (async () => {
      const { end } = getStartAndEndOfWeek(now, timezone);
      return Bookings.countDocuments({ business: businessObjId, date: { $gte: now, $lte: end } });
    })(),
    Bookings.countDocuments({ business: businessObjId, status: "requested" }),
    Bookings.countDocuments({ business: businessObjId, status: "requested", createdAt: { $gte: weekStart } }),
    // Charged this week — bucketed by when the money came in (createdAt), the
    // same way revenueGrowth/performanceChart bucket it, not by the appointment
    // date `bookingsThisWeek` counts.
    earnedBetween(weekStart, weekEnd),
    earnedBetween(lastWeekStart, lastWeekEnd),
    // Today's / yesterday's bookings go by appointment date, not createdAt —
    // this card answers "what's on the books today", so a booking taken last
    // week for today counts today.
    Bookings.countDocuments({ business: businessObjId, date: { $gte: todayStart, $lte: todayEnd } }),
    Bookings.countDocuments({ business: businessObjId, date: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
  ]);

  const customers = customerAgg[0] || { count: 0, newThisMonth: 0 };
  const weekStartLabel = inTz().startOf("week").format("YYYY-MM-DD");
  const weekEndLabel = inTz().endOf("week").format("YYYY-MM-DD");
  const weekEarningMinor = toMinor(weekEarningAgg[0]?.total);
  const lastWeekEarningMinor = toMinor(lastWeekEarningAgg[0]?.total);

  return {
    customers: { count: customers.count, newThisMonth: customers.newThisMonth, period: "all_time" },
    bookings: { count: totalBookings, newThisMonth: newBookingsThisMonth, period: "current" },
    conversionRate: { percentage: 0, convertedLeads: 0, totalLeads: 0, period: "current_month" },
    unansweredMessages: { count: 0, conversationsCount: 0, period: "current" },
    bookingsThisWeek: {
      count: weekCount,
      upcomingCount: weekUpcomingCount,
      weekStart: weekStartLabel,
      weekEnd: weekEndLabel,
    },
    thisWeeksEarning: {
      amountMinor: weekEarningMinor,
      currency,
      period: "current_week",
      weekStart: weekStartLabel,
      weekEnd: weekEndLabel,
      // vs the whole of last week — signed, so the client renders an up or down
      // arrow off the sign rather than comparing the two totals itself
      previousAmountMinor: lastWeekEarningMinor,
      changeMinor: weekEarningMinor - lastWeekEarningMinor,
      changePercentage: growthPercentage(weekEarningMinor, lastWeekEarningMinor),
      comparisonPeriod: "previous_week",
    },
    todaysBooking: {
      count: todayBookingsCount,
      period: "today",
      date: inTz().format("YYYY-MM-DD"),
      previousCount: yesterdayBookingsCount,
      change: todayBookingsCount - yesterdayBookingsCount,
      changePercentage: growthPercentage(todayBookingsCount, yesterdayBookingsCount),
      comparisonPeriod: "previous_day",
    },
    completedBookings: {
      count: completedBookings,
      completionRate: totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0,
      period: "all_time",
    },
    profileViews: { count: 0, newVisitors: 0, period: "current_month" },
    pendingRequests: { count: pendingRequestsCount, newThisWeek: pendingRequestsNewThisWeek, period: "current_week" },
  };
};

// ─── Revenue growth (current vs previous year, by month) ───────────────────
const getRevenueGrowth = async ({ businessObjId, currency, year }) => {
  const currentYear = year ? parseInt(year) : new Date().getFullYear();
  const previousYear = currentYear - 1;
  const capturedMatch = { paymentStatus: { $in: ["captured", "partially_captured"] } };
  const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };

  const revenueAgg = await Bookings.aggregate([
    {
      $match: {
        business: businessObjId,
        ...capturedMatch,
        createdAt: { $gte: new Date(Date.UTC(previousYear, 0, 1)), $lt: new Date(Date.UTC(currentYear + 1, 0, 1)) },
      },
    },
    {
      $group: {
        _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
        total: { $sum: bookingAmount },
      },
    },
  ]);

  const items = MONTH_KEYS.map((monthKey, idx) => {
    const month = idx + 1;
    const current = revenueAgg.find((r) => r._id.year === currentYear && r._id.month === month);
    const previous = revenueAgg.find((r) => r._id.year === previousYear && r._id.month === month);
    return {
      month,
      monthKey,
      currentYearAmountMinor: toMinor(current?.total),
      previousYearAmountMinor: toMinor(previous?.total),
    };
  });

  const currentYearTotalMinor = items.reduce((sum, item) => sum + item.currentYearAmountMinor, 0);
  const previousYearTotalMinor = items.reduce((sum, item) => sum + item.previousYearAmountMinor, 0);
  return {
    year: currentYear,
    previousYear,
    currency,
    comparisonPeriod: "year_to_date",
    currentYearTotalMinor,
    previousYearTotalMinor,
    growthPercentage: growthPercentage(currentYearTotalMinor, previousYearTotalMinor),
    items,
  };
};

// ─── Bookings over time (monthly counts for a given year) ──────────────────
// Shared shape for any dashboard that just needs a month-bucketed booking
// count — unlike getRevenueGrowth, which sums $ and compares two years.
const getBookingsOverTime = async ({ matchFilter, year }) => {
  const targetYear = year ? parseInt(year) : new Date().getFullYear();
  const agg = await Bookings.aggregate([
    {
      $match: {
        ...matchFilter,
        createdAt: { $gte: new Date(Date.UTC(targetYear, 0, 1)), $lt: new Date(Date.UTC(targetYear + 1, 0, 1)) },
      },
    },
    { $group: { _id: { $month: "$createdAt" }, count: { $sum: 1 } } },
  ]);

  const items = MONTH_KEYS.map((monthKey, idx) => {
    const month = idx + 1;
    const found = agg.find((a) => a._id === month);
    return { month, monthKey, count: found?.count || 0 };
  });

  return { year: targetYear, items };
};

// ─── Customer dashboard summary cards ───────────────────────────────────────
const getCustomerSummary = async ({ userObjId, currency }) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const capturedMatch = { paymentStatus: { $in: ["captured", "partially_captured"] } };
  const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };

  const [providersAgg, amountAgg, scheduledThisMonth, completedAllTime, statusCounts] = await Promise.all([
    Bookings.aggregate([
      { $match: { user: userObjId } },
      { $group: { _id: "$business", firstBookingAt: { $min: "$createdAt" } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          change: { $sum: { $cond: [{ $gte: ["$firstBookingAt", startOfMonth] }, 1, 0] } },
        },
      },
    ]),
    Bookings.aggregate([
      { $match: { user: userObjId, ...capturedMatch, createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: bookingAmount } } },
    ]),
    Bookings.countDocuments({
      user: userObjId,
      status: "scheduled",
      date: { $gte: startOfMonth, $lt: startOfNextMonth },
    }),
    Bookings.countDocuments({ user: userObjId, status: "completed" }),
    countBookingStatuses({ user: userObjId }),
  ]);

  const providers = providersAgg[0] || { count: 0, change: 0 };

  return {
    providers: { count: providers.count, change: providers.change, changePeriod: "current_month" },
    amountSpent: { amountMinor: toMinor(amountAgg[0]?.total), currency, period: "current_month" },
    scheduledAppointments: { count: scheduledThisMonth, period: "current_month" },
    completedBookings: { count: completedAllTime, period: "all_time" },
    requestedBookings: { count: statusCounts.requested || 0 },
    ongoingBookings: { count: statusCounts.ongoing || 0 },
    scheduledBookings: { count: statusCounts.scheduled || 0 },
    expiredBookings: { count: statusCounts.expired || 0 },
  };
};

// ─── Top customers by spend ─────────────────────────────────────────────────
const getTopCustomers = async ({ businessObjId, currency }) => {
  const capturedMatch = { $in: ["$paymentStatus", ["captured", "partially_captured"]] };
  const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };

  const agg = await Bookings.aggregate([
    { $match: { business: businessObjId } },
    {
      $group: {
        _id: "$user",
        totalBookings: { $sum: 1 },
        completedBookings: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        totalSpent: { $sum: { $cond: [capturedMatch, bookingAmount, 0] } },
        lastBookingAt: { $max: "$createdAt" },
      },
    },
    { $sort: { totalSpent: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "userInfo",
      },
    },
    { $unwind: "$userInfo" },
  ]);

  return agg.map((c, idx) => ({
    customerId: c._id,
    rank: idx + 1,
    name: c.userInfo.name,
    email: c.userInfo.email,
    profileImage: c.userInfo.profileIcon ? getFullImageUrl(c.userInfo.profileIcon) : null,
    totalBookings: c.totalBookings,
    completedBookings: c.completedBookings,
    totalSpentMinor: toMinor(c.totalSpent),
    currency,
    lastBookingAt: c.lastBookingAt,
  }));
};

// ─── Recent reviews ─────────────────────────────────────────────────────────
// businessReply is always null — there's no reply feature on Review yet.
const getRecentReviews = async ({ businessObjId }) => {
  const reviews = await Review.find({ business: businessObjId, status: "approved" })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate("subject", "name profileIcon")
    .lean();

  return Promise.all(
    reviews.map(async (review) => {
      const Model = review.reviewType === "services" ? Services : Packages;
      const target = await Model.findById(review.object).select("name").lean();
      return {
        reviewId: review._id,
        bookingId: review.booking,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        customer: {
          id: review.subject?._id,
          name: review.subject?.name,
          profileImage: review.subject?.profileIcon ? getFullImageUrl(review.subject.profileIcon) : null,
        },
        service: { id: review.object, title: target?.name || null },
        businessReply: null,
      };
    }),
  );
};

const getBusinessStats = async (user) => {
  const businessId = user.businessId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const PLATFORM_FEE_RATE = 0.05;
  const capturedMatch = { paymentStatus: { $in: ["captured", "partially_captured"] } };
  const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };

  // Aggregate bookings for stats
  const stats = await Bookings.aggregate([
    { $match: { business: new mongoose.Types.ObjectId(businessId) } },
    {
      $facet: {
        grossRevenue: [{ $match: capturedMatch }, { $group: { _id: null, total: { $sum: bookingAmount } } }],
        performanceChart: [
          { $match: capturedMatch },
          {
            $group: {
              _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
              total: { $sum: bookingAmount },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ],
      },
    },
  ]);

  const result = stats[0];
  const gross = result.grossRevenue[0]?.total || 0;
  const net = parseFloat((gross * (1 - PLATFORM_FEE_RATE)).toFixed(2));

  return {
    grossRevenue: gross,
    netEarned: net,
    withdrawable: net,
    performanceChart: result.performanceChart.map((p) => ({
      month: p._id.month,
      year: p._id.year,
      total: p.total,
    })),
  };
};

module.exports = {
  getHome,
  getEvents,
  getCustomerHome,
  getBusinessHome,
  getBusinessStats,
};
