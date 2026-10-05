const zlib = require("zlib");
const { getRedisClient, isRedisUp } = require("./redisConfig");

const redis = getRedisClient();

function buildKey(namespace, params = {}) {
  const qs = Object.entries(params)
    .sort(([a, b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  return qs ? `${namespace}:${qs}` : namespace;
}

/**
 * SET
 */
async function setJson(key, value, ttl = null) {
  if (!isRedisUp()) return;

  try {
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(value)));
    if (ttl) await redis.set(key, buf, "EX", ttl);
    else await redis.set(key, buf);
  } catch (_) {}
}

/**
 * GET
 */
async function getJson(key) {
  if (!isRedisUp()) return null;

  try {
    const buf = await redis.getBuffer(key);
    if (!buf) return null;

    return JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * LOCKS
 */
async function acquireLock(key, ttl = 5) {
  if (!isRedisUp()) return null;

  try {
    const token = Date.now().toString();
    const ok = await redis.set(`lock:${key}`, token, "NX", "EX", ttl);
    return ok ? token : null;
  } catch {
    return null;
  }
}

async function releaseLock(key, token) {
  if (!isRedisUp()) return;

  try {
    const lk = `lock:${key}`;
    const val = await redis.get(lk);
    if (val === token) await redis.del(lk);
  } catch (_) {}
}

/**
 * MAIN CACHE
 */
async function cache({ namespace, params = {}, ttl = 60, fetchFn }) {
  const key = buildKey(namespace, params);

  if (!isRedisUp()) {
    console.log(`⚠️ BYPASS (Redis down) -> ${key}`);
    return fetchFn();
  }

  let existing = null;

  try {
    existing = await getJson(key);
  } catch {}

  if (existing) {
    console.log(`🟢 CACHE HIT -> ${key}`);
    return existing;
  }

  console.log(`🔵 CACHE MISS -> ${key}`);

  const lock = await acquireLock(key, 5);

  if (!lock) {
    await new Promise((r) => setTimeout(r, 120));
    return (await getJson(key)) ?? fetchFn();
  }

  try {
    const fresh = await fetchFn();
    if (
      fresh === null ||
      fresh === undefined ||
      (Array.isArray(fresh) && fresh.length === 0)
    ) {
      console.log(`⚠️ SKIP STORE (empty) -> ${key}`);
      return fresh;
    }

    try {
      await setJson(key, fresh, ttl === null ? null : ttl);
      console.log(`🧩 STORED -> ${key}`);
    } catch {}

    return fresh;
  } finally {
    await releaseLock(key, lock);
  }
}


/**
 * INVALIDATE
 */
async function invalidate(prefix) {
  if (!isRedisUp()) return true;

  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
    const pipeline = redis.pipeline();

    return new Promise((resolve, reject) => {
      stream.on("data", (keys) => keys.forEach((k) => pipeline.del(k)));
      stream.on("end", async () => {
        await pipeline.exec();
        resolve(true);
      });
      stream.on("error", reject);
    });
  } catch (_) {
    return true;
  }
}

module.exports = {
  cache,
  invalidate,
  // Raw single-key access, for callers that batch their own fetch and so
  // can't hand `cache()` a per-key fetchFn (see @utils/routeDistanceHelper)
  getJson,
  setJson,
  buildKey,
  acquireLock,
  releaseLock,
};
