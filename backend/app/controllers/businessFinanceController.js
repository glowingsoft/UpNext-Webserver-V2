const { sendResponse, validateParams } = require("@utils/responseUtil");
const businessFinanceService = require("../services/businessFinanceService");

const ANALYTICS_RANGES = ["7d", "30d", "90d", "1y"];
const REVENUE_RANGES = ["7d", "30d", "90d", "1y"];

const getAnalytics = async (req, res) => {
  const { range } = req.query;
  if (!validateParams(req, res, { enumFields: { range: ANALYTICS_RANGES } })) return;

  try {
    const result = await businessFinanceService.getAnalytics({ user: req.user, range });
    return sendResponse({ res, statusCode: 200, translationKey: "analytics_fetched", data: result });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "analytics_fetch_error", error });
  }
};

const getRevenue = async (req, res) => {
  const { range } = req.query;
  if (!validateParams(req, res, { enumFields: { range: REVENUE_RANGES } })) return;

  try {
    const result = await businessFinanceService.getRevenue({ user: req.user, range });
    return sendResponse({ res, statusCode: 200, translationKey: "revenue_fetched", data: result });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "revenue_fetch_error", error });
  }
};

const getRevenueClients = async (req, res) => {
  const { page, limit, keyword } = req.query;

  try {
    const result = await businessFinanceService.getRevenueClients({ user: req.user, page, limit, keyword });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "revenue_clients_fetched",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "revenue_clients_fetch_error", error });
  }
};

const getPayoutMethods = async (req, res) => {
  try {
    const result = await businessFinanceService.getPayoutMethods({ user: req.user });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "payout_methods_fetched", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "payout_methods_fetch_error", error });
  }
};

const addPayoutMethod = async (req, res) => {
  const { token, setDefault } = req.body;
  if (!validateParams(req, res, { rawData: ["token"] })) return;

  try {
    const result = await businessFinanceService.addPayoutMethod({ user: req.user, token, setDefault });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 201, translationKey: "payout_method_added", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "payout_method_add_error", error });
  }
};

const deletePayoutMethod = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["id"] })) return;

  try {
    const result = await businessFinanceService.deletePayoutMethod({ user: req.user, id: req.params.id });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "payout_method_deleted", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "payout_method_delete_error", error });
  }
};

const withdrawFunds = async (req, res) => {
  const { amount, payoutMethodId } = req.body;
  if (!validateParams(req, res, { rawData: ["amount", "payoutMethodId"] })) return;

  try {
    const result = await businessFinanceService.withdrawFunds({ user: req.user, amount, payoutMethodId });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "withdrawal_started", data: result.data });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "withdrawal_error", error });
  }
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
