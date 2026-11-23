const mongoose = require("mongoose");
const AdminSettings = require("@models/AdminSettings");
const Dispute = require("@models/Dispute");
const ProviderPenalty = require("@models/ProviderPenalty");
const { sendResponse } = require("@utils/responseUtil");
const { getInstantSettings, mergeInstantSettings } = require("@utils/instantPricing");
const { buildInstantSettingsUpdate } = require("@utils/instantSettingsUpdate");
const { resolveNoShow } = require("../../app/services/instantBookingService");

const fail = (res, err) => {
  console.error("admin instant error:", err);
  return sendResponse({ res, statusCode: 500, translationKey: "server_error", error: err.message });
};

const getSettings = async (req, res) => {
  try {
    return sendResponse({ res, statusCode: 200, translationKey: "instant_settings", data: await getInstantSettings() });
  } catch (err) {
    return fail(res, err);
  }
};

const updateSettings = async (req, res) => {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await AdminSettings.findOne({}, "instant __v").lean();
      const result = buildInstantSettingsUpdate(req.body, mergeInstantSettings(doc?.instant));
      if (result.error) {
        return sendResponse({ res, statusCode: 400, translationKey: result.error, data: { field: result.field } });
      }
      if (!doc) {
        await AdminSettings.findOneAndUpdate({}, { $setOnInsert: {} }, { upsert: true, setDefaultsOnInsert: true });
        continue;
      }
      const version = doc.__v === undefined ? { $exists: false } : doc.__v;
      const updated = await AdminSettings.findOneAndUpdate(
        { _id: doc._id, __v: version },
        { $set: result.set, $inc: { __v: 1 } },
        { new: true, runValidators: true },
      ).lean();
      if (updated) {
        return sendResponse({ res, statusCode: 200, translationKey: "instant_settings", data: mergeInstantSettings(updated.instant) });
      }
    }
    return sendResponse({ res, statusCode: 409, translationKey: "instant_settings_conflict" });
  } catch (err) {
    return fail(res, err);
  }
};

const resolveNoShowHandler = async (req, res) => {
  const { id } = req.params;
  const { outcome, note } = req.body;
  if (!mongoose.isValidObjectId(id) || !["upheld", "overturned"].includes(outcome)) {
    return sendResponse({ res, statusCode: 400, translationKey: "invalid_request" });
  }
  try {
    const result = await resolveNoShow({ id, outcome, note });
    if (result.error) return sendResponse({ res, statusCode: result.status, translationKey: result.error });
    return sendResponse({ res, statusCode: 200, translationKey: "instant_no_show_resolved", data: result.data });
  } catch (err) {
    return fail(res, err);
  }
};

// Lost dispute + provider fault: amount + Stripe dispute fee become a payout deduction (once).
const setDisputeFault = async (req, res) => {
  const { id } = req.params;
  const { faultParty } = req.body;
  if (!mongoose.isValidObjectId(id) || !["provider", "client", "platform"].includes(faultParty)) {
    return sendResponse({ res, statusCode: 400, translationKey: "invalid_request" });
  }
  try {
    const dispute = await Dispute.findByIdAndUpdate(id, { $set: { faultParty } }, { new: true });
    if (!dispute) return sendResponse({ res, statusCode: 404, translationKey: "not_found" });
    const { recordDisputeDeduction } = require("../../services/stripeWebhook");
    await recordDisputeDeduction(dispute._id);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "instant_dispute_updated",
      data: await Dispute.findById(id).lean(),
    });
  } catch (err) {
    return fail(res, err);
  }
};

const listDisputes = async (req, res) => {
  try {
    const disputes = await Dispute.find().sort({ createdAt: -1 }).limit(100).lean();
    return sendResponse({ res, statusCode: 200, translationKey: "instant_disputes", data: disputes });
  } catch (err) {
    return fail(res, err);
  }
};

const listPenalties = async (req, res) => {
  try {
    const filter = mongoose.isValidObjectId(req.query.provider) ? { provider: req.query.provider } : {};
    const rows = await ProviderPenalty.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    return sendResponse({ res, statusCode: 200, translationKey: "instant_penalties", data: rows });
  } catch (err) {
    return fail(res, err);
  }
};

module.exports = { getSettings, updateSettings, resolveNoShowHandler, setDisputeFault, listDisputes, listPenalties };
