require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const ProviderPenalty = require("@models/ProviderPenalty");
const BusinessProfile = require("@models/BusinessProfile");
const { scoreCandidate } = require("../backend/helperUtils/instantRanking");

const settingsPath = require.resolve("../backend/helperUtils/instantPricing");
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: { getInstantSettings: async () => ({ penaltyDeductionCents: 700, suspensionHours: 24 }) },
};

const original = {
  findOne: ProviderPenalty.findOne,
  countDocuments: ProviderPenalty.countDocuments,
  create: ProviderPenalty.create,
  find: ProviderPenalty.find,
  findOneAndUpdate: ProviderPenalty.findOneAndUpdate,
  updateOne: ProviderPenalty.updateOne,
  profileFindUpdate: BusinessProfile.findOneAndUpdate,
  profileUpdate: BusinessProfile.updateOne,
};
let rows;
let profile;
let nextId;

const { recordPenalty, quoteCancellationPenalty, consumeDeductions } =
  require("../backend/app/services/penaltyService");

const setup = () => {
  rows = [];
  profile = { _id: "provider", matchStats: { cancellationCount: 0 }, isAvailable: true, suspendedUntil: null };
  nextId = 0;
  ProviderPenalty.findOne = () => ({
    session: () => ({ lean: async () => null }),
    lean: async () => null,
  });
  ProviderPenalty.countDocuments = async () => rows.length;
  ProviderPenalty.create = async (docs) => {
    const created = docs.map((doc) => ({ ...doc, _id: `penalty-${++nextId}`, appliedCents: 0 }));
    rows.push(...created);
    return created;
  };
  ProviderPenalty.find = () => ({
    sort: () => ({ lean: async () => rows.filter((row) => row.appliedAt == null && row.deductionCents > 0) }),
  });
  ProviderPenalty.findOneAndUpdate = async (filter, update) => {
    const row = rows.find((item) => item._id === filter._id && item.appliedCents === filter.appliedCents);
    if (!row) return null;
    row.appliedCents += update.$inc.appliedCents;
    return row;
  };
  ProviderPenalty.updateOne = async (filter, update) => {
    const row = rows.find((item) => item._id === filter._id);
    if (row) Object.assign(row, update.$set);
    return { matchedCount: row ? 1 : 0 };
  };
  BusinessProfile.findOneAndUpdate = async (_, update) => {
    profile.matchStats.cancellationCount += update.$inc["matchStats.cancellationCount"];
    return profile;
  };
  BusinessProfile.updateOne = async (_, update) => {
    Object.assign(profile, update.$set);
    return { matchedCount: 1 };
  };
};

test("first cancellation warns; every later cancellation queues $7 and ranks/suspends at thresholds", async () => {
  setup();
  const now = new Date("2026-11-17T12:00:00Z");
  const first = await recordPenalty({ providerId: "provider", bookingId: "booking-1", type: "cancellation", now });
  const second = await recordPenalty({ providerId: "provider", bookingId: "booking-2", type: "cancellation", now });
  const third = await recordPenalty({ providerId: "provider", bookingId: "booking-3", type: "cancellation", now });
  const fourth = await recordPenalty({ providerId: "provider", bookingId: "booking-4", type: "cancellation", now });

  assert.deepEqual([first.cancellationNumber, second.cancellationNumber, third.cancellationNumber,
    fourth.cancellationNumber], [1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.deductionCents), [0, 700, 700, 700]);
  assert.deepEqual(rows.map((row) => row.warningIssued), [true, false, false, false]);
  assert.deepEqual(rows.map((row) => row.rankingReductionApplied), [false, true, true, true]);
  assert.equal(first.warningOnly, true);
  assert.equal(second.warningOnly, false);
  assert.equal(third.suspendedUntil.getTime(), now.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(profile.isAvailable, false);
  assert.equal(profile.suspendedUntil.getTime(), now.getTime() + 24 * 60 * 60 * 1000);
  const candidate = {
    distanceM: 0,
    matchStats: { cancellationCount: 0, offersReceived: 0, offersAccepted: 0 },
    penaltyWeight: 0,
  };
  const firstCancellationScore = scoreCandidate(candidate, { radiusKm: 25, offerWindowSec: 90 });
  assert.equal(scoreCandidate({
    ...candidate, matchStats: { ...candidate.matchStats, cancellationCount: 1 },
  }, { radiusKm: 25, offerWindowSec: 90 }), firstCancellationScore);
  assert.equal(scoreCandidate({
    ...candidate, matchStats: { ...candidate.matchStats, cancellationCount: 2 },
  }, { radiusKm: 25, offerWindowSec: 90 }), firstCancellationScore / 2);
  assert.deepEqual(await quoteCancellationPenalty({ cancellationCount: 0 }),
    { cancellationNumber: 1, deductionCents: 0, warningIssued: true, rankingReductionApplied: false, suspensionHours: 0 });

  const consumed = await consumeDeductions("provider", 5000);
  assert.equal(consumed.totalCents, 2100);
  assert.deepEqual(consumed.applied.map((entry) => entry.cents), [700, 700, 700]);
  assert.equal(rows[0].appliedCents, 0);
  assert.ok(rows.slice(1).every((row) => row.appliedAt instanceof Date && row.appliedCents === 700));
});

test.after(() => {
  ProviderPenalty.findOne = original.findOne;
  ProviderPenalty.countDocuments = original.countDocuments;
  ProviderPenalty.create = original.create;
  ProviderPenalty.find = original.find;
  ProviderPenalty.findOneAndUpdate = original.findOneAndUpdate;
  ProviderPenalty.updateOne = original.updateOne;
  BusinessProfile.findOneAndUpdate = original.profileFindUpdate;
  BusinessProfile.updateOne = original.profileUpdate;
  delete require.cache[settingsPath];
});
