const { sendResponse } = require("@utils/responseUtil");
const { ImageInputError, resolveImageSource } = require("../services/imageSearch/imageInput");
const imageSearchService = require("../services/imageSearch/imageSearchService");

const KEYWORD_MAX = 100;

// POST /image-search — multipart `image` file, or JSON/form `imageUrl`
// (one of our own upload keys/URLs). Optional `keyword` refines the match;
// lat/lng, page, limit, categoryId and sortBy are read from the query string.
const searchByImage = async (req, res) => {
  try {
    const source = await resolveImageSource({ file: req.file, imageUrl: req.body?.imageUrl });
    const keyword = String(req.body?.keyword || req.query.keyword || "")
      .trim()
      .slice(0, KEYWORD_MAX);

    const { data, meta, imageAnalysis } = await imageSearchService.searchByImage({ source, keyword, req });
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "data_fetched_successfully",
      data: { ...data, imageAnalysis },
      meta,
    });
  } catch (error) {
    if (error instanceof ImageInputError) {
      return sendResponse({ res, statusCode: 400, translationKey: error.code });
    }
    console.error(error);
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = { searchByImage };
