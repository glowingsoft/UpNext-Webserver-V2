const { User } = require("@models/UserModel"); // Assuming this is the User model path
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { Devices } = require("@models/Devices");
const SupportRequest = require("@models/SupportRequest");

const {
  sendResponse,
  validateParams,
} = require("@utils/responseUtil");
const { getFullImageUrl } = require("@utils/imageHelper");
// Shared with the Customers table so the tile and that screen can't drift apart.
const { CUSTOMER_STATUSES, DELETED_STATUSES, DELETED_LABEL } = require("./customerController");

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CUSTOMER_TYPE = "user";
const PROVIDER_TYPE = "business";

// A provider is a BusinessProfile, not a business account.
//
// These two tiles exist to be clicked through to the Customers and Providers
// tables, so each has to count exactly what its table lists:
//   - Customers  -> User docs with userType "user", every status (the table
//                   keeps deleted rows), bucketed in that screen's vocabulary.
//   - Providers  -> BusinessProfile docs, which is what /admin/businesses
//                   paginates. Counting business *accounts* instead is what made
//                   this tile read 61 against a table of 45: an account that
//                   never completed its profile is not a provider yet, and a
//                   profile can outlive the account that owns it.
const PROVIDER_STATUSES = BusinessProfile.schema.path("status").enumValues;

// The Users bar chart stacks both populations in one bar, so it needs a
// vocabulary covering both — account states (which include "restricted") and
// profile states, with the account's two deletion states merged the same way.
// Built as a union so a new value in either enum shows up without being dropped.
const CHART_STATUSES = [...new Set([...CUSTOMER_STATUSES, ...PROVIDER_STATUSES])];

const emptyStatusCounts = (statuses) => ({
  total: 0,
  ...Object.fromEntries(statuses.map((status) => [status, 0])),
});

const startOfYear = (year) => new Date(year, 0, 1, 0, 0, 0, 0);
const startOfNextYear = (year) => new Date(year + 1, 0, 1, 0, 0, 0, 0);

const parseYear = (value, fallback) => {
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) ? year : fallback;
};

/**
 * Twelve rows whatever the data looks like: a month with no signups has to draw
 * as a zero-height bar, not drop out of the series and shift every later month
 * one place to the left.
 */
const buildMonthlySeries = (fill) =>
  MONTH_LABELS.map((label, index) => ({ month: index + 1, label, ...fill() }));

/**
 * GET /admin/home — everything the admin dashboard renders, in one call.
 *
 * The two charts take their own year, because they answer different questions
 * and the UI gives each its own dropdown:
 *   ?usersYear=2026       Users bar chart (active/inactive/suspended/pending)
 *   ?comparisonYear=2025  Customers vs Providers line chart
 * Either one omitted falls back to the current year, independently of the other.
 */
