const { parsePaginationParams } = require("../helperUtils/responseUtil");

// Single Table Population
/**
 * Populates specified fields for a Mongoose model query with pagination and sorting.
 * @param {object} model - Mongoose model to query.
 * @param {object} query - Query conditions to filter the documents.
 * @param {Array<{path: string, select: string, alias: string}>} fieldsToPopulate - Array of fields to populate with their paths, select options, and aliases.
 * @param {object} [options={}] - Optional parameters for pagination and sorting.
 * @param {object} [options.sort={createdAt: -1}] - Sorting criteria for the query (default: { createdAt: -1 }).
 * @param {number} [options.page=1] - Page number for pagination (default: 1).
 * @param {number} [options.limit=10] - Number of documents per page for pagination (default: 10).
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of documents with populated fields.
 *
 * Example usage:
 * const fieldsToPopulate = [
 *   { path: 'userId', select: 'name email', alias: 'userDetails' },
 *   { path: 'groupId', select: 'name', alias: 'groupDetails' }
 * ];
 * const documents = await populateFields(ModelName, query, fieldsToPopulate, { page, limit });
 */
const populateFields = async (model, query, fieldsToPopulate, options = {}) => {
  const { sort = { createdAt: -1 }, page = 1, limit = 10 } = options;
  const skip = (page - 1) * limit;

  let populateQuery = model.find(query).sort(sort).skip(skip).limit(limit);

  fieldsToPopulate.forEach((field) => {
    populateQuery = populateQuery.populate(field.path, field.select);
  });

  const documents = await populateQuery.lean().exec();

  documents.forEach((doc) => {
    fieldsToPopulate.forEach((field) => {
      if (field.alias && doc[field.path]) {
        doc[field.alias] = doc[field.path];
        delete doc[field.path];
      }
    });
  });

  return documents;
};

// Multiple Tables Population
/**
 * Populates specified fields for multiple Mongoose models with pagination and sorting.
 * @param {Array<{model: object, query: object, fieldsToPopulate: Array<{path: string, select: string}>, options?: object}>} populationConfigs - Array of population configurations.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of results from each model population.
 *
 * Example usage:
 * const populationConfigs = [
 *   {
 *     model: UserModel,
 *     query: { status: 'active' },
 *     fieldsToPopulate: [{ path: 'profileId', select: 'avatar bio' }],
 *     options: { sort: { createdAt: -1 }, page: 1, limit: 5 }
 *   },
 *   {
 *     model: PostModel,
 *     query: { isPublished: true },
 *     fieldsToPopulate: [{ path: 'authorId', select: 'name' }],
 *     options: { sort: { createdAt: -1 }, page: 1, limit: 10 }
 *   }
 * ];
 * const results = await populateMultipleTables(populationConfigs);
 */
const populateMultipleTables = async (populationConfigs) => {
  const promises = populationConfigs.map((config) => {
    const { model, query, fieldsToPopulate, options = {} } = config;
    const { sort = { createdAt: -1 }, page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;

    let populateQuery = model.find(query).sort(sort).skip(skip).limit(limit);

    fieldsToPopulate.forEach((field) => {
      populateQuery = populateQuery.populate(field.path, field.select);
    });

    return populateQuery.lean().exec();
  });

  return Promise.all(promises);
};

// Nested Population
/**
 * Populates nested fields for a Mongoose model query with pagination and sorting.
 * @param {object} model - Mongoose model to query.
 * @param {object} query - Query conditions to filter the documents.
 * @param {Array<{path: string, select: string, populate: Array<{path: string, select: string}>}>} nestedFieldsToPopulate - Array of nested fields to populate.
 * @param {object} [options={}] - Optional parameters for pagination and sorting.
 * @param {object} [options.sort={createdAt: -1}] - Sorting criteria for the query (default: { createdAt: -1 }).
 * @param {number} [options.page=1] - Page number for pagination (default: 1).
 * @param {number} [options.limit=10] - Number of documents per page for pagination (default: 10).
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of documents with nested populated fields.
 *
 * Example usage:
 * const nestedFieldsToPopulate = [
 *   {
 *     path: 'authorId',
 *     select: 'name',
 *     populate: [{ path: 'profileId', select: 'avatar bio' }]
 *   }
 * ];
 * const documents = await populateNestedFields(ModelName, query, nestedFieldsToPopulate, { page, limit });
 */
const populateNestedFields = async (model, query, nestedFieldsToPopulate, options = {}) => {
  const { sort = { createdAt: -1 }, page = 1, limit = 10 } = options;
  const skip = (page - 1) * limit;

  let populateQuery = model.find(query).sort(sort).skip(skip).limit(limit);

  nestedFieldsToPopulate.forEach((field) => {
    populateQuery = populateQuery.populate({
      path: field.path,
      select: field.select,
      populate: field.populate,
    });
  });

  return populateQuery.lean().exec();
};

module.exports = {
  populateFields,
  populateMultipleTables,
  populateNestedFields,
};
