const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreBookingCandidate, rankBookingCandidates } = require("../backend/helperUtils/bookingRanking");

const weights = { travelTime: 100, rating: 50, acceptanceRate: 30, similarity: 20 };
const candidate = {
  businessId: "a",
  travelSeconds: 0,
  rating: 5,
  similarity: 1,
  matchStats: { offersReceived: 0, offersAccepted: 0 },
};

test("scores a weighted sum with smoothed acceptance", () => {
  assert.equal(scoreBookingCandidate(candidate, weights), 92.5);
  assert.equal(scoreBookingCandidate({ ...candidate, penaltyWeight: 2 }, weights), 46.25);
});

test("ranks shorter routes ahead under the default weights", () => {
  const ranked = rankBookingCandidates(
    [{ ...candidate, businessId: "far", travelSeconds: 1800 }, { ...candidate, businessId: "near", travelSeconds: 0 }],
    weights,
  );
  assert.deepEqual(ranked.map((row) => row.businessId), ["near", "far"]);
  assert.equal(ranked[0].score, 92.5);
  assert.equal(ranked[1].score, 42.5);
});

test("rejects malformed candidate inputs and invalid weights", () => {
  assert.throws(() => scoreBookingCandidate({ ...candidate, travelSeconds: null }, weights), TypeError);
  assert.throws(() => scoreBookingCandidate(candidate, { ...weights, travelTime: -1 }), TypeError);
  assert.throws(() => scoreBookingCandidate(candidate, { travelTime: 0, rating: 0, acceptanceRate: 0, similarity: 0 }), RangeError);
  assert.throws(
    () => scoreBookingCandidate({ ...candidate, matchStats: { offersAccepted: 2, offersReceived: 1 } }, weights),
    RangeError,
  );
});
