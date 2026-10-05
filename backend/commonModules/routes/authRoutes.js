const express = require("express");
const auth = require("../../middlewares/authMiddleware");

const {
  register,
  login,
  generateOtp,
  resetPassword,
  changePassword,
  verifyOtp,
  verifyLoginOtp,
  logout,
  deleteAccount,
  socialAuth,
  refreshAccessToken,
} = require("../controllers/authController");
const createRateLimiter = require("@utils/rateLimiter");

const router = express.Router();
// Create a rate limiter for signup routes
// Define rate limiters
const signupRateLimiter = createRateLimiter("register", 15, 15); // 15 requests per 15 minutes
const loginRateLimiter = createRateLimiter("login", 15, 15); // 15 requests per 15 minute
const generateOtpRateLimiter = createRateLimiter("forgotPassword", 15, 15); // 15 requests per 15 minutes
const resendOtpRateLimiter = createRateLimiter("resendOtp", 15, 15); // 15 requests per 15 minutes
const verifyOtpRateLimiter = createRateLimiter("verifyOtp", 15, 15); // 10 requests per 10 minutes

const resetPasswordRateLimiter = createRateLimiter("resetPassword", 15, 15); // 15 requests per 15 minutes
const refreshTokenRateLimiter = createRateLimiter("refreshToken", 30, 15); // 30 requests per 15 minutes

// Apply rate limiters to routes
router.post("/register", signupRateLimiter, register);
router.post("/login", loginRateLimiter, login);
router.post("/login/verify-otp", loginRateLimiter, verifyLoginOtp);
router.post("/forgot-password", generateOtpRateLimiter, (req, res, next) => {
  req.body.type = "email";
  generateOtp(req, res, next);
});
router.post("/resend-otp/email", resendOtpRateLimiter, (req, res, next) => {
  req.body.type = "email";
  generateOtp(req, res, next);
});
router.post("/resend-otp/phone", resendOtpRateLimiter, (req, res, next) => {
  req.body.type = "phoneNumber";
  generateOtp(req, res, next);
});
router.post("/verify-otp/email", verifyOtpRateLimiter, (req, res, next) => {
  req.body.type = "email";
  verifyOtp(req, res, next);
});
router.post("/verify-otp/phone", verifyOtpRateLimiter, (req, res, next) => {
  req.body.type = "phoneNumber";
  verifyOtp(req, res, next);
});
router.post("/reset-password", resetPasswordRateLimiter, resetPassword);
router.post("/change-password", auth, resetPasswordRateLimiter, changePassword);

router.post("/refresh-token", refreshTokenRateLimiter, refreshAccessToken);

router.post("/logout", auth, logout);
router.delete("/delete-account", auth, deleteAccount);
router.post("/social-auth", socialAuth);

module.exports = router;
