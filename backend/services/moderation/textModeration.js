let filter;

async function initTextModeration() {
  const { Filter } = await import("bad-words");
  filter = new Filter();
}

/**
 * Extract string values recursively
 */
function extractStrings(obj, results = []) {
  if (!obj) return results;

  if (typeof obj === "string") {
    results.push(obj);
    return results;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStrings(item, results);
    }
    return results;
  }

  if (typeof obj === "object" && obj.constructor === Object) {
    for (const key of Object.keys(obj)) {
      extractStrings(obj[key], results);
    }
  }

  return results;
}

function textModerationMiddleware(req, res, next) {

  /**
   * 🚫 Skip moderation for excluded routes
   */
  const excludedRoutes = [
    "/api/v1/app/payments/cards",
    "/api/v1/webhooks"
  ];

  if (excludedRoutes.some(route => req.originalUrl.startsWith(route))) {
    return next();
  }

  /**
   * Only apply to write operations
   */
  if (!["POST", "PUT", "PATCH"].includes(req.method)) {
    return next();
  }

  /**
   * Safety guard
   */
  if (!filter) {
    return next();
  }

  if (!req.body || typeof req.body !== "object") {
    return next();
  }

  const strings = extractStrings(req.body);

  for (const text of strings) {
    if (typeof text !== "string") continue;

    if (filter.isProfane(text)) {
      return res.status(400).json({
        message: "Inappropriate language detected",
      });
    }
  }

  next();
}

module.exports = {
  textModerationMiddleware,
  initTextModeration,
};