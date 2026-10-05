// helperUtils/profileFlagsUtil.js
//
// accountState.hasUserProfile/hasBusinessProfile are denormalized: no controller
// that creates or deletes a profile writes them. They are resolved from the
// profile collections here instead, so both the authenticated path
// (authMiddleware, on every request) and the token-issuing entry points that
// never run it (login, social login, OTP verification, password reset) report
// what the account actually owns rather than what was last persisted.

const { User } = require("@models/UserModel");
const { UserProfile } = require("@models/UserProfile");
const BusinessProfile = require("@models/BusinessProfile");

// Both profiles are looked up regardless of the account's active mode, because
// the flags describe the whole account, not the mode it happens to be in.
// `prefetched` lets a caller that already loaded the two documents reuse them
// instead of paying for the lookups twice.
const resolveProfileFlags = async (userId, prefetched = null) => {
  const [userProfile, businessProfile] =
    prefetched ||
    (await Promise.all([
      UserProfile.findOne({ user: userId }).select("_id"),
      BusinessProfile.findOne({ user: userId }).select("_id"),
    ]));

  return {
    hasUserProfile: Boolean(userProfile),
    hasBusinessProfile: Boolean(businessProfile),
  };
};

// Fire-and-forget: a failed write costs a stale flag until the next request
// that syncs, never the request in flight.
const persistProfileFlags = (userId, flags) =>
  User.updateOne(
    { _id: userId },
    {
      $set: {
        "accountState.hasUserProfile": flags.hasUserProfile,
        "accountState.hasBusinessProfile": flags.hasBusinessProfile,
      },
    },
  ).catch((err) => console.error(`profile flag sync failed for ${userId}:`, err.message));

// Corrects the flags on a user document in place — formatUserResponse reads
// accountState, so this is what makes a login response authoritative — and
// persists the correction only when it drifted. Pass persist: false when the
// caller saves the document itself (inside a transaction, say) so the same
// change isn't written twice.
const syncProfileFlags = async (user, { prefetched = null, persist = true } = {}) => {
  const flags = await resolveProfileFlags(user._id, prefetched);

  if (!user.accountState) {
    return flags;
  }

  const drifted =
    Boolean(user.accountState.hasUserProfile) !== flags.hasUserProfile ||
    Boolean(user.accountState.hasBusinessProfile) !== flags.hasBusinessProfile;

  if (drifted) {
    user.accountState.hasUserProfile = flags.hasUserProfile;
    user.accountState.hasBusinessProfile = flags.hasBusinessProfile;

    if (persist) {
      persistProfileFlags(user._id, flags);
    }
  }

  return flags;
};

module.exports = {
  resolveProfileFlags,
  persistProfileFlags,
  syncProfileFlags,
};
