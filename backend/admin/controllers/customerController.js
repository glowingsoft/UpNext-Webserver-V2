const { User } = require("@models/UserModel");
const { UserProfile } = require("@models/UserProfile");
const { sendResponse, validateParams, parsePaginationParams, generateMeta } = require("@utils/responseUtil");
const { getUserBookings } = require("../../app/services/bookingService");
const { s3UrlExpr } = require("@utils/aggregationHelper");
const { getFullImageUrl } = require("@utils/imageHelper");

// The schema keeps two deletion states; the screen shows one. Both collapse
// into "deleted" everywhere the admin sees or types a status — the rows, the
// tab counts and the ?status= filter all speak that single vocabulary, so a tab
// can never disagree with the rows underneath it.
const DELETED_STATUSES = ["softDeleted", "hardDeleted"];
const DELETED_LABEL = "deleted";

// Every state a customer account can hold, with the two deletion ones merged.
// Exported because the dashboard counts customers the same way — sharing the
// vocabulary is what keeps cards.customers.total equal to this screen's
// statusList.all instead of the two drifting apart again.
const CUSTOMER_STATUSES = [
  ...User.schema.path("accountState.status").enumValues.filter((s) => !DELETED_STATUSES.includes(s)),
  DELETED_LABEL,
];

// "deleted" isn't a value in the schema — it stands for either of the two.
const statusFilterFor = (status) =>
  status === DELETED_LABEL ? { $in: DELETED_STATUSES } : status;

/**
 * Counts for the status tabs, from the same filter the list uses minus its own
 * status — selecting a tab must not change the numbers on the tabs, but a
 * keyword search should narrow all of them. Zero-filled so an empty tab still
 * renders, with "all" first, matching the bookings list's meta.statuses.
 */
const countCustomerStatuses = async (matchConditions) => {
  const baseFilter = { ...matchConditions };
  delete baseFilter["accountState.status"];

  const counts = await User.aggregate([
    { $match: baseFilter },
    { $group: { _id: "$accountState.status", count: { $sum: 1 } } },
  ]);

  const statusList = { all: 0 };
  CUSTOMER_STATUSES.forEach((status) => {
    statusList[status] = 0;
  });
  counts.forEach(({ _id, count }) => {
    statusList.all += count;
    const bucket = DELETED_STATUSES.includes(_id) ? DELETED_LABEL : _id;
    if (bucket in statusList) statusList[bucket] += count;
  });
  return statusList;
};

// Sort options for the customers list — "newest" (default) is the joining-date
// order the table has always used.
const customerSortList = ["newest", "totalBookings"];

// Only the bookings' ids are needed to size the array; pulling whole booking
// documents to count them is wasted payload, and this lookup now runs over
// every matched customer when sorting by it.
const bookingsCountLookup = {
  $lookup: {
    from: "bookings",
    localField: "_id",
    foreignField: "user",
    as: "bookings",
    pipeline: [{ $project: { _id: 1 } }],
  },
};

