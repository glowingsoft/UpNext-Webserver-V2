const { sendResponse, parsePaginationParams, generateMeta } = require("@utils/responseUtil");

const { DEFAULT_LANG, getLang, getSettingData, updateSettingsData, getFaqsData, resolveExplicitLanguage } = require("../services/settingsService");
const AdminSettings = require("@models/AdminSettings");

// defaultAll:false (app-facing) — no explicit language falls back to English,
// matching a single-language app client.
// defaultAll:true (admin-facing) — no explicit language returns every
// language, since the admin panel manages all of them at once.
const getSetting =
  (field, notFoundKey, successKey, { defaultAll = false } = {}) =>
  async (req, res) => {
    try {
      const explicitLanguage = await resolveExplicitLanguage(req, { useAccountLanguage: !defaultAll });
      const languageCode = explicitLanguage || (defaultAll ? null : DEFAULT_LANG);

      const data = await getSettingData({
        field,
        languageCode,
        raw: req.query.raw === "true",
      });

      if (!data) {
        return sendResponse({
          res,
          statusCode: 404,
          translationKey: notFoundKey,
        });
      }

      return sendResponse({
        res,
        statusCode: 200,
        translationKey: successKey,
        data,
      });
    } catch (error) {
      return sendResponse({
        res,
        statusCode: 500,
        translationKey: "something_went_wrong",
        error,
      });
    }
  };

const getTermsAndConditions = getSetting("terms_and_conditions", "terms_and", "terms_and_1");

const getAboutUs = getSetting("about_us", "about_us", "about_us_1");

const getPrivacyPolicy = getSetting("privacy_policy", "privacy_policy", "privacy_policy_1");

// Admin-panel variants: no explicit language => every language comes back
// instead of collapsing to English, since the admin manages all of them.
const getTermsAndConditionsAdmin = getSetting("terms_and_conditions", "terms_and", "terms_and_1", {
  defaultAll: true,
});

const getAboutUsAdmin = getSetting("about_us", "about_us", "about_us_1", { defaultAll: true });

const getPrivacyPolicyAdmin = getSetting("privacy_policy", "privacy_policy", "privacy_policy_1", {
  defaultAll: true,
});

const getFaqs = async (req, res) => {
  try {
    const { page, limit } = parsePaginationParams(req);
    const isAdmin = req.user?.userType === "admin";

    // Same resolution as terms/privacy/about-us/help-center: admins get every
    // language unless they explicitly ask for one (x-language or ?lang=);
    // app callers resolve to x-language, then their account language if
    // logged in, then English.
    const explicitLanguage = await resolveExplicitLanguage(req, { useAccountLanguage: !isAdmin });
    const languageCode = explicitLanguage || (isAdmin ? null : DEFAULT_LANG);

    const { faqs, totalRecords } = await getFaqsData({
      page,
      limit,
      keyword: req.query.keyword,
      languageCode,
      isAdmin,
    });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "Faqs fetched successfully",
      data: faqs,
      meta: generateMeta(page, limit, totalRecords),
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "something_went_wrong",
      error,
    });
  }
};

const updateAdminSettings = async (req, res) => {
  try {
    const data = await updateSettingsData({
      body: req.body,
      languageCode: getLang(req),
    });

    if (!data) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_setting_field",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "admin_settings_3",
      data,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message || "something_went_wrong",
      error,
    });
  }
};
const createAdminSettings = async (req, res) => {
  try {
    const exists = await AdminSettings.exists({});

    if (exists) {
      throw new Error("Admin settings already exist");
    }

    const settings = await AdminSettings.create(req.body);

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "admin_settings_1",
      data: settings,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: error.message,
      error,
    });
  }
};
module.exports = {
  getTermsAndConditions,
  getAboutUs,
  getPrivacyPolicy,
  getTermsAndConditionsAdmin,
  getAboutUsAdmin,
  getPrivacyPolicyAdmin,
  updateAdminSettings,
  getFaqs,
  createAdminSettings,
};
