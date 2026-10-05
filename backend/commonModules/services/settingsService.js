const jwt = require("jsonwebtoken");
const AdminSettings = require("@models/AdminSettings");
const Faq = require("@models/Faq");
const { LanguageCodes } = require("@models/Models");
const { User } = require("@models/UserModel");
const { userCache } = require("@config/nodeCache");

const DEFAULT_LANG = LanguageCodes.ENGLISH;
const acceptedLanguageCodes = Object.values(LanguageCodes);

const SETTING_FIELDS = ["terms_and_conditions", "about_us", "privacy_policy"];

const isValidSettingField = (field) => SETTING_FIELDS.includes(field);

const getLang = (req) => (acceptedLanguageCodes.includes(req.language) ? req.language : DEFAULT_LANG);

// Resolves an explicit language preference for public (unauthenticated) setting
// endpoints — x-language header wins, falling back to the caller's account
// language if a bearer token happens to be present. Returns null when neither
// source yields a valid language, which the caller treats as "no preference
// stated" (i.e. return every language instead of guessing one).
// useAccountLanguage:false skips the account-language fallback entirely — the
// admin-facing "give me everything" endpoints must not silently collapse to
// one language just because the admin happens to be logged in with a token;
// only an explicit x-language/?lang should ever narrow those.
const resolveExplicitLanguage = async (req, { useAccountLanguage = true } = {}) => {
  const headerLang = req.headers["x-language"] || req.headers.language || req.query.lang;
  if (acceptedLanguageCodes.includes(headerLang)) return headerLang;

  if (!useAccountLanguage) return null;

  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  try {
    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const cached = userCache.get(decoded._id);
    const userLang = cached?.language || (await User.findById(decoded._id).select("language"))?.language;
    return acceptedLanguageCodes.includes(userLang) ? userLang : null;
  } catch (_error) {
    return null; // invalid/expired token — language is just a hint here, not an auth gate
  }
};

const getTranslatedValue = (value = {}, lang = DEFAULT_LANG, fallback = DEFAULT_LANG) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[lang] || value[fallback] || "";
};

const formatFaq = (faq, lang) => ({
  _id: faq._id,
  question: getTranslatedValue(faq.question, lang),
  answer: getTranslatedValue(faq.answer, lang),
  createdAt: faq.createdAt,
  updatedAt: faq.updatedAt,
});

const buildFaqQuery = (keyword) => {
  if (!keyword?.trim()) return {};

  const regex = new RegExp(keyword.trim(), "i");

  return {
    $or: acceptedLanguageCodes.flatMap((lang) => [{ [`question.${lang}`]: regex }, { [`answer.${lang}`]: regex }]),
  };
};

const getFaqsData = async ({ page = 1, limit = 10, keyword, isAdmin = false, languageCode }) => {
  const query = buildFaqQuery(keyword);
  const lang = languageCode || DEFAULT_LANG;

  const [faqs, totalRecords] = await Promise.all([
    Faq.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Faq.countDocuments(query),
  ]);

  return {
    faqs: isAdmin && !languageCode ? faqs : faqs.map((faq) => formatFaq(faq, lang)),
    totalRecords,
  };
};

const createFaqData = ({ question, answer }) => Faq.create({ question, answer });

const updateFaqData = ({ id, question, answer }) =>
  Faq.findByIdAndUpdate(id, { ...(question && { question }), ...(answer && { answer }) }, { new: true });

const deleteFaqData = (id) => Faq.findByIdAndDelete(id);

const getSettingData = async ({ field, languageCode = null, raw = false }) => {
  if (!isValidSettingField(field)) {
    throw new Error("Invalid setting field");
  }

  const settings = await AdminSettings.findOne({}, field).lean();
  if (!settings) return null;

  // No explicit language (no x-language header, no logged-in user language) —
  // return every language instead of silently guessing English.
  if (raw || !languageCode) return settings;

  return {
    _id: settings._id,
    [field]: getTranslatedValue(settings[field], languageCode),
  };
};

const updateSettingData = async ({ field, value, languageCode }) => {
  if (!isValidSettingField(field)) {
    throw new Error("Invalid setting field");
  }

  const updatePath = languageCode ? `${field}.${languageCode}` : field;

  return AdminSettings.findOneAndUpdate({}, { $set: { [updatePath]: value } }, { new: true, upsert: true }).lean();
};

// Accepts any of SETTING_FIELDS in `body`. Each value may be an HTML string
// (stored under `languageCode`) or a per-language object of HTML strings.
const updateSettingsData = async ({ body = {}, languageCode = DEFAULT_LANG }) => {
  const updates = {};

  SETTING_FIELDS.forEach((field) => {
    const value = body[field];
    if (value === undefined || value === null) return;

    if (typeof value === "string") {
      updates[`${field}.${languageCode}`] = value;
    } else if (typeof value === "object") {
      Object.entries(value).forEach(([lang, text]) => {
        if (acceptedLanguageCodes.includes(lang) && typeof text === "string") {
          updates[`${field}.${lang}`] = text;
        }
      });
    }
  });

  if (Object.keys(updates).length === 0) return null;

  return AdminSettings.findOneAndUpdate({}, { $set: updates }, { new: true, upsert: true }).lean();
};

const deleteAdminSettingsData = (id) => AdminSettings.findByIdAndDelete(id);

module.exports = {
  DEFAULT_LANG,
  LanguageCodes,
  acceptedLanguageCodes,
  SETTING_FIELDS,

  getLang,
  getTranslatedValue,
  resolveExplicitLanguage,

  getFaqsData,
  createFaqData,
  updateFaqData,
  deleteFaqData,

  getSettingData,
  updateSettingData,
  updateSettingsData,
  deleteAdminSettingsData,
};
