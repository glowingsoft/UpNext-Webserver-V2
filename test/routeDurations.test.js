const test = require("node:test");
const assert = require("node:assert/strict");

const cachePath = require.resolve("../backend/config/redis/redisCache");
const values = new Map();
require.cache[cachePath] = {
  id: cachePath,
  filename: cachePath,
  loaded: true,
  exports: {
    getJson: async (key) => values.get(key),
    setJson: async (key, value) => values.set(key, value),
  },
};
const { resolveDrivingDurations } = require("../backend/helperUtils/routeDistanceHelper");

test("resolves and caches actual driving durations and confirmed no-route results", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  values.clear();
  let calls = 0;
  global.fetch = async (_, options) => {
    calls++;
    assert.match(options.headers["X-Goog-FieldMask"], /duration/);
    return {
      ok: true,
      json: async () => [
        { destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
        { condition: "ROUTE_EXISTS", duration: "1799.5s" },
      ],
    };
  };
  try {
    const request = { origin: [-73.9, 40.7], destinations: [[-73.8, 40.8], [-73.7, 40.9]] };
    assert.deepEqual(await resolveDrivingDurations(request), [1799.5, null]);
    assert.deepEqual(await resolveDrivingDurations(request), [1799.5, null]);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});

test("does not cache incomplete or unsuccessful matrices as no route", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  values.clear();
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    await assert.rejects(
      resolveDrivingDurations({ origin: [-73.9, 40.7], destinations: [[-73.8, 40.8]] }),
      /Incomplete travel duration matrix/,
    );
    assert.equal(values.size, 0);
    delete process.env.GOOGLE_MAPS_API_KEY;
    await assert.rejects(
      resolveDrivingDurations({ origin: [-73.9, 40.7], destinations: [[-73.8, 40.8]] }),
      /GOOGLE_MAPS_API_KEY/,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});

test("batches more than 50 destinations and preserves the 30-minute threshold", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  values.clear();
  const sizes = [];
  global.fetch = async (_, options) => {
    const request = JSON.parse(options.body);
    sizes.push(request.destinations.length);
    return {
      ok: true,
      json: async () => request.destinations.map((_, index) => ({
        destinationIndex: index,
        condition: "ROUTE_EXISTS",
        duration: index === 0 ? "1800s" : "1800.001s",
      })),
    };
  };
  try {
    const destinations = Array.from({ length: 51 }, (_, index) => [-73.8 + index / 10000, 40.8]);
    const durations = await resolveDrivingDurations({ origin: [-73.9, 40.7], destinations });
    assert.deepEqual(sizes, [50, 1]);
    assert.equal(durations[0], 1800);
    assert.equal(durations[1], 1800.001);
    assert.equal(durations[50], 1800);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});
