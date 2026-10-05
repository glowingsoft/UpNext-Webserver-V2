// utils/rateLimiter.js
const rateLimit = require("express-rate-limit");
const { sendResponse } = require("./responseUtil");

/**
 * Create a rate limiter middleware for Express routes.
 * @param {string} endpoint - The name of the endpoint (for logging purposes).
 * @param {number} [timeWindow=15] - The time window in minutes.
 * @param {number} [maxRequests=5] - The maximum number of requests allowed.
 * @returns {Function} Express middleware function for rate limiting.
 */
function createRateLimiter(endpoint, timeWindow = 10, maxRequests = 15) {
    return (req, res, next) => next();
  // Check if the environment is development
  // if (process.env.NODE_ENV === "dev") {
  //   // Return a no-op middleware that does nothing
  //   return (req, res, next) => next();
  // }
  // return rateLimit({
  //   windowMs: timeWindow * 60 * 1000, // Convert timeWindow to milliseconds
  //   max: maxRequests, // Limit each IP to maxRequests per windowMs
  //   handler: (req, res, next, options) => {
  //     return sendResponse({
  //       res,
  //       statusCode: 429,
  //       translationKey: `Too many requests to ${endpoint}. Please try again later.`,
  //       error: true
  //     });
  //   },
  // });
}

module.exports = createRateLimiter;
