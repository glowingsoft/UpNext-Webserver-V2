const mongoose = require("mongoose");
const Bookings = require("@models/Bookings");
const Review = require("@models/Review");
const BusinessAnalyticsEvent = require("@models/BusinessAnalyticsEvent");
const { getBusinessStats } = require("../controllers/homeController");
const { getBillingHistory } = require("./bookingService");
const {
  getConnectBalance,
  listExternalAccounts,
  addExternalAccount,
  removeExternalAccount,
  createPayout,
} = require("@services/stripeAccount");

const toMinor = (amount) => Math.round((amount || 0) * 100);
const PLATFORM_FEE_RATE = 0.05;
const capturedMatch = { paymentStatus: { $in: ["captured", "partially_captured"] } };
const bookingAmount = { $ifNull: [{ $arrayElemAt: ["$target.price", 0] }, 0] };

const pctChange = (current, previous) => {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
};

const sumBookingAmount = async (businessObjId, from, to) => {
  const agg = await Bookings.aggregate([
    { $match: { business: businessObjId, ...capturedMatch, createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: null, total: { $sum: bookingAmount } } },
  ]);
  return agg[0]?.total || 0;
};

const REVENUE_RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

const getRangeBounds = (range, fallback = "30d") => {
  const key = REVENUE_RANGE_DAYS[range] ? range : fallback;
  const days = REVENUE_RANGE_DAYS[key];
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000);
  return { range: key, now, start, prevStart };
};

const mapExternalAccount = (account) => ({
  id: account.id,
  type: account.object, // "bank_account" | "card"
  bankName: account.bank_name || null,
  brand: account.brand || null,
  last4: account.last4 || null,
  isDefault: account.default_for_currency === true,
});

// ─── Analytics screen (Profile Views / Search Appears / Booking Requests /
// Conversions / Avg Rating / Revenue, all with a vs-previous-period change,
// plus the all-time monthly performance chart) ──────────────────────────────
const ANALYTICS_RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

const getAnalytics = async ({ user, range }) => {
  const businessObjId = new mongoose.Types.ObjectId(String(user.businessId));
  const currency = user.currency || "usd";
  const days = ANALYTICS_RANGE_DAYS[range] || 90;
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000);

  // Requests that made it past "requested" (i.e. the business accepted them)
  // in the period — a conversion, without needing new attribution tracking.
  const acceptedMatch = { status: { $nin: ["requested"] } };

  const avgRatingInRange = async (from, to) => {
    const agg = await Review.aggregate([
      { $match: { business: businessObjId, status: "approved", createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, avg: { $avg: "$rating" } } },
    ]);
    return agg[0]?.avg || 0;
  };

  const [
    profileViewsCurrent,
    profileViewsPrev,
    searchCurrent,
    searchPrev,
    requestsCurrent,
    requestsPrev,
    conversionsCurrent,
    conversionsPrev,
    revenueCurrent,
    revenuePrev,
    ratingCurrent,
    ratingPrev,
    statsAllTime,
  ] = await Promise.all([
    BusinessAnalyticsEvent.countDocuments({
      business: businessObjId,
      type: "profile_view",
      createdAt: { $gte: start, $lt: now },
    }),
    BusinessAnalyticsEvent.countDocuments({
      business: businessObjId,
      type: "profile_view",
      createdAt: { $gte: prevStart, $lt: start },
    }),
    BusinessAnalyticsEvent.countDocuments({
      business: businessObjId,
      type: "search_impression",
      createdAt: { $gte: start, $lt: now },
    }),
    BusinessAnalyticsEvent.countDocuments({
      business: businessObjId,
      type: "search_impression",
      createdAt: { $gte: prevStart, $lt: start },
    }),
    Bookings.countDocuments({ business: businessObjId, createdAt: { $gte: start, $lt: now } }),
    Bookings.countDocuments({ business: businessObjId, createdAt: { $gte: prevStart, $lt: start } }),
    Bookings.countDocuments({ business: businessObjId, ...acceptedMatch, createdAt: { $gte: start, $lt: now } }),
    Bookings.countDocuments({ business: businessObjId, ...acceptedMatch, createdAt: { $gte: prevStart, $lt: start } }),
    sumBookingAmount(businessObjId, start, now),
    sumBookingAmount(businessObjId, prevStart, start),
    avgRatingInRange(start, now),
    avgRatingInRange(prevStart, start),
    getBusinessStats({ businessId: String(businessObjId) }),
  ]);

  return {
    range: ANALYTICS_RANGE_DAYS[range] ? range : "90d",
    profileViews: { count: profileViewsCurrent, changePercent: pctChange(profileViewsCurrent, profileViewsPrev) },
    searchAppearances: { count: searchCurrent, changePercent: pctChange(searchCurrent, searchPrev) },
    bookingRequests: { count: requestsCurrent, changePercent: pctChange(requestsCurrent, requestsPrev) },
    conversions: { count: conversionsCurrent, changePercent: pctChange(conversionsCurrent, conversionsPrev) },
    avgRating: { average: Math.round(ratingCurrent * 10) / 10, changePercent: pctChange(ratingCurrent, ratingPrev) },
    revenue: { amountMinor: toMinor(revenueCurrent), currency, changePercent: pctChange(revenueCurrent, revenuePrev) },
    performanceChart: statsAllTime.performanceChart,
  };
};

