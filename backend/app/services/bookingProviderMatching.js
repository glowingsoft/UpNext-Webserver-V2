const BusinessProfile = require("@models/BusinessProfile");

const referenceIds = (values) => (Array.isArray(values) ? values : [])
  .map((value) => value?._id == null ? null : String(value._id)).filter(Boolean);
const skills = (values) => (Array.isArray(values) ? values : [])
  .filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase()).filter(Boolean);
const overlaps = (a, b) => {
  const right = new Set(b);
  return a.some((value) => right.has(value));
};

const profileSimilarity = (original, candidate) => {
  const matches = [
    overlaps(referenceIds(original.categories), referenceIds(candidate.categories)),
    overlaps(referenceIds(original.tags), referenceIds(candidate.tags)),
    overlaps(skills(original.skills), skills(candidate.skills)),
  ];
  return matches.filter(Boolean).length / matches.length;
};

const profileMatchConditions = (profile) => {
  const categories = referenceIds(profile.categories);
  const tags = referenceIds(profile.tags);
  const names = skills(profile.skills);
  return [
    ...(categories.length ? [{ "categories._id": { $in: categories } }] : []),
    ...(tags.length ? [{ "tags._id": { $in: tags } }] : []),
    ...(names.length ? [{ skills: { $in: names.map((value) =>
      new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i")) } }] : []),
  ];
};

const firstProviderProfile = async (offers, session) => {
  if (!offers.length || offers.some((offer) => !offer.business || !Number.isFinite(new Date(offer.sentAt).getTime()))) {
    throw new Error("Booking offers are missing the original provider or sent time");
  }
  const first = [...offers].sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) ||
    String(a._id).localeCompare(String(b._id)))[0];
  const query = BusinessProfile.findById(first.business);
  if (session) query.session(session);
  const profile = await query.lean();
  if (!profile) throw new Error("Original booking provider not found");
  return profile;
};

module.exports = { profileSimilarity, profileMatchConditions, firstProviderProfile };
