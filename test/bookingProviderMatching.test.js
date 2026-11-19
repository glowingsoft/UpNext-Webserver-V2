require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { profileSimilarity, profileMatchConditions } = require("../backend/app/services/bookingProviderMatching");

test("profile matching uses category and tag IDs and case-insensitive exact skills", () => {
  const original = { categories: [{ _id: "category" }], tags: [{ _id: "tag" }], skills: ["  Cut + Style  "] };
  assert.equal(profileSimilarity(original, { categories: [{ _id: "category" }] }), 1 / 3);
  assert.equal(profileSimilarity(original, { tags: [{ _id: "tag" }] }), 1 / 3);
  assert.equal(profileSimilarity(original, { skills: ["cut + STYLE"] }), 1 / 3);
  assert.equal(profileSimilarity(original, { skills: ["cuttt style"] }), 0);
  assert.equal(profileSimilarity({}, {}), 0);
  const conditions = profileMatchConditions(original);
  assert.deepEqual(conditions[0], { "categories._id": { $in: ["category"] } });
  assert.deepEqual(conditions[1], { "tags._id": { $in: ["tag"] } });
  const pattern = conditions[2].skills.$in[0];
  assert.equal(pattern.test(" Cut + Style "), true);
  assert.equal(pattern.test("cuttt style"), false);
});
