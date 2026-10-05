const { sendResponse, validateParams } = require("@utils/responseUtil");
const paymentService = require("../services/paymentService");

/**
 * "Complete Payment" — settles one outstanding booking after a failed capture
 * (debt lock). The booking is the one named in the path; omitting the card
 * falls back to the one stored on that booking.
 *
 * Card field is `stripePaymentMethodId`, matching the booking fix-payment
 * endpoint — the two were named differently for the same thing. `paymentMethod`
 * is still accepted so callers written against the older name keep working.
 */
const settleOutstandingDebt = async (req, res) => {
  const paymentMethod = req.body.stripePaymentMethodId ?? req.body.paymentMethod;

  if (
    !validateParams(req, res, {
      pathParams: ["bookingId"],
      objectIdFields: ["bookingId"],
    })
  )
    return;

  try {
    const result = await paymentService.settleOutstandingDebt({
      user: req.user,
      bookingId: req.params.bookingId,
      paymentMethod,
    });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "debt_settled", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "debt_settlement_failed", error });
  }
};

module.exports = { settleOutstandingDebt };
