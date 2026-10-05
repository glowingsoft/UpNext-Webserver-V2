/**
 * URL-friendly slug generation, with uniqueness enforcement against a model.
 */

const slugify = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Builds a slug from `name` and appends `-2`, `-3`, ... until it doesn't
 * collide with an existing document (optionally excluding one _id, for updates).
 */
const generateUniqueSlug = async (Model, name, { field = "nameSlug", excludeId } = {}) => {
  const base = slugify(name) || "business";
  let candidate = base;
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = { [field]: candidate };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Model.exists(query);
    if (!exists) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
};

module.exports = { slugify, generateUniqueSlug };
