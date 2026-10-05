const BusinessProfile = require("@models/BusinessProfile");

/**
 * The BusinessProfile id owned by the requesting user, whichever mode the
 * account is currently in.
 *
 * authMiddleware only sets req.user.businessId while the account is in
 * business mode, but a dual-role account browsing as a customer still owns its
 * listings — and createBooking refuses self-booking on either side. canBook
 * has to know about that, so it resolves the profile itself rather than
 * relying on the request's active mode.
 *
 * Ownership/authorization checks must keep using req.user.businessId: this is
 * deliberately "which business is this person", not "which business are they
 * acting as", and the two must not be confused.
 *
 * Returns null for guests, pure customers, and accounts with no profile.
 */
const getViewerBusinessId = async (req) => {
  if (req?.user?.businessId) return req.user.businessId;
  if (!req?.user?._id) return null;
  // The business role is granted on first switch/profile creation, so it's a
  // reliable way to skip the lookup for accounts that never had one.
  if (!req.user.roles?.includes("business")) return null;

  const profile = await BusinessProfile.findOne({ user: req.user._id }).select("_id").lean();
  return profile?._id || null;
};

module.exports = { getViewerBusinessId };
