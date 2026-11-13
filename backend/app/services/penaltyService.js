const ProviderPenalty = require("@models/ProviderPenalty");
const BusinessProfile = require("@models/BusinessProfile");
const { getInstantSettings } = require("@utils/instantPricing");

const PENALTY_WEIGHTS = { cancellation: 1, no_show: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling weighted count of cancellations + no-shows per provider, straight
// from the ledger (matchStats.penaltyWeight30d is only a mirror of this).
const rollingWeights = async (providerIds, windowDays) => {
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const rows = await ProviderPenalty.aggregate([
    { $match: { provider: { $in: providerIds }, type: { $in: Object.keys(PENALTY_WEIGHTS) }, createdAt: { $gte: since } } },
    { $group: { _id: "$provider", weight: { $sum: "$weight" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.weight]));
};

/**
 * Ladder over the rolling weighted count (a no-show weighs 2):
 *   1   warning only
 *   2+  ranking drop + deduction from the next payout
 *   3+  also a temporary suspension
 * The unique {booking, type} index makes a retried cancel a no-op.
 */
const recordPenalty = async ({ providerId, bookingId, type, note }) => {
  const settings = await getInstantSettings();
  const weight = PENALTY_WEIGHTS[type];
  if (!weight) throw new Error(`Unknown penalty type: ${type}`);

  const before = (await rollingWeights([providerId], settings.penaltyWindowDays)).get(String(providerId)) || 0;
  const total = before + weight;
  const deductionCents = total >= 2 ? settings.penaltyDeductionCents : 0;

  let penalty;
  try {
    penalty = await ProviderPenalty.create({
      provider: providerId,
      booking: bookingId,
      type,
      weight,
      deductionCents,
      appliedAt: deductionCents === 0 ? new Date() : null,
      note,
    });
  } catch (err) {
    if (err.code === 11000) return { duplicate: true };
    throw err;
  }

  const update = { "matchStats.penaltyWeight30d": total };
  let suspendedUntil = null;
  if (total >= 3) {
    suspendedUntil = new Date(Date.now() + settings.suspensionHours * 60 * 60 * 1000);
    update.isAvailable = false;
    update.suspendedUntil = suspendedUntil;
  }
  await BusinessProfile.updateOne({ _id: providerId }, { $set: update });

  return { penalty, total, deductionCents, suspendedUntil, warningOnly: total < 2 };
};

/**
 * Takes up to `maxCents` from the provider's unapplied ledger rows, oldest
 * first. A row bigger than what is left stays partially applied and carries
 * forward to the next payout. Returns what was taken so a failed transfer can
 * hand it back with restoreDeductions.
 */
const consumeDeductions = async (providerId, maxCents) => {
  const applied = [];
  let remaining = Math.max(0, maxCents);
  if (remaining === 0) return { totalCents: 0, applied };

  const rows = await ProviderPenalty.find({ provider: providerId, appliedAt: null, deductionCents: { $gt: 0 } })
    .sort({ createdAt: 1 })
    .lean();

  for (const row of rows) {
    const owed = row.deductionCents - row.appliedCents;
    if (owed <= 0) continue;
    const take = Math.min(owed, remaining);
    // appliedCents in the filter makes a concurrent consumer lose cleanly
    const updated = await ProviderPenalty.findOneAndUpdate(
      { _id: row._id, appliedAt: null, appliedCents: row.appliedCents },
      { $inc: { appliedCents: take } },
      { new: true },
    );
    if (!updated) continue;
    if (updated.appliedCents >= updated.deductionCents) {
      await ProviderPenalty.updateOne({ _id: row._id }, { $set: { appliedAt: new Date() } });
    }
    applied.push({ penalty: row._id, cents: take });
    remaining -= take;
    if (remaining === 0) break;
  }
  return { totalCents: maxCents - remaining, applied };
};

const restoreDeductions = async (applied = []) => {
  for (const { penalty, cents } of applied) {
    await ProviderPenalty.updateOne({ _id: penalty }, { $inc: { appliedCents: -cents }, $set: { appliedAt: null } });
  }
};

// Lifts expired suspensions and re-syncs the mirrored weight as old rows age out.
const refreshPenaltyState = async () => {
  const now = new Date();
  await BusinessProfile.updateMany(
    { suspendedUntil: { $ne: null, $lte: now } },
    { $set: { isAvailable: true, suspendedUntil: null } },
  );

  const settings = await getInstantSettings();
  const stale = await BusinessProfile.find({ "matchStats.penaltyWeight30d": { $gt: 0 } }, "_id").lean();
  if (!stale.length) return;
  const weights = await rollingWeights(
    stale.map((p) => p._id),
    settings.penaltyWindowDays,
  );
  await BusinessProfile.bulkWrite(
    stale.map((p) => ({
      updateOne: { filter: { _id: p._id }, update: { $set: { "matchStats.penaltyWeight30d": weights.get(String(p._id)) || 0 } } },
    })),
  );
};

module.exports = { recordPenalty, rollingWeights, refreshPenaltyState, consumeDeductions, restoreDeductions };
