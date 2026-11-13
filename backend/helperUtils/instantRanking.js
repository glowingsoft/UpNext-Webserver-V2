// Reroute ranking. Only used when the chosen provider doesn't take the booking;
// the first offer always goes to the client's pick without ranking.

const WEIGHTS = { distance: 0.35, acceptance: 0.25, speed: 0.15, reliability: 0.25 };
const PENALTY_RANK_DROP_AT = 2; // weighted 30-day count at which the ranking drop applies
const PENALTY_RANK_FACTOR = 0.5;

/**
 * @param {object} c candidate: { distanceM, matchStats, penaltyWeight }
 * @param {object} ctx { radiusKm, offerWindowSec }
 * @returns score in 0..100, higher is better
 */
const scoreCandidate = (c, { radiusKm, offerWindowSec }) => {
  const stats = c.matchStats || {};
  const distance = 1 - Math.min(1, c.distanceM / (radiusKm * 1000));

  // Laplace-smoothed so a brand-new provider sits near the middle, not at 0 or 1.
  const acceptance = ((stats.offersAccepted || 0) + 2) / ((stats.offersReceived || 0) + 4);

  const avgResponseSec = stats.responseCount ? stats.responseSecTotal / stats.responseCount : offerWindowSec / 2;
  const speed = 1 - Math.min(1, avgResponseSec / offerWindowSec);

  const reliability = 1 - Math.min(1, (c.penaltyWeight || 0) / 3);

  let score =
    100 *
    (WEIGHTS.distance * distance +
      WEIGHTS.acceptance * acceptance +
      WEIGHTS.speed * speed +
      WEIGHTS.reliability * reliability);

  if ((c.penaltyWeight || 0) >= PENALTY_RANK_DROP_AT) score *= PENALTY_RANK_FACTOR;
  return Math.round(score * 100) / 100;
};

const rankCandidates = (candidates, ctx) =>
  candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, ctx) }))
    .sort((a, b) => b.score - a.score || a.distanceM - b.distanceM);

module.exports = { scoreCandidate, rankCandidates };
