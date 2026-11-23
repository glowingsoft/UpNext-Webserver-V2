const WEIGHT_FIELDS = ["travelTime", "rating", "acceptanceRate", "similarity"];

const bounded = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
};

const scoreBookingCandidate = (candidate, weights) => {
  const travelSeconds = bounded(candidate.travelSeconds, 0, Number.MAX_SAFE_INTEGER, "travelSeconds");
  const rating = bounded(candidate.rating, 0, 5, "rating");
  const similarity = bounded(candidate.similarity, 0, 1, "similarity");
  const stats = candidate.matchStats || {};
  const accepted = bounded(stats.offersAccepted ?? 0, 0, Number.MAX_SAFE_INTEGER, "offersAccepted");
  const received = bounded(stats.offersReceived ?? 0, 0, Number.MAX_SAFE_INTEGER, "offersReceived");
  if (accepted > received) throw new RangeError("offersAccepted cannot exceed offersReceived");
  const penaltyWeight = bounded(candidate.penaltyWeight ?? 0, 0, Number.MAX_SAFE_INTEGER, "penaltyWeight");

  const totalWeight = WEIGHT_FIELDS.reduce(
    (sum, key) => sum + bounded(weights?.[key], 0, Number.MAX_SAFE_INTEGER, `scoringWeights.${key}`),
    0,
  );
  if (totalWeight === 0) throw new RangeError("At least one scoring weight must be positive");
  const components = {
    travelTime: 1 - Math.min(travelSeconds / 1800, 1),
    rating: rating / 5,
    acceptanceRate: (accepted + 2) / (received + 4),
    similarity,
  };
  let score = WEIGHT_FIELDS.reduce((sum, key) => sum + weights[key] * components[key], 0) / totalWeight * 100;
  if (penaltyWeight >= 2) score *= 0.5;
  return Math.round(score * 100) / 100;
};

const rankBookingCandidates = (candidates, weights) =>
  candidates
    .map((candidate) => ({ ...candidate, score: scoreBookingCandidate(candidate, weights) }))
    .sort((a, b) => b.score - a.score || a.travelSeconds - b.travelSeconds ||
      String(a.businessId).localeCompare(String(b.businessId)));

module.exports = { scoreBookingCandidate, rankBookingCandidates };
