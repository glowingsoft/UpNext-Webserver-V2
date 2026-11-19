const mongoose = require("mongoose");
const { sendResponse, validateParams, parsePaginationParams } = require("@utils/responseUtil");
const instantBooking = require("../services/instantBookingService");
const { runOfferSweeper } = require("../services/instantOfferService");
const { recordCustomerArrival, startInstantBooking } = require("../services/bookingCheckIn");
const { closeOffer } = require("../services/bookingOfferResponse");
const { cancelInstantBooking } = require("../services/bookingCancellation");
const { getCancellationQuote } = require("../services/bookingCancellationQuote");
const { getNextProviders } = require("../services/bookingNextProviders");
const { getProviderOffers } = require("../services/bookingProviderOffers");
const { sendNextOffer } = require("../services/bookingSendNext");
const { contestNoShow } = require("../services/bookingNoShowContest");
const { createBookingRequest } = require("../services/bookingRequest");
const { acceptBookingOffer } = require("../services/bookingAcceptance");
const { resolveAuthorization, fixBookingPayment } = require("../services/bookingAuthorization");
const { instantTestFlowEnabled } = require("@utils/bookingEligibility");

// Runs a service call and maps its { error, status, data } shape onto sendResponse.
const handle = (successKey, fn, { ids = [] } = {}) => async (req, res) => {
  for (const name of ids) {
    if (!mongoose.isValidObjectId(req.params[name])) {
      return sendResponse({ res, statusCode: 400, translationKey: "invalid_id" });
    }
  }
  try {
    const result = await fn(req);
    if (result.error) {
      return sendResponse({ res, statusCode: result.status, translationKey: result.error, data: result.data });
    }
    return sendResponse({ res, statusCode: 200, translationKey: successKey, data: result.data, meta: result.meta });
  } catch (err) {
    console.error(`instant ${successKey} error:`, err);
    return sendResponse({ res, statusCode: 500, translationKey: "server_error", error: err.message });
  }
};

const loc = (req) => ({ lat: req.body?.lat, lng: req.body?.lng });

const quoteHandler = handle("instant_quote", (req) => instantBooking.quote({ ...req.query, userId: req.user._id }));
const cancel = (req) => cancelInstantBooking({
  bookingId: req.params.id,
  userId: req.user._id,
  businessId: req.user.businessId,
  userType: req.user.userType,
  reason: req.body?.reason,
});
const quote = (req, res) => {
  const objectIdFields = req.query.promotionId ? ["targetId", "promotionId"] : ["targetId"];
  if (!validateParams(req, res, {
    queryParams: ["scope", "targetId"],
    enumFields: { scope: ["service", "package"] },
    objectIdFields,
  })) return;
  return quoteHandler(req, res);
};

module.exports = {
  quote,
  nextProviders: handle(
    "instant_next_providers",
    (req) => getNextProviders({ bookingId: req.params.id, userId: req.user._id }),
    { ids: ["id"] },
  ),
  sendAgain: handle(
    "instant_booking_requested",
    (req) => sendNextOffer({ bookingId: req.params.id, userId: req.user._id, body: req.body, resend: true }),
    { ids: ["id"] },
  ),
  sendNext: handle(
    "instant_booking_requested",
    (req) => sendNextOffer({ bookingId: req.params.id, userId: req.user._id, body: req.body }),
    { ids: ["id"] },
  ),
  declineBooking: handle(
    "instant_offer_declined",
    (req) => closeOffer({ bookingId: req.params.id, businessId: req.user.businessId }),
    { ids: ["id"] },
  ),
  cancelPendingBooking: handle(
    "instant_booking_canceled",
    cancel,
    { ids: ["id"] },
  ),
  createBooking: handle("instant_booking_requested", (req) => instantTestFlowEnabled() ?
    createBookingRequest({ userId: req.user._id, body: req.body }) :
    { error: "instant_request_unavailable", status: 503 }),
  getBooking: handle(
    "instant_booking_fetched",
    (req) => instantBooking.getInstantBooking({ id: req.params.id, userId: req.user._id, businessId: req.user.businessId }),
    { ids: ["id"] },
  ),
  cancelBooking: handle(
    "instant_booking_canceled",
    cancel,
    { ids: ["id"] },
  ),
  cancellationQuote: handle(
    "instant_cancellation_quote",
    (req) => getCancellationQuote({ bookingId: req.params.id, userId: req.user._id,
      businessId: req.user.businessId, userType: req.user.userType }),
    { ids: ["id"] },
  ),
  reportNoShow: handle(
    "instant_no_show_reported",
    (req) => instantBooking.reportNoShow({ id: req.params.id, userId: req.user._id }),
    { ids: ["id"] },
  ),
  providerOffers: handle("instant_offers_fetched", (req) => {
    const { page, limit } = parsePaginationParams(req);
    return getProviderOffers({
      businessId: req.user.businessId, page, limit, status: req.query.status, keyword: req.query.keyword,
    });
  }),
  currentOffer: handle("instant_offer_fetched", async (req) => {
    const result = await getProviderOffers({ businessId: req.user.businessId, limit: 1 });
    return result.error ? result : { data: result.data[0] || null };
  }),
  acceptOffer: handle("instant_offer_accepted", async (req) => {
    if (!instantTestFlowEnabled()) return { error: "instant_payment_unavailable", status: 503 };
    const accepted = await acceptBookingOffer({ offerId: req.params.offerId, businessId: req.user.businessId });
    if (accepted.error) return accepted;
    return resolveAuthorization(accepted.data.bookingId);
  }, { ids: ["offerId"] }),
  fixPayment: handle(
    "instant_payment_updated",
    (req) => instantTestFlowEnabled() ?
      fixBookingPayment({ bookingId: req.params.id, userId: req.user._id, paymentMethodId: req.body?.stripePaymentMethodId }) :
      { error: "instant_payment_unavailable", status: 503 },
    { ids: ["id"] },
  ),
  declineOffer: handle(
    "instant_offer_declined",
    (req) => closeOffer({ offerId: req.params.offerId, businessId: req.user.businessId }),
    { ids: ["offerId"] },
  ),
  customerArrived: handle(
    "instant_customer_arrived",
    (req) => recordCustomerArrival({ bookingId: req.params.id, userId: req.user._id,
      businessId: req.user.businessId, actor: req.user.userType, ...loc(req) }),
    { ids: ["id"] },
  ),
  start: handle(
    "instant_booking_started",
    (req) => startInstantBooking({ bookingId: req.params.id, businessId: req.user.businessId }),
    { ids: ["id"] },
  ),
  complete: handle(
    "instant_completed",
    (req) => instantTestFlowEnabled() ?
      instantBooking.complete({ id: req.params.id, businessId: req.user.businessId, ...loc(req) }) :
      { error: "instant_payment_unavailable", status: 503 },
    { ids: ["id"] },
  ),
  providerCancel: handle(
    "instant_provider_canceled",
    cancel,
    { ids: ["id"] },
  ),
  contestNoShow: handle(
    "instant_no_show_contested",
    (req) => contestNoShow({ bookingId: req.params.id, businessId: req.user.businessId, note: req.body?.note }),
    { ids: ["id"] },
  ),
  runSweeper: handle("instant_sweeper_run", async () => {
    await runOfferSweeper();
    return { data: { ran: true } };
  }),
  runPaymentsCron: handle("instant_payments_cron_run", async () => {
    await require("../services/instantPaymentService").runInstantPaymentsCron();
    return { data: { ran: true } };
  }),
};