const getHome = async (req, res) => {
  const validationOptions = {
    dateFields: { usersYear: "YYYY", comparisonYear: "YYYY" },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const usersYear = parseYear(req.query.usersYear, currentYear);
    const comparisonYear = parseYear(req.query.comparisonYear, currentYear);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const [
      customerStatusBreakdown,
      providerStatusBreakdown,
      newCustomersThisMonth,
      newProvidersThisMonth,
      bookingsByStatus,
      bookingsThisMonth,
      supportTotal,
      supportThisMonth,
      devicePlatform,
      customerStatusByMonth,
      providerStatusByMonth,
      customersByMonth,
      providersByMonth,
      topRatedProviders,
      topCustomers,
      signupYears,
    ] = await Promise.all([
      // Customers by status — every status, matching the Customers table.
      User.aggregate([
        { $match: { "accountState.userType": CUSTOMER_TYPE } },
        { $group: { _id: "$accountState.status", count: { $sum: 1 } } },
      ]),

      // Providers by status — profiles, matching the Providers table.
      BusinessProfile.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),

      User.countDocuments({ "accountState.userType": CUSTOMER_TYPE, createdAt: { $gte: monthStart } }),

      BusinessProfile.countDocuments({ createdAt: { $gte: monthStart } }),

      Booking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Booking.countDocuments({ createdAt: { $gte: monthStart } }),

      SupportRequest.countDocuments(),
      SupportRequest.countDocuments({ createdAt: { $gte: monthStart } }),

      // "Active user devices" — every registered device of an active account,
      // so a suspended user's phone doesn't inflate the platform split.
      Devices.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "owner",
            pipeline: [{ $match: { "accountState.status": "active" } }, { $project: { _id: 1 } }],
          },
        },
        { $match: { "owner.0": { $exists: true } } },
        { $unwind: "$devices" },
        { $group: { _id: "$devices.deviceType", count: { $sum: 1 } } },
      ]),

      // Users bar chart — signups of the selected year, bucketed by month and by
      // the status the row holds now. Drawn over the same two populations the
      // tiles count (customers + providers), so a month's bars total exactly
      // what the comparison chart plots for that month.
      User.aggregate([
        {
          $match: {
            "accountState.userType": CUSTOMER_TYPE,
            createdAt: { $gte: startOfYear(usersYear), $lt: startOfNextYear(usersYear) },
          },
        },
        {
          $group: {
            _id: { month: { $month: "$createdAt" }, status: "$accountState.status" },
            count: { $sum: 1 },
          },
        },
      ]),

      BusinessProfile.aggregate([
        { $match: { createdAt: { $gte: startOfYear(usersYear), $lt: startOfNextYear(usersYear) } } },
        {
          $group: {
            _id: { month: { $month: "$createdAt" }, status: "$status" },
            count: { $sum: 1 },
          },
        },
      ]),

      // Customers vs providers — its own year, hence its own aggregation. Both
      // series count the same things their tiles do, or the chart would
      // contradict the numbers directly above it.
      User.aggregate([
        {
          $match: {
            "accountState.userType": CUSTOMER_TYPE,
            createdAt: { $gte: startOfYear(comparisonYear), $lt: startOfNextYear(comparisonYear) },
          },
        },
        { $group: { _id: { $month: "$createdAt" }, count: { $sum: 1 } } },
      ]),

      BusinessProfile.aggregate([
        { $match: { createdAt: { $gte: startOfYear(comparisonYear), $lt: startOfNextYear(comparisonYear) } } },
        { $group: { _id: { $month: "$createdAt" }, count: { $sum: 1 } } },
      ]),

      // Highest rated businesses. Driven from BusinessProfile rather than from
      // Review so a provider with no reviews yet still places (0 / 0 reviews),
      // the way the mock's fourth row does.
      BusinessProfile.aggregate([
        { $match: { status: "active" } },
        {
          $lookup: {
            from: "reviews",
            localField: "_id",
            foreignField: "business",
            as: "reviews",
            pipeline: [{ $match: { status: "approved" } }, { $project: { rating: 1 } }],
          },
        },
        {
          $addFields: {
            avgRating: { $ifNull: [{ $avg: "$reviews.rating" }, 0] },
            totalReviews: { $size: "$reviews" },
          },
        },
        { $sort: { avgRating: -1, totalReviews: -1 } },
        { $limit: 5 },
        {
          $project: {
            _id: 1,
            businessName: 1,
            image: 1,
            category: { $ifNull: [{ $first: "$categories.name" }, null] },
            avgRating: { $round: ["$avgRating", 1] },
            totalReviews: 1,
          },
        },
      ]),

      // Most booked customers, counted over every booking they ever placed.
      Booking.aggregate([
        { $group: { _id: "$user", bookingsCount: { $sum: 1 } } },
        { $sort: { bookingsCount: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
            pipeline: [{ $project: { name: 1, email: 1, profileIcon: 1 } }],
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: "$user._id",
            name: "$user.name",
            email: "$user.email",
            profileIcon: "$user.profileIcon",
            bookingsCount: 1,
          },
        },
      ]),

      // Years that actually have signups — what the two dropdowns should offer.
      User.aggregate([
        { $match: { "accountState.userType": { $in: [CUSTOMER_TYPE, PROVIDER_TYPE] } } },
        { $group: { _id: { $year: "$createdAt" } } },
        { $sort: { _id: -1 } },
      ]),
    ]);

    // ─── Donuts: customers and providers by status ──────────────────────────
    // Each donut carries its own screen's statuses, so the buckets add up to the
    // total instead of quietly dropping the rows they have no name for.
    const customers = emptyStatusCounts(CUSTOMER_STATUSES);
    for (const { _id, count } of customerStatusBreakdown) {
      // The schema keeps two deletion states; the Customers screen shows one.
      const bucket = DELETED_STATUSES.includes(_id) ? DELETED_LABEL : _id;
      if (bucket in customers) customers[bucket] += count;
      customers.total += count;
    }

    const providers = emptyStatusCounts(PROVIDER_STATUSES);
    for (const { _id, count } of providerStatusBreakdown) {
      if (_id in providers) providers[_id] += count;
      providers.total += count;
    }

    // ─── Booking status tiles ───────────────────────────────────────────────
    const bookings = { total: 0, completed: 0, requested: 0, ongoing: 0, expired: 0, scheduled: 0, canceled: 0 };
    for (const { _id, count } of bookingsByStatus) {
      if (_id in bookings) bookings[_id] = count;
      bookings.total += count;
    }

    // ─── Device platform ────────────────────────────────────────────────────
    const devices = { total: 0, ios: 0, android: 0, web: 0 };
    for (const { _id, count } of devicePlatform) {
      if (_id in devices) devices[_id] = count;
      devices.total += count;
    }

    // ─── Chart 1: users by status, month by month ───────────────────────────
    const usersChartMonths = buildMonthlySeries(() =>
      Object.fromEntries(CHART_STATUSES.map((status) => [status, 0])),
    );
    const addToUsersChart = (rows, mergeDeleted) => {
      for (const { _id, count } of rows) {
        const row = usersChartMonths[_id.month - 1];
        if (!row) continue;
        const bucket = mergeDeleted && DELETED_STATUSES.includes(_id.status) ? DELETED_LABEL : _id.status;
        if (bucket in row) row[bucket] += count;
      }
    };
    addToUsersChart(customerStatusByMonth, true);
    // BusinessProfile already stores a single "deleted" state, so nothing to merge.
    addToUsersChart(providerStatusByMonth, false);

    // ─── Chart 2: customers vs providers, month by month ────────────────────
    const comparisonMonths = buildMonthlySeries(() => ({ customers: 0, providers: 0 }));
    for (const { _id, count } of customersByMonth) {
      const row = comparisonMonths[_id - 1];
      if (row) row.customers += count;
    }
    for (const { _id, count } of providersByMonth) {
      const row = comparisonMonths[_id - 1];
      if (row) row.providers += count;
    }

    // Years that hold data, plus the current one so the dropdown is never empty
    // in January. The requested years are deliberately not folded in — asking
    // for 1999 shouldn't add 1999 to everyone's dropdown.
    const availableYears = [...new Set([currentYear, ...signupYears.map((entry) => entry._id)])]
      .filter(Boolean)
      .sort((a, b) => b - a);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: {
        cards: {
          customers: { total: customers.total, thisMonth: newCustomersThisMonth },
          providers: { total: providers.total, thisMonth: newProvidersThisMonth },
          bookings: { total: bookings.total, thisMonth: bookingsThisMonth },
          // One card each, in the order the second tile row draws them. Only
          // these four are surfaced — "scheduled" and "canceled" are counted
          // for the total but have no tile.
          completedBookings: { total: bookings.completed },
          requestedBookings: { total: bookings.requested },
          ongoingBookings: { total: bookings.ongoing },
          expiredBookings: { total: bookings.expired },
          // The "Contact Support" tile counts support requests — the ContactUs
          // inbox is a separate thing and deliberately not folded in here.
          contactSupport: { total: supportTotal, thisMonth: supportThisMonth },
        },
        customers,
        providers,
        devicePlatform: devices,
        usersChart: { year: usersYear, months: usersChartMonths },
        comparisonChart: { year: comparisonYear, months: comparisonMonths },
        topRatedProviders: topRatedProviders.map((provider) => ({
          ...provider,
          image: provider.image ? getFullImageUrl(provider.image) : provider.image,
        })),
        topCustomers: topCustomers.map((customer) => ({
          ...customer,
          profileIcon: customer.profileIcon ? getFullImageUrl(customer.profileIcon) : customer.profileIcon,
        })),
        availableYears,
      },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error,
    });
  }
};

module.exports = {
  getHome,
};
