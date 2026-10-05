const { Tag, TagStatuses } = require("@models/Tag");
const Category = require("@models/Category");
const BusinessProfile = require("@models/BusinessProfile");
const { sendResponse, validateParams, parsePaginationParams, generateMeta } = require("@utils/responseUtil");
const { safeKeyword, escapeRegExp } = require("@helperUtils/regexUtil");
const { paginationPipeline, finalRes } = require("@utils/aggregationHelper");
const { default: mongoose } = require("mongoose");

const TAG_STATUSES = Object.values(TagStatuses);
const cleanName = (name) => String(name || "").trim();
const activeCategory = (categoryId) => Category.findOne({ _id: categoryId, status: { $ne: "deleted" } });

const duplicateTag = ({ category, name, excludeId }) => {
  const filter = {
    category,
    name: { $regex: `^${safeKeyword(name)}$`, $options: "i" },
    status: { $ne: TagStatuses.DELETED },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Tag.exists(filter);
};

const getTags = async (req, res) => {
  const { keyword, status, category } = req.query;

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);

  try {
    const matchStage = {};
    if (status || req.user.userType !== "admin") {
      matchStage.status = status || TagStatuses.ACTIVE;
    }
    if (category) {
      const categoryIds = (Array.isArray(category) ? category : [category])
        .flatMap((value) => String(value).split(/,2c|,/i))
        .map((id) => id.trim())
        .filter(Boolean);
      if (categoryIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_object_ids",
          values: { fields: "category" },
        });
      }
      matchStage.category = { $in: categoryIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    if (keyword && keyword.trim()) {
      matchStage.name = {
        $regex: escapeRegExp(keyword.trim()),
        $options: "i",
      };
    }

    const pipeline = [
      { $match: matchStage },

      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },

      {
        $unwind: {
          path: "$category",
          preserveNullAndEmptyArrays: true,
        },
      },

      { $sort: { sortOrder: 1, name: 1 } },

      {
        $project: {
          _id: 1,
          name: 1,
          status: 1,
          sortOrder: 1,
          category: {
            _id: "$category._id",
            name: "$category.name",
            status: "$category.status",
          },
        },
      },

      paginationPipeline({ page, limit }),
    ];

    const result = await Tag.aggregate(pipeline);

    const { data, meta } =
      finalRes({
        page,
        limit,
        data: result,
      }) || {};

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "tags_fetched_successfully",
      data,
      meta,
    });
  } catch (error) {
    console.error("getTags error:", error);

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "tags_fetch_error",
      error,
    });
  }
};

const getTag = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["tagId"], objectIdFields: ["tagId"] })) return;
  try {
    const tag = await Tag.findById(req.params.tagId).populate("category", "name status").lean();
    if (!tag) return sendResponse({ res, statusCode: 404, translationKey: "tag_not_found" });
    return sendResponse({ res, statusCode: 200, translationKey: "tag_fetched_successfully", data: tag });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

const createTag = async (req, res) => {
  if (
    !validateParams(req, res, {
      rawData: ["name"],
      formFields: ["category"],
      objectIdFields: ["category"],
      enumFields: { status: TAG_STATUSES },
    })
  )
    return;
  try {
    const name = cleanName(req.body.name);
    if (!name) return sendResponse({ res, statusCode: 400, translationKey: "tag_name_required" });
    if (!(await activeCategory(req.body.category)))
      return sendResponse({ res, statusCode: 404, translationKey: "category_not_found" });
    if (await duplicateTag({ category: req.body.category, name }))
      return sendResponse({ res, statusCode: 400, translationKey: "tag_already_exists" });
    const tag = await Tag.create({
      category: req.body.category,
      name,
      status: req.body.status,
      sortOrder: req.body.sortOrder,
    });
    return sendResponse({ res, statusCode: 201, translationKey: "tag_created_successfully", data: tag });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: error.name === "ValidationError" ? 400 : 500,
      translationKey: "tag_create_error",
      error,
    });
  }
};

const updateTag = async (req, res) => {
  if (
    !validateParams(req, res, {
      pathParams: ["tagId"],
      objectIdFields: ["tagId", "category"],
      enumFields: { status: TAG_STATUSES },
    })
  )
    return;
  try {
    const tag = await Tag.findById(req.params.tagId);
    if (!tag) return sendResponse({ res, statusCode: 404, translationKey: "tag_not_found" });
    const category = req.body.category ?? tag.category;
    const name = req.body.name === undefined ? tag.name : cleanName(req.body.name);
    if (!name) return sendResponse({ res, statusCode: 400, translationKey: "tag_name_required" });
    if (req.body.category !== undefined && !(await activeCategory(category)))
      return sendResponse({ res, statusCode: 404, translationKey: "category_not_found" });
    if (await duplicateTag({ category, name, excludeId: tag._id }))
      return sendResponse({ res, statusCode: 400, translationKey: "tag_already_exists" });
    if (req.body.category !== undefined) tag.category = category;
    if (req.body.name !== undefined) tag.name = name;
    if (req.body.status !== undefined) tag.status = req.body.status;
    if (req.body.sortOrder !== undefined) tag.sortOrder = Number(req.body.sortOrder) || 0;
    await tag.save();
    return sendResponse({ res, statusCode: 200, translationKey: "tag_updated_successfully", data: tag });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "tag_update_error", error });
  }
};

const deleteTag = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["tagId"], objectIdFields: ["tagId"] })) return;
  try {
    const tag = await Tag.findById(req.params.tagId);
    if (!tag) return sendResponse({ res, statusCode: 404, translationKey: "tag_not_found" });
    if (await BusinessProfile.exists({ "tags._id": tag._id }))
      return sendResponse({ res, statusCode: 400, translationKey: "tag_in_use" });
    await tag.deleteOne();
    return sendResponse({ res, statusCode: 200, translationKey: "tag_deleted_successfully", data: { _id: tag._id } });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "tag_delete_error", error });
  }
};

module.exports = { getTags, getTag, createTag, updateTag, deleteTag };