// ─── Get all customers (Admin) — paginated list for the Customers table ───
const getCustomers = async (req, res) => {
  const validationOptions = {
    enumFields: { status: CUSTOMER_STATUSES, sortBy: customerSortList },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { page, limit } = parsePaginationParams(req);
    const { keyword, status, sortBy } = req.query;

    // No status exclusion: deleted customers stay in the admin list.
    const matchConditions = { "accountState.userType": "user" };
    if (status) matchConditions["accountState.status"] = statusFilterFor(status);
    if (keyword?.trim()) {
      matchConditions.$or = [
        { name: { $regex: keyword.trim(), $options: "i" } },
        { email: { $regex: keyword.trim(), $options: "i" } },
        { phoneNumber: { $regex: keyword.trim(), $options: "i" } },
      ];
    }

    // Sorting by booking count means counting before paginating, so the lookup
    // has to run over the whole matched set. Every other sort keeps the cheap
    // order — page first, then count only those rows. Ties fall back to newest
    // so the ordering stays stable across pages.
    const sortByBookings = sortBy === "totalBookings";
    const paginate = [{ $skip: (page - 1) * limit }, { $limit: limit }];
    const countStage = { $addFields: { totalBookings: { $size: "$bookings" } } };

    const orderedStages = sortByBookings
      ? [bookingsCountLookup, countStage, { $sort: { totalBookings: -1, createdAt: -1 } }, ...paginate]
      : [{ $sort: { createdAt: -1 } }, ...paginate, bookingsCountLookup, countStage];

    const [customers, totalRecords, statusList] = await Promise.all([
      User.aggregate([
        { $match: matchConditions },
        ...orderedStages,
        {
          $project: {
            _id: 1,
            name: 1,
            email: 1,
            phoneNumber: 1,
            profileIcon: s3UrlExpr("$profileIcon"),
            status: {
              $cond: [{ $in: ["$accountState.status", DELETED_STATUSES] }, DELETED_LABEL, "$accountState.status"],
            },
            joiningDate: "$createdAt",
            totalBookings: 1,
          },
        },
      ]),
      User.countDocuments(matchConditions),
      countCustomerStatuses(matchConditions),
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "customers_fetched",
      data: customers,
      meta: { ...generateMeta(page, limit, totalRecords), statusList, sortByList: customerSortList },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Get single customer (Admin) — Profile tab ─────────────────────────────
const getCustomer = async (req, res) => {
  const { userId } = req.params;

  const validationOptions = { pathParams: ["userId"], objectIdFields: ["userId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    // No status exclusion, matching getCustomers: a deleted customer still
    // shows up in the admin list, so its row has to stay openable — filtering
    // the deletion states out here 404'd every row the list rendered.
    const user = await User.findOne({
      _id: userId,
      "accountState.userType": "user",
    })
      .select("name email phoneNumber profileIcon accountState.status createdAt")
      .lean();

    if (!user) {
      return sendResponse({ res, statusCode: 404, translationKey: "customer_not_found" });
    }

    const profile = await UserProfile.findOne({ user: userId }).lean();

    // Category names are denormalized onto the profile's combined
    // categories array — no lookup needed
    const preferredCategory = (profile?.categories || []).map((c) => c?.name || "").filter(Boolean);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "customer_fetched",
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        profileIcon: user.profileIcon ? getFullImageUrl(user.profileIcon) : null,
        // Collapsed to the single "deleted" label the list and the status
        // tabs use, so the profile can't name a status the table never shows.
        status: DELETED_STATUSES.includes(user.accountState?.status)
          ? DELETED_LABEL
          : user.accountState?.status,
        joiningDate: user.createdAt,
        location: profile?.location?.address || "",
        preferredCategory,
        preferredServiceType: profile?.badges?.preferredServiceType?.optionName || "",
        description: profile?.description || "",
        preferredBookingTime: profile?.badges?.preferredBookingTime?.optionName || "",
        bookingStyle: profile?.badges?.bookingStyle?.optionName || "",
        travelDistance: profile?.badges?.travelDistance?.optionName || "",
        bookingFrequency: profile?.badges?.bookingFrequency?.optionName || "",
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Get a customer's bookings (Admin) — Bookings tab, separate endpoint ───
const getCustomerBookings = async (req, res) => {
  const { userId } = req.params;

  const validationOptions = { pathParams: ["userId"], objectIdFields: ["userId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const { page, limit } = parsePaginationParams(req);
    const { status, scope, date, keyword } = req.query;

    const { data, meta } = await getUserBookings({
      userId,
      page,
      limit,
      status,
      scope,
      date,
      keyword,
      locale: req.language || req.user?.language,
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "customer_bookings_fetched",
      data,
      meta,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = {
  getCustomers,
  getCustomer,
  getCustomerBookings,
  CUSTOMER_STATUSES,
  DELETED_STATUSES,
  DELETED_LABEL,
};
