const { i18nConfig } = require("@config/i18nConfig");
const { LanguageCodes } = require("@models/Models");

const checkLanguage = (req, res, next) => {
  req.language = req.headers["x-language"] || req.headers.language || req.query.lang || LanguageCodes.ENGLISH;
  if (!Object.values(LanguageCodes).includes(req.language)) {
    req.language = LanguageCodes.ENGLISH;
  }
  i18nConfig.setLocale(req, req.language);
  next();
};

module.exports = {
  checkLanguage,
};
