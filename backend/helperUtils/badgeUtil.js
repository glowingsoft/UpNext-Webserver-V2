const { default: mongoose } = require("mongoose");
const { Badge, BadgeStatuses } = require("@models/Badge");

// Validates a { badgeId, optionId } badge-option reference (e.g. preferredServiceType).
// Returns a translationKey string on failure, or null when the reference is valid.
const validateBadgeOptionRef = async (ref) => {
  if (!ref?.badgeId || !ref?.optionId) return "invalid_badge_payload";

  if (!mongoose.isValidObjectId(ref.badgeId) || !mongoose.isValidObjectId(ref.optionId)) {
    return "invalid_badge_id";
  }

  const badge = await Badge.findOne({
    _id: ref.badgeId,
    status: { $ne: BadgeStatuses.DELETED },
  }).lean();

  if (!badge) return "badge_not_found";

  const option = (badge.options || []).find((item) => item._id.toString() === ref.optionId.toString());
  if (!option) return "badge_option_not_found";

  return null;
};

// Resolves a { badgeId, optionId } reference to the option's display name.
// Returns null when the reference is missing or doesn't resolve.
const resolveBadgeOptionName = async (ref) => {
  if (!ref?.badgeId || !ref?.optionId) return null;
  if (!mongoose.isValidObjectId(ref.badgeId) || !mongoose.isValidObjectId(ref.optionId)) return null;

  const badge = await Badge.findById(ref.badgeId).select("options").lean();
  const option = (badge?.options || []).find((item) => item._id.toString() === ref.optionId.toString());
  return option?.name || null;
};

module.exports = { validateBadgeOptionRef, resolveBadgeOptionName };