// ─── Revenue screen (Available to Withdraw / Gross Revenue / Net Earned /
// Pending Payout, all last-calendar-month, plus a Per Client preview that
// mirrors the billing-history list) ─────────────────────────────────────────
const getRevenue = async ({ user, range }) => {
  const businessObjId = new mongoose.Types.ObjectId(String(user.businessId));
  const currency = user.currency || "usd";
  const accountId = user.stripe?.accountId;

  const { range: appliedRange, now, start, prevStart } = getRangeBounds(range);

  const [currentGross, previousGross, balance, perClientHistory] = await Promise.all([
    sumBookingAmount(businessObjId, start, now),
    sumBookingAmount(businessObjId, prevStart, start),
    accountId ? getConnectBalance(accountId).catch(() => null) : Promise.resolve(null),
    getBillingHistory({
      businessId: user.businessId,
      page: 1,
      limit: 5,
      status: "paid",
      startDate: start,
      endDate: now,
    }),
  ]);

  const currentNet = parseFloat((currentGross * (1 - PLATFORM_FEE_RATE)).toFixed(2));
  const previousNet = parseFloat((previousGross * (1 - PLATFORM_FEE_RATE)).toFixed(2));
  const balanceCurrency = balance?.currency || currency;

  return {
    range: appliedRange,
    availableToWithdraw: { amountMinor: toMinor(balance?.available), currency: balanceCurrency },
    grossRevenue: {
      amountMinor: toMinor(currentGross),
      currency,
      period: appliedRange,
      changePercent: pctChange(currentGross, previousGross),
    },
    netEarned: {
      amountMinor: toMinor(currentNet),
      currency,
      period: appliedRange,
      changePercent: pctChange(currentNet, previousNet),
    },
    pendingPayout: {
      amountMinor: toMinor(balance?.pending),
      currency: balanceCurrency,
      status: "processing",
      etaBusinessDays: "2-3",
    },
    perClient: (perClientHistory.data || []).map((row) => ({
      customer: row.customer,
      target: row.target,
      amountMinor: toMinor(row.amount),
      currency: balanceCurrency,
      date: row.date,
    })),
  };
};

// ─── Per-client revenue list (paginated, searchable) — same trimmed row
// shape as getRevenue's perClient preview above, just not capped to 5 rows.
// keyword matches customer name/email, service/package name, transaction id,
// or amount (see bookingService.getBillingHistory).
const getRevenueClients = async ({ user, page, limit, keyword }) => {
  const currency = user.currency || "usd";

  const history = await getBillingHistory({
    businessId: user.businessId,
    page,
    limit,
    keyword,
    status: "paid",
  });

  return {
    data: (history.data || []).map((row) => ({
      customer: row.customer,
      target: row.target,
      amountMinor: toMinor(row.amount),
      currency,
      date: row.date,
    })),
    meta: history.meta,
  };
};

// ─── Withdraw Funds screen ──────────────────────────────────────────────────
const getPayoutMethods = async ({ user }) => {
  const accountId = user.stripe?.accountId;
  if (!accountId) return { error: "stripe_onboarding_required", status: 400 };

  const accounts = await listExternalAccounts(accountId);
  return { data: accounts.map(mapExternalAccount) };
};

const addPayoutMethod = async ({ user, token, setDefault }) => {
  const accountId = user.stripe?.accountId;
  if (!accountId) return { error: "stripe_onboarding_required", status: 400 };

  const account = await addExternalAccount(accountId, token, { setDefault });
  return { data: mapExternalAccount(account) };
};

const deletePayoutMethod = async ({ user, id }) => {
  const accountId = user.stripe?.accountId;
  if (!accountId) return { error: "stripe_onboarding_required", status: 400 };

  await removeExternalAccount(accountId, id);
  return { data: { id } };
};

const withdrawFunds = async ({ user, amount, payoutMethodId }) => {
  const accountId = user.stripe?.accountId;
  if (!accountId) return { error: "stripe_onboarding_required", status: 400 };

  const amountMinor = toMinor(amount);
  if (!amountMinor || amountMinor <= 0) return { error: "invalid_withdrawal_amount", status: 400 };

  const balance = await getConnectBalance(accountId);
  if (amountMinor > toMinor(balance.available)) {
    return { error: "insufficient_withdrawable_balance", status: 400 };
  }

  const payout = await createPayout({
    accountId,
    amountMinor,
    currency: balance.currency,
    destination: payoutMethodId,
  });

  return {
    data: {
      payoutId: payout.id,
      amountMinor: payout.amount,
      currency: payout.currency,
      status: payout.status,
      arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
    },
  };
};

module.exports = {
  getAnalytics,
  getRevenue,
  getRevenueClients,
  getPayoutMethods,
  addPayoutMethod,
  deletePayoutMethod,
  withdrawFunds,
};
