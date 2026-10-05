const mongoose = require("mongoose");
const crypto = require("crypto");

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    deviceId: { type: String, default: null },
    deviceType: { type: String, enum: ["android", "ios", "web"], default: null },
    sessionId: { type: String, required: true, unique: true },
    refreshToken: { type: String, required: true, unique: true },
    refreshTokenExpiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

const Session = mongoose.model("Session", sessionSchema);

// Issues a new revocable session (short-lived access token id + long-lived refresh
// token). Logging in again on the same deviceId replaces that device's previous
// session, so its old token stops working.
const createSession = async ({ userId, deviceId = null, deviceType = null }) => {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const refreshToken = crypto.randomBytes(32).toString("hex");
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  if (deviceId) {
    await Session.deleteMany({ userId, deviceId });
  }

  await Session.create({ userId, deviceId, deviceType, sessionId, refreshToken, refreshTokenExpiresAt });

  return { sessionId, refreshToken };
};

// Exchanges a still-valid refresh token for a new access-token session.
// Rotates the refresh token on each use, so a stolen/replayed old one stops working.
const renewSession = async ({ refreshToken }) => {
  const existing = await Session.findOne({
    refreshToken,
    refreshTokenExpiresAt: { $gt: new Date() },
  });
  if (!existing) return null;

  existing.sessionId = crypto.randomBytes(24).toString("hex");
  existing.refreshToken = crypto.randomBytes(32).toString("hex");
  existing.refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await existing.save();

  return {
    userId: existing.userId,
    sessionId: existing.sessionId,
    refreshToken: existing.refreshToken,
    deviceType: existing.deviceType,
  };
};

// Logs out a single device — its token stops working immediately.
const revokeSession = async ({ userId, deviceId }) => {
  await Session.deleteMany({ userId, deviceId });
};

// Logs out every session for a user, optionally sparing one
// (used by change-password to keep the calling device logged in).
const revokeAllSessions = async ({ userId, exceptSessionId = null }) => {
  const filter = { userId };
  if (exceptSessionId) {
    filter.sessionId = { $ne: exceptSessionId };
  }
  await Session.deleteMany(filter);
};

const isSessionValid = async ({ userId, sessionId }) => {
  if (!sessionId) return false;
  const exists = await Session.exists({ userId, sessionId });
  return !!exists;
};

module.exports = {
  Session,
  createSession,
  renewSession,
  revokeSession,
  revokeAllSessions,
  isSessionValid,
};
