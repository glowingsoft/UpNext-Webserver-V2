const mongoose = require("mongoose");
const { sendResponse } = require("@utils/responseUtil");
const instantBooking = require("../services/instantBookingService");
const { acceptOffer, declineOffer, runOfferSweeper } = require("../services/instantOfferService");

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
    return sendResponse({ res, statusCode: 200, translationKey: successKey, data: result.data });
  } catch (err) {
    console.error(`instant ${successKey} error:`, err);
    return sendResponse({ res, statusCode: 500, translationKey: "server_error", error: err.message });
  }
};

const loc = (req) => ({ lat: req.body.lat, lng: req.body.lng });

module.exports = {
  quote: handle("instant_quote", (req) => instantBooking.quote(req.query)),
  createBooking: handle("instant_booking_created", (req) =>
    instantBooking.createInstantBooking({ userId: req.user._id, body: req.body }),
  ),
  getBooking: handle(
    "instant_booking_fetched",
    (req) => instantBooking.getInstantBooking({ id: req.params.id, userId: req.user._id, businessId: req.user.businessId }),
    { ids: ["id"] },
  ),
  cancelBooking: handle(
    "instant_booking_canceled",
    (req) => instantBooking.clientCancel({ id: req.params.id, userId: req.user._id, reason: req.body.reason }),
    { ids: ["id"] },
  ),
  reportNoShow: handle(
    "instant_no_show_reported",
    (req) => instantBooking.reportNoShow({ id: req.params.id, userId: req.user._id }),
    { ids: ["id"] },
  ),
  currentOffer: handle("instant_offer_fetched", (req) => instantBooking.getCurrentOffer({ businessId: req.user.businessId })),
  acceptOffer: handle(
    "instant_offer_accepted",
    (req) => acceptOffer({ offerId: req.params.offerId, businessId: req.user.businessId }),
    { ids: ["offerId"] },
  ),
  declineOffer: handle(
    "instant_offer_declined",
    (req) => declineOffer({ offerId: req.params.offerId, businessId: req.user.businessId }),
    { ids: ["offerId"] },
  ),
  arrived: handle(
    "instant_arrived",
    (req) => instantBooking.arrived({ id: req.params.id, businessId: req.user.businessId, ...loc(req) }),
    { ids: ["id"] },
  ),
  complete: handle(
    "instant_completed",
    (req) => instantBooking.complete({ id: req.params.id, businessId: req.user.businessId, ...loc(req) }),
    { ids: ["id"] },
  ),
  providerCancel: handle(
    "instant_provider_canceled",
    (req) => instantBooking.providerCancel({ id: req.params.id, businessId: req.user.businessId, reason: req.body.reason }),
    { ids: ["id"] },
  ),
  contestNoShow: handle(
    "instant_no_show_contested",
    (req) => instantBooking.contestNoShow({ id: req.params.id, businessId: req.user.businessId, note: req.body.note }),
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
