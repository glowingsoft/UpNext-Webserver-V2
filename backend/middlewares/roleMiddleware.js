// middlewares/roleMiddleware.js
const { sendResponse } = require("@utils/responseUtil");
const roles = {
  admin: "admin",
  business: "business",
  staff: "staff",
  user: "user",
  guest: "guest",
};
const roleMiddleware = (allowedRoles) => (req, res, next) => {
  const userType = req.user?.userType;
  if (allowedRoles.includes(userType)) {
    next();
  } else {
    return sendResponse({
      res,
      statusCode: 403,
      translationKey: `Access denied. ${allowedRoles.join(" or ")} only.`,
      error: `Access denied. ${allowedRoles.join(" or ")} only.`,
    });
  }
};

module.exports = roleMiddleware;

//e.g usage app.use("/shared-route", roleMiddleware(["admin", "trainer"]), (req, res) => {
