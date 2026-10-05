// helperUtils/dbUtils.js
const mongoose = require('mongoose');

// Utility function to insert multiple documents into a specified collection
const bulkInsert = async (values, collectionName) => {
    try {
        // Dynamically get the Mongoose model based on the collection name
        const Model = mongoose.model(collectionName);

        // Insert documents in bulk
        const result = await Model.insertMany(values);
        console.log(`Inserted ${result.length} documents into ${collectionName} collection`);
        return result;
    } catch (error) {
        console.error(`Error inserting documents into ${collectionName} collection:`, error);
        throw error;
    }
};


const deleteCollection = async (collectionName) => {
    const Model = mongoose.model(collectionName);
    const result = await Model.deleteMany({});
    return result;
};

const fetchValuesByRefIds = async (Model, refIds) => {
    const items = await Model.find({ _id: { $in: refIds } });
    return items;
  };
  
module.exports = {
    bulkInsert,
    deleteCollection,
    fetchValuesByRefIds
};