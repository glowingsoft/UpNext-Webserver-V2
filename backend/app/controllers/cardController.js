const { sendResponse, validateParams } = require("@utils/responseUtil");
const cardService = require("../services/cardService");

const addCard = async (req, res) => {
  const { paymentMethodId, cardHolderName, setDefault } = req.body;
  if (!validateParams(req, res, { rawData: ["paymentMethodId"] })) return;

  try {
    const result = await cardService.addCard({ user: req.user, paymentMethodId, cardHolderName, setDefault });
    return sendResponse({ res, statusCode: 201, translationKey: "card_added", data: result.data });
  } catch (error) {
    if (error.code === "payment_method_reused") {
      return sendResponse({ res, statusCode: 400, translationKey: "payment_method_reused", error });
    }
    return sendResponse({ res, statusCode: 500, translationKey: "card_add_error", error });
  }
};

const getCards = async (req, res) => {
  try {
    const result = await cardService.listCards({ user: req.user, keyword: req.query.keyword });
    return sendResponse({ res, statusCode: 200, translationKey: "cards_fetched", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "cards_fetch_error", error });
  }
};

const updateCard = async (req, res) => {
  const { cardHolderName, expMonth, expYear, isDefault } = req.body;

  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await cardService.updateCard({
      user: req.user,
      id: req.params.id,
      cardHolderName,
      expMonth,
      expYear,
      isDefault,
    });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "card_updated", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "card_update_error", error });
  }
};

const deleteCard = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"], objectIdFields: ["id"] })) return;

  try {
    const result = await cardService.deleteCard({ user: req.user, id: req.params.id });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "card_deleted", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "card_delete_error", error });
  }
};

module.exports = { addCard, getCards, updateCard, deleteCard };
