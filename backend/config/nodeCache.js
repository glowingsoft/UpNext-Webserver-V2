const NodeCache = require("node-cache");

// Initialize node-cache with no TTL
const nodeCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

// Initialize a specific cache for user data with a TTL (e.g., 1 hour)
/*
stdTTL: 3600 ensures that each cached user is valid for 1 hour.
checkperiod: 120 ensures that expired data is removed every 2 minutes, keeping memory usage efficient without frequent database calls. 
 */
const userCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// Export the nodeCache instance
module.exports = { nodeCache, userCache };
