const HelpCenter = require("@models/HelpCenter");
const {
  sendResponse,
  parsePaginationParams,
  generateMeta,
  validateParams,
  cleanfiles,
} = require("@utils/responseUtil");
const {
  DEFAULT_LANG,
  acceptedLanguageCodes,
  getTranslatedValue,
  resolveExplicitLanguage,
} = require("../services/settingsService");
const { getFullImageUrl } = require("@utils/imageHelper");

const formatItem = (item, lang) => ({
  _id: item._id,
  title: getTranslatedValue(item.title, lang),
  description: getTranslatedValue(item.description, lang),
  coverImage: getFullImageUrl(item.coverImage),
  status: item.status,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const buildKeywordQuery = (keyword) => {
  if (!keyword?.trim()) return {};
  const regex = new RegExp(keyword.trim(), "i");
  return {
    $or: acceptedLanguageCodes.flatMap((lang) => [{ [`title.${lang}`]: regex }, { [`description.${lang}`]: regex }]),
  };
};

// ─── Admin: list — always every language ────────────────────────────
const getHelpCenterItemsAdmin = async (req, res) => {
  try {
    const { page, limit } = parsePaginationParams(req);
    const { keyword, status } = req.query;

    const query = { ...buildKeywordQuery(keyword) };
    if (status) query.status = status;

    const [items, totalRecords] = await Promise.all([
      HelpCenter.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      HelpCenter.countDocuments(query),
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "help_center_fetched",
      data: items,
      meta: generateMeta(page, limit, totalRecords),
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Admin: single — always every language ──────────────────────────
const getHelpCenterItemAdmin = async (req, res) => {
  const { id } = req.params;
  const validationOptions = { pathParams: ["id"], objectIdFields: ["id"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const item = await HelpCenter.findById(id).lean();
    if (!item) {
      return sendResponse({ res, statusCode: 404, translationKey: "help_center_not_found" });
    }
    return sendResponse({ res, statusCode: 200, translationKey: "help_center_fetched", data: item });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Public: list — resolved to one language (x-language header, then
// the caller's account language if logged in, then English) ─────────
const getHelpCenterItems = async (req, res) => {
  try {
    const { page, limit } = parsePaginationParams(req);
    const { keyword } = req.query;
    const lang = (await resolveExplicitLanguage(req)) || DEFAULT_LANG;

    const query = { ...buildKeywordQuery(keyword), status: "active" };

    const [items, totalRecords] = await Promise.all([
      HelpCenter.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      HelpCenter.countDocuments(query),
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "help_center_fetched",
      data: items.map((item) => formatItem(item, lang)),
      meta: generateMeta(page, limit, totalRecords),
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Public: single — resolved to one language ──────────────────────
const getHelpCenterItem = async (req, res) => {
  const { id } = req.params;
  const validationOptions = { pathParams: ["id"], objectIdFields: ["id"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const lang = (await resolveExplicitLanguage(req)) || DEFAULT_LANG;
    const item = await HelpCenter.findOne({ _id: id, status: "active" }).lean();
    if (!item) {
      return sendResponse({ res, statusCode: 404, translationKey: "help_center_not_found" });
    }
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "help_center_fetched",
      data: formatItem(item, lang),
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Admin: create ───────────────────────────────────────────────────
const createHelpCenterItem = async (req, res) => {
  const { title, description, coverImage, status } = req.body;

  const validationOptions = {
    rawData: ["title", "description"],
    enumFields: { status: ["active", "inactive"] },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const item = await HelpCenter.create({
      title,
      description,
      ...(coverImage && { coverImage: cleanfiles(coverImage) }),
      ...(status && { status }),
    });

    return sendResponse({ res, statusCode: 201, translationKey: "help_center_created", data: item });
  } catch (error) {
    const statusCode = error.name === "ValidationError" ? 400 : 500;
    return sendResponse({ res, statusCode, translationKey: "internal_server", error });
  }
};

// ─── Admin: update ───────────────────────────────────────────────────
const updateHelpCenterItem = async (req, res) => {
  const { id } = req.params;
  const { title, description, coverImage, status } = req.body;

  const validationOptions = {
    pathParams: ["id"],
    objectIdFields: ["id"],
    enumFields: { status: ["active", "inactive"] },
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const item = await HelpCenter.findById(id);
    if (!item) {
      return sendResponse({ res, statusCode: 404, translationKey: "help_center_not_found" });
    }

    if (title) item.title = title;
    if (description) item.description = description;
    if (coverImage) item.coverImage = cleanfiles(coverImage);
    if (status) item.status = status;

    await item.save();

    return sendResponse({ res, statusCode: 200, translationKey: "help_center_updated", data: item });
  } catch (error) {
    const statusCode = error.name === "ValidationError" ? 400 : 500;
    return sendResponse({ res, statusCode, translationKey: "internal_server", error });
  }
};

// ─── Admin: delete ───────────────────────────────────────────────────
const deleteHelpCenterItem = async (req, res) => {
  const { id } = req.params;

  const validationOptions = { pathParams: ["id"], objectIdFields: ["id"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const item = await HelpCenter.findById(id);
    if (!item) {
      return sendResponse({ res, statusCode: 404, translationKey: "help_center_not_found" });
    }

    await item.deleteOne();

    return sendResponse({ res, statusCode: 200, translationKey: "help_center_deleted" });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = {
  getHelpCenterItems,
  getHelpCenterItem,
  getHelpCenterItemsAdmin,
  getHelpCenterItemAdmin,
  createHelpCenterItem,
  updateHelpCenterItem,
  deleteHelpCenterItem,
};
