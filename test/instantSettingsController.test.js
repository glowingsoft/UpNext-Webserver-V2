require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const AdminSettings = require("@models/AdminSettings");

const bookingServicePath = require.resolve("../backend/app/services/instantBookingService");
require.cache[bookingServicePath] = {
  id: bookingServicePath,
  filename: bookingServicePath,
  loaded: true,
  exports: { resolveNoShow: async () => ({}) },
};
const { updateSettings } = require("../backend/admin/controllers/instantController");

const response = () => ({
  req: { __: (key) => key, query: {} },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("admin settings controller persists timers and partial weights", async () => {
  const originalFindOne = AdminSettings.findOne;
  const originalUpdate = AdminSettings.findOneAndUpdate;
  const stored = { feeFloorCents: 700, feeCapCents: 2000, scoringWeights: { rating: 50 } };
  let update;
  AdminSettings.findOne = () => ({ lean: async () => ({ _id: "settings", __v: 2, instant: stored }) });
  AdminSettings.findOneAndUpdate = (filter, changes, options) => {
    update = { filter, changes, options };
    stored.paymentSec = changes.$set["instant.paymentSec"];
    stored.scoringWeights.rating = changes.$set["instant.scoringWeights.rating"];
    return { lean: async () => ({ instant: stored }) };
  };
  try {
    const res = response();
    await updateSettings({ body: { instant: { paymentSec: 300, scoringWeights: { rating: 75 } } } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(update.changes.$set, { "instant.paymentSec": 300, "instant.scoringWeights.rating": 75 });
    assert.deepEqual(update.filter, { _id: "settings", __v: 2 });
    assert.deepEqual(update.changes.$inc, { __v: 1 });
    assert.equal(update.options.runValidators, true);
    assert.equal(res.body.data.scoringWeights.rating, 75);
    assert.equal(res.body.data.scoringWeights.travelTime, 100);
    assert.equal(res.body.data.providerAcceptSecAdvance, 1800);
  } finally {
    AdminSettings.findOne = originalFindOne;
    AdminSettings.findOneAndUpdate = originalUpdate;
  }
});

test("admin settings controller reports concurrent updates after bounded retries", async () => {
  const originalFindOne = AdminSettings.findOne;
  const originalUpdate = AdminSettings.findOneAndUpdate;
  let attempts = 0;
  AdminSettings.findOne = () => ({ lean: async () => ({ _id: "settings", __v: attempts, instant: {} }) });
  AdminSettings.findOneAndUpdate = () => {
    attempts++;
    return { lean: async () => null };
  };
  try {
    const res = response();
    await updateSettings({ body: { paymentSec: 300 } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(attempts, 3);
  } finally {
    AdminSettings.findOne = originalFindOne;
    AdminSettings.findOneAndUpdate = originalUpdate;
  }
});

test("admin settings controller initializes missing settings before updating", async () => {
  const originalFindOne = AdminSettings.findOne;
  const originalUpdate = AdminSettings.findOneAndUpdate;
  let doc = null;
  let initialized = false;
  AdminSettings.findOne = () => ({ lean: async () => doc });
  AdminSettings.findOneAndUpdate = (filter, changes, options) => {
    if (options.upsert) {
      initialized = true;
      doc = { _id: "settings", __v: 0, instant: {} };
      return Promise.resolve(doc);
    }
    assert.deepEqual(filter, { _id: "settings", __v: 0 });
    doc.instant.paymentSec = changes.$set["instant.paymentSec"];
    return { lean: async () => doc };
  };
  try {
    const res = response();
    await updateSettings({ body: { paymentSec: 300 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(initialized, true);
    assert.equal(res.body.data.paymentSec, 300);
  } finally {
    AdminSettings.findOne = originalFindOne;
    AdminSettings.findOneAndUpdate = originalUpdate;
  }
});

test("admin settings controller rejects invalid input without writing", async () => {
  const originalFindOne = AdminSettings.findOne;
  const originalUpdate = AdminSettings.findOneAndUpdate;
  let writes = 0;
  AdminSettings.findOne = () => ({ lean: async () => null });
  AdminSettings.findOneAndUpdate = async () => { writes++; };
  try {
    const res = response();
    await updateSettings({ body: { instant: { maxAttemptMinutes: 0 } } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.data.field, "maxAttemptMinutes");
    assert.equal(writes, 0);
  } finally {
    AdminSettings.findOne = originalFindOne;
    AdminSettings.findOneAndUpdate = originalUpdate;
  }
});
