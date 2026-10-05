const Language = require("@models/Language");
const { User } = require("@models/UserModel");
const {
  sendResponse,
  parsePaginationParams,
  generateMeta,
  validateParams,
} = require("@utils/responseUtil");
const { userCache } = require("@config/nodeCache");

// Create a new language
const createLanguage = async (req, res) => {
  const { title, transliteration, flag, code } = req.body;

  try {
    //validate params
    const validationOptions = {
      rawData: ["title", "transliteration", "code"],
    };

    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    const language = new Language({ title, transliteration, flag, code });
    await language.save();

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "language_created_success", // Translation key for success
      data: language,
    });
  } catch (error) {
    if (error.code === 11000) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "language_code_unique_violation", // Custom translation key for duplicate language code
        error,
      });
    }
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error.message,
    });
  }
};

// Get all languages with pagination
const getLanguages = async (req, res) => {
  const { page, limit } = parsePaginationParams(req);

  try {
    const [languages, totalLanguages] = await Promise.all([
      Language.find({ active: true })
        .sort({ title: 1 }) // Sort by title in alphabetical order
        .skip((page - 1) * limit)
        .limit(limit),
      Language.countDocuments({ active: true }),
    ]);

    const meta = generateMeta(page, limit, totalLanguages);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "languages_fetched_success", // Translation key for success
      data: languages,
      meta,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error.message,
    });
  }
};

// Update an existing language
const updateLanguage = async (req, res) => {
  const { id } = req.params;
  const { title, transliteration, flag, code, active } = req.body;
  try {

    const validationOptions = {
      pathParams: ["id"],
      objectIdFields: ["id"],
    };

    if (!validateParams(req, res, validationOptions)) {
      return;
    }
    const language = await Language.findById(id);
    if (!language) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "language_not_found",
      });
    }

    language.title = title || language.title;
    language.transliteration = transliteration || language.transliteration;
    language.flag = flag || language.flag;
    language.code = code || language.code;
    if (active !== undefined) {
      language.active = active;
    }

    await language.save();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "language_updated_success",
      data: language,
    });
  } catch (error) {
    // Handle validation errors from Mongoose
    const statusCode = error.name === "ValidationError" ? 400 : 500;
    const translationKey =
      error.name === "ValidationError"
        ? Object.values(error.errors)[0].message
        : error.message;

    return sendResponse({
      res,
      statusCode,
      translationKey,
      error,
    });
  }
};

// Delete a language by ID
const deleteLanguage = async (req, res) => {
  const { id } = req.params;

  try {

    const validationOptions = {
      pathParams: ["id"],
      objectIdFields: ["id"],
    };

    if (!validateParams(req, res, validationOptions)) {
      return;
    }
    const language = await Language.findById(id);
    if (!language) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "language_not_found",
      });
    }

    await language.deleteOne();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "language_deleted_success",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error.message,
    });
  }
};

// Update a user's preferred language
const updateUserLanguage = async (req, res) => {
  const { _id: userId } = req.user;
  const { languageId } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not_found",
      });
    }

    const language = await Language.findById(languageId);
    if (!language) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "language_not_found",
      });
    }

    user.language = language.code;
    await user.save();
    userCache.del(userId.toString())
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "user_language_updated_success",
      data: { userId, code: language.code },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error.message,
    });
  }
};

module.exports = {
  createLanguage,
  getLanguages,
  updateLanguage,
  deleteLanguage,
  updateUserLanguage,
};
