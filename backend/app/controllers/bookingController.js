const { sendResponse, validateParams } = require("@utils/responseUtil");
const bookingService = require("../services/bookingService");
const { getViewerBusinessId } = require("@utils/viewerUtil");

const getSlots = async (req, res) => {
  const { scope, targetId, date } = req.query;

  if (
    !validateParams(req, res, {
      queryParams: ["scope", "targetId", "date"],
      enumFields: { scope: BOOKING_SCOPES },
      objectIdFields: ["targetId"],
    })
  )
    return;

  try {
    const result = await bookingService.getSlots({ scope, targetId, date });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "booking_slots_fetched", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "booking_slots_fetch_error", error });
  }
};

const createBooking = async (req, res) => {
  const { slot } = req.body;

  if (
    !validateParams(req, res, {
      // stripePaymentMethodId (a Stripe PaymentMethod id collected client-side,
      // e.g. via CardField + createPaymentMethod) is required — no booking,
      // not even a checkout draft, is created without it.
      rawData: ["scope", "targetId", "date", "slot", "stripePaymentMethodId"],
      objectIdFields: ["targetId"],
    })
  )
    return;

  if (!slot?.open || !slot?.close) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "booking_slot_required",
    });
  }
  try {
    const result = await bookingService.createBooking({
      req: { ...req, body: { ...req.body, slot } },
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "booking_created",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_create_error",
      error,
    });
  }
};

const BOOKING_STATUSES = ["requested", "scheduled", "ongoing", "completed", "canceled", "expired"];
const BOOKING_SCOPES = ["service", "package"];

const getUserBookings = async (req, res) => {
  const { page, limit, status, scope, date, keyword } = req.query;

  if (
    !validateParams(req, res, {
      enumFields: { status: BOOKING_STATUSES, scope: BOOKING_SCOPES },
    })
  )
    return;

  try {
    const result = await bookingService.getUserBookings({
      userId: req.user._id,
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
      translationKey: "bookings_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "bookings_fetch_error",
      error,
    });
  }
};

const getBusinessBookings = async (req, res) => {
  const { page, limit, status, scope, date, userId, keyword } = req.query;

  if (
    !validateParams(req, res, {
      enumFields: { status: BOOKING_STATUSES, scope: BOOKING_SCOPES },
    })
  )
    return;

  try {
    const result = await bookingService.getBusinessBookings({
      businessId: req.user.businessId,
      page,
      limit,
      status,
      scope,
      date,
      userId,
      keyword,
      locale: req.language || req.user?.language,
    });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "bookings_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "bookings_fetch_error",
      error,
    });
  }
};

// Taken from the service rather than listed here, so the accepted filters stay
// in step with the keys of meta.statusCounts — hardcoding them left the newer
// labels (released, expired, partially_captured) rejected as invalid.
const BILLING_STATUSES = bookingService.BILLING_STATUS_FILTERS;

const getBillingHistory = async (req, res) => {
  const { page, limit, keyword, status, startDate, endDate } = req.query;

  if (
    !validateParams(req, res, {
      enumFields: { status: BILLING_STATUSES },
      dateFields: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" },
    })
  )
    return;

  try {
    const result = await bookingService.getBillingHistory({
      businessId: req.user.businessId,
      page,
      limit,
      keyword,
      status,
      startDate,
      endDate,
      locale: req.language || req.user?.language,
    });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "billing_history_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "billing_history_fetch_error",
      error,
    });
  }
};

const getBillingHistoryDetail = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.getBillingHistoryDetail({
      id: req.params.id,
      businessId: req.user.businessId,
      locale: req.language || req.user?.language,
    });
    if (result.error)
      return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "billing_history_fetched",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "billing_history_fetch_error",
      error,
    });
  }
};

const CALENDAR_RANGES = ["today", "weekly", "monthly"];

const getBookingsCalendar = async (req, res) => {
  const { range, date, status } = req.query;

  if (
    !validateParams(req, res, {
      queryParams: ["range"],
      enumFields: { range: CALENDAR_RANGES, status: BOOKING_STATUSES },
    })
  )
    return;

  try {
    const result = await bookingService.getBookingsCalendar({
      userId: req.user._id,
      businessId: req.user.businessId,
      userType: req.user.userType,
      range,
      date,
      status,
      timezone: req.user?.timezone,
    });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "bookings_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "bookings_fetch_error",
      error,
    });
  }
};

const getBookingById = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.getBookingById({
      id: req.params.id,
      requesterId: req.user._id,
      businessId: req.user.businessId,
      userType: req.user.userType,
      locale: req.language || req.user?.language,
      timezone: req.user?.timezone,
      // Distance on the booked business and on the rebook suggestions a
      // canceled/expired booking comes back with
      lat: req.query.lat,
      lng: req.query.lng,
      // canBook on those suggestions — a dual-role account must not be offered
      // its own listings, whichever mode it's browsing in
      viewerBusinessId: await getViewerBusinessId(req),
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_fetched",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_fetch_error",
      error,
    });
  }
};

const startBooking = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.startBooking({
      id: req.params.id,
      businessId: req.user.businessId,
      timezone: req.user?.timezone,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_started",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_start_error",
      error,
    });
  }
};

const acceptBooking = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.acceptBooking({
      id: req.params.id,
      businessId: req.user.businessId,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_accepted",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_accept_error",
      error,
    });
  }
};

const rejectBooking = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.rejectBooking({
      id: req.params.id,
      businessId: req.user.businessId,
      reason: req.body.reason,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_rejected",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_reject_error",
      error,
    });
  }
};

const cancelBooking = async (req, res) => {
  if (
    !validateParams(req, res, {
      pathParams: ["id"],
      formFields: ["reason"],
      objectIdFields: ["id"],
    })
  )
    return;

  try {
    const result = await bookingService.cancelBooking({
      id: req.params.id,
      requesterId: req.user._id,
      businessId: req.user.businessId,
      reason: req.body.reason,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_cancelled",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_cancel_error",
      error,
    });
  }
};

const completeBooking = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.completeBooking({
      id: req.params.id,
      businessId: req.user.businessId,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_completed",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_complete_error",
      error,
    });
  }
};

const fixPayment = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await bookingService.fixBookingPayment({
      id: req.params.id,
      user: req.user,
      paymentMethod: req.body.stripePaymentMethodId,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_payment_fix_started",
      data: result.data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_payment_fix_error",
      error,
    });
  }
};

const sendReminder = async (req, res) => {
  const { type } = req.body;

  if (
    !validateParams(req, res, {
      pathParams: ["id"],
      formFields: ["type"],
      objectIdFields: ["id"],
      enumFields: { type: ["payment", "slot", "start"] },
    })
  )
    return;

  try {
    const result = await bookingService.sendReminder({
      id: req.params.id,
      businessId: req.user.businessId,
      type,
    });
    if (result.error)
      return sendResponse({
        res,
        statusCode: result.status,
        translationKey: result.error,
      });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_reminder_sent",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "booking_reminder_error",
      error,
    });
  }
};

module.exports = {
  getSlots,
  createBooking,
  getUserBookings,
  getBusinessBookings,
  getBillingHistory,
  getBillingHistoryDetail,
  getBookingsCalendar,
  getBookingById,
  acceptBooking,
  startBooking,
  rejectBooking,
  cancelBooking,
  completeBooking,
  fixPayment,
  sendReminder,
};
