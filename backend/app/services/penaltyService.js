const ProviderPenalty = require("@models/ProviderPenalty");
const BusinessProfile = require("@models/BusinessProfile");
const { getInstantSettings } = require("@utils/instantPricing");

const PENALTY_WEIGHTS = { no_show: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling no-show weight; cancellations use the provider's lifetime counter.
const rollingWeights = async (providerIds, windowDays, session) => {
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const aggregation = ProviderPenalty.aggregate([
    { $match: { provider: { $in: providerIds }, type: "no_show", createdAt: { $gte: since } } },
    { $group: { _id: "$provider", weight: { $sum: "$weight" } } },
  ]);
  if (session) aggregation.session(session);
  const rows = await aggregation;
  return new Map(rows.map((r) => [String(r._id), r.weight]));
};

const getCancellationCount = async (providerId, profileCount = 0, session) => {
  const query = ProviderPenalty.countDocuments({ provider: providerId, type: "cancellation" });
  if (session) query.session(session);
  return Math.max(profileCount || 0, await query);
};

const cancellationPenaltyFor = (cancellationNumber, settings) => ({
  deductionCents: cancellationNumber >= 2 ? settings.penaltyDeductionCents : 0,
  warningIssued: cancellationNumber === 1,
  rankingReductionApplied: cancellationNumber >= 2,
  suspensionHours: cancellationNumber >= 3 ? settings.suspensionHours : 0,
});

const quoteCancellationPenalty = async ({ providerId, cancellationCount = 0 }) => {
  const settings = await getInstantSettings();
  if (providerId) cancellationCount = await getCancellationCount(providerId, cancellationCount);
  const nextNumber = cancellationCount + 1;
  return {
    cancellationNumber: nextNumber,
    ...cancellationPenaltyFor(nextNumber, settings),
  };
};

const recordPenalty = async ({ providerId, bookingId, type, note, session, now = new Date() }) => {
  const settings = await getInstantSettings();
  if (type === "cancellation") {
    if (!bookingId) throw new TypeError("bookingId is required for a cancellation penalty");
    const prior = await ProviderPenalty.findOne({ provider: providerId, booking: bookingId, type })
      .session(session || null).lean();
    if (prior) return { duplicate: true, penalty: prior };

    const priorCancellationCount = await getCancellationCount(providerId, 0, session);
    const profile = await BusinessProfile.findOneAndUpdate(
      { _id: providerId },
      { $inc: { "matchStats.cancellationCount": 1 } },
      { new: true, session, projection: "matchStats.cancellationCount" },
    );
    if (!profile) throw new Error("Cancellation penalty provider not found");
    const cancellationNumber = Math.max(profile.matchStats.cancellationCount, priorCancellationCount + 1);
    if (profile.matchStats.cancellationCount !== cancellationNumber) {
      await BusinessProfile.updateOne(
        { _id: providerId },
        { $set: { "matchStats.cancellationCount": cancellationNumber } },
        { session },
      );
    }
    const policy = cancellationPenaltyFor(cancellationNumber, settings);
    const suspendedUntil = policy.suspensionHours
      ? new Date(now.getTime() + policy.suspensionHours * 60 * 60 * 1000)
      : null;
    const [penalty] = await ProviderPenalty.create([{
      provider: providerId,
      booking: bookingId,
      type,
      weight: 1,
      cancellationNumber,
      warningIssued: policy.warningIssued,
      rankingReductionApplied: policy.rankingReductionApplied,
      deductionCents: policy.deductionCents,
      appliedAt: policy.deductionCents === 0 ? now : null,
      suspendedUntil,
      note,
    }], { session });

    if (suspendedUntil) {
      await BusinessProfile.updateOne(
        { _id: providerId },
        { $set: { isAvailable: false, suspendedUntil } },
        { session },
      );
    }
    return {
      penalty,
      total: cancellationNumber,
      cancellationNumber,
      deductionCents: policy.deductionCents,
      warningOnly: policy.warningIssued,
      rankingReductionApplied: policy.rankingReductionApplied,
      suspendedUntil,
    };
  }

  const weight = PENALTY_WEIGHTS[type];
  if (!weight) throw new Error(`Unknown penalty type: ${type}`);

  const before = (await rollingWeights([providerId], settings.penaltyWindowDays, session)).get(String(providerId)) || 0;
  const total = before + weight;
  const deductionCents = total >= 2 ? settings.penaltyDeductionCents : 0;

  let penalty;
  try {
    [penalty] = await ProviderPenalty.create([{
      provider: providerId,
      booking: bookingId,
      type,
      weight,
      deductionCents,
      appliedAt: deductionCents === 0 ? now : null,
      note,
    }], { session });
  } catch (err) {
    if (err.code === 11000) return { duplicate: true };
    throw err;
  }

  const update = { "matchStats.penaltyWeight30d": total };
  let suspendedUntil = null;
  if (total >= 3) {
    suspendedUntil = new Date(now.getTime() + settings.suspensionHours * 60 * 60 * 1000);
    update.isAvailable = false;
    update.suspendedUntil = suspendedUntil;
  }
  await BusinessProfile.updateOne({ _id: providerId }, { $set: update }, { session });

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

module.exports = {
  recordPenalty,
  quoteCancellationPenalty,
  cancellationPenaltyFor,
  getCancellationCount,
  rollingWeights,
  refreshPenaltyState,
  consumeDeductions,
  restoreDeductions,
};
