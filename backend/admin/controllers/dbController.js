// controllers/bulkInsertController.js
const { bulkInsert, deleteCollection } = require("@utils/dbUtils");
const { sendResponse } = require("@utils/responseUtil");

// Controller function to handle bulk insertion
const bulkInsertHandler = async (req, res) => {
  const { values, collectionName } = req.body;

  if (!values || !Array.isArray(values) || values.length === 0) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "values_array",
    });
  }

  if (!collectionName) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "collection_name",
    });
  }

  try {
    const result = await bulkInsert(values, collectionName);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: `Inserted ${result.length} documents into ${collectionName} collection`,
      data: result,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "error_during",
      error,
    });
  }
};

// Controller function to handle collection deletion
const deleteCollectionHandler = async (req, res) => {
  const { collectionName } = req.body;

  if (!collectionName) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "collection_name",
    });
  }

  try {
    const result = await deleteCollection(collectionName);
    return sendResponse({
      res,
      statusCode: 200,
      translationKey: `Deleted all documents from ${collectionName} collection`,
      data: result,
    });
  } catch (error) {
    console.error(error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "error_during_1",
      error,
    });
  }
};

module.exports = {
  deleteCollectionHandler,
  bulkInsertHandler,
};
