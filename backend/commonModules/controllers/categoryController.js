const Category = require("../../models/Category");
const { sendResponse, validateParams, cleanfiles } = require("../../helperUtils/responseUtil");
const { default: mongoose } = require("mongoose");
const { paginationPipeline, categoryPipeline, finalRes } = require("@utils/aggregationHelper");

const CATEGORY_SCOPES = Category.schema.path("scope").enumValues;

/**
 * Counts for the scope tabs, built from the same filter the list uses minus
 * its own scope — picking a tab must not change the numbers on the tabs, while
 * a keyword (or the admin's status filter) narrows all of them together.
 * Zero-filled from the schema enum so an empty tab still renders, with "all"
 * first, matching meta.statusList on the customers/businesses lists.
 *
 * Runs the list's own pipeline so the counts inherit its two quirks for free:
 * only parent categories are counted, and a keyword matching a sub-category
 * counts its parent.
 */
const countCategoryScopes = async ({ filter = {}, req = {} }) => {
  const baseFilter = { ...filter };
  delete baseFilter.scope;

  const counts = await Category.aggregate([
    { $match: baseFilter },
    ...categoryPipeline({ keyword: req?.query?.keyword }),
    { $group: { _id: "$scope", count: { $sum: 1 } } },
  ]);

  const scopeList = { all: 0 };
  CATEGORY_SCOPES.forEach((scope) => {
    scopeList[scope] = 0;
  });
  counts.forEach(({ _id, count }) => {
    scopeList.all += count;
    if (_id in scopeList) scopeList[_id] += count;
  });

  return scopeList;
};

// Helper function to handle pagination and population
const getCategories = async ({ filter = {}, req = {} }) => {
  const { keyword, page, limit, tags } = req?.query || {};
  const pipeline = [{ $match: filter }];

  pipeline.push(
    ...categoryPipeline({
      keyword,
    }),
  );
  // if (tags && tags === "true") {
  //   pipeline.push({
  //     $lookup: {
  //       from: "tags",
  //       localField: "_id",
  //       foreignField: "category",
  //       pipeline: [{ $project: { _id: 1, name: 1, status: 1, scope: 1 } }],
  //       as: "tags",
  //     },
  //   });
  // }
  pipeline.push({ $sort: { sortOrder: 1 } });

  page && limit && pipeline.push(paginationPipeline({ page, limit }));

  const res = await Category.aggregate(pipeline);
  const { data, meta } = finalRes({ page, limit, data: res }) || {};
  formatCategoryResponse({ req, categories: data });
  return {
    meta,
    data,
  };
};

// Create a new category
const createCategory = async (req, res) => {
  const user = req.user;

  const { name, translations, icon, color, parent, sortOrder, scope } = req.body;

  const validationOptions = {
    rawData: ["name", "translations", "scope"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    const category = new Category({
      name: String(name).trim(),
      translations,
      icon: cleanfiles(icon),
      color,
      parent: parent || null,
      sortOrder,
      scope,
    });

    await category.save();

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "category_created",
      data: category,
    });
  } catch (error) {
    const statusCode = error.name === "ValidationError" ? 400 : 500;
    const translationKey =
      error.name === "ValidationError" ? Object.values(error.errors)[0].message : "internal_server";

    return sendResponse({
      res,
      statusCode,
      translationKey,
      error,
    });
  }
};

const updateCategory = async (req, res) => {
  const { categoryId } = req.params;

  try {
    const updates = {};

    if (req.body.name !== undefined) {
      updates.name = String(req.body.name).trim();
    }

    if (req.body.translations !== undefined) {
      updates.translations = req.body.translations;
    }

    if (req.body.icon !== undefined) {
      updates.icon = cleanfiles(req.body.icon);
    }

    if (req.body.color !== undefined) {
      updates.color = req.body.color;
    }

    if (req.body.parent !== undefined) {
      updates.parent = req.body.parent || null;
    }

    if (req.body.sortOrder !== undefined) {
      updates.sortOrder = Number(req.body.sortOrder) || 0;
    }

    if (req.body.status !== undefined) {
      updates.status = req.body.status;
    }
    updates.updatedBy = req.user?._id || null;

    const updated = await Category.findByIdAndUpdate(categoryId, { $set: updates }, { new: true, runValidators: true });

    if (!updated) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "category_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "category_updated_successfully",
      data: updated,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "failed_to_update_category",
      error,
    });
  }
};

const deleteCategory = async (req, res) => {
  const { categoryId } = req.params;

  try {
    const hasChildren = await Category.exists({ parent: categoryId });

    if (hasChildren) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "cannot_delete_category_with_children",
      });
    }

    const deleted = await Category.findByIdAndDelete(categoryId);

    if (!deleted) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "category_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "category_deleted_successfully",
      data: { _id: categoryId },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "failed_to_delete_category",
      error,
    });
  }
};

// Get single category
const getSingleCategory = async (req, res) => {
  const { categoryId } = req.params;

  try {
    const resp = await getCategories({
      filter: { _id: new mongoose.Types.ObjectId(categoryId) },
    });

    const category = resp?.data?.[0];

    if (!category) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "category_not_found",
      });
    }

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "category_fetched_successfully",
      data: category,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

// Get all categories with pagination and aggregation
const getAllCategories = async (req, res) => {
  try {
    const user = req.user;
    const filter = {};
    const { status, scope } = req.query;
    // authMiddleware flattens userType onto req.user and deletes accountState,
    // so reading it back off accountState was always undefined — every caller,
    // admin included, fell into the non-admin branch and had ?status= ignored.
    // Same field roleMiddleware checks. Undefined on the unauthenticated
    // /app/public/categories mount, which correctly keeps the active-only rule.
    if (user?.userType !== "admin") {
      // Non-admins can only ever see active categories — status query is admin-only
      filter.status = "active";
    } else if (status === "active" || status === "inactive") {
      filter.status = status;
    }
    if (scope) {
      filter.scope = scope;
    }
    const [{ data, meta }, scopeList] = await Promise.all([
      getCategories({ req, filter }),
      countCategoryScopes({ req, filter }),
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "categories_fetched_successfully",
      data,
      meta: { ...meta, scopeList },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

const formatCategoryResponse = ({ req, categories }) => {
  const lng = req.language;
  if (!lng || !categories) return;
  const list = Array.isArray(categories) ? categories : [categories];

  list.forEach((category) => {
    category.name = category.translations?.[lng] ?? category.name;
    const subCategories = category.subCategories || [];
    subCategories.forEach((sub) => {
      sub.name = sub.translations?.[lng] ?? sub.name;
    });
  });
};

module.exports = {
  createCategory,
  updateCategory,
  deleteCategory,
  getSingleCategory,
  getAllCategories,
  getCategories,
};
