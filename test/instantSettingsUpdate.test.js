require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { INSTANT_DEFAULTS } = require("@utils/instantPricing");
const { buildInstantSettingsUpdate } = require("@utils/instantSettingsUpdate");

test("accepts flat or nested updates and partial scoring weights", () => {
  assert.deepEqual(buildInstantSettingsUpdate({
    instant: { maxAttemptMinutes: 15, scoringWeights: { rating: 60 } },
  }, INSTANT_DEFAULTS), {
    set: { "instant.maxAttemptMinutes": 15, "instant.scoringWeights.rating": 60 },
  });
  assert.deepEqual(buildInstantSettingsUpdate({ paymentSec: 300 }, INSTANT_DEFAULTS), {
    set: { "instant.paymentSec": 300 },
  });
});

test("rejects unknown, invalid, fractional, and inconsistent settings", () => {
  for (const input of [
    { offerWindowSec: 120 },
    { paymentSec: 0 },
    { maxAttemptMinutes: 0 },
    { feeFloorCents: 700.5 },
    { feeCapCents: 100 },
    { scoringWeights: { rating: -1 } },
    { scoringWeights: { travelTime: 0, rating: 0, acceptanceRate: 0, similarity: 0 } },
    { providerAcceptSec: "120" },
    { instant: {}, paymentSec: 300 },
  ]) {
    assert.equal(buildInstantSettingsUpdate(input, INSTANT_DEFAULTS).error, "invalid_setting");
  }
});
