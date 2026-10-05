/**
 * ============================================================
 * Redis Configuration
 * ============================================================
 *
 * IMPORTANT:
 * We intentionally create TWO TYPES of Redis clients:
 *
 * 1) getRedisClient()        → Application Redis (SINGLETON)
 *    - Used for cache, locks, SCAN, pipelines
 *    - Long-lived, shared across app
 *    - Runs SET/GET/DEL/SCAN/PIPELINE commands
 *
 * 2) createNewRedisClient() → Infrastructure Redis (DEDICATED)
 *    - Used ONLY for Socket.IO Redis adapter (pub/sub)
 *    - MUST be a separate connection
 *    - MUST NOT be shared with app logic
 *
 * Reason:
 * Redis connections used for SUBSCRIBE cannot safely run
 * normal commands (SET/GET/SCAN).
 *
 * Mixing these WILL cause subtle production bugs.
 */

const Redis = require("ioredis");

let redisClient = null;
let redisAvailable = false;

/**
 * ------------------------------------------------------------
 * Application Redis Client (SINGLETON)
 * ------------------------------------------------------------
 *
 * Use this for:
 * - Caching (SET / GET)
 * - Locks (SET NX)
 * - SCAN / pipeline
 * - Invalidation
 *
 * DO NOT use this client for Socket.IO pub/sub.
 */
function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const isAzure = url.startsWith("rediss://");

  redisClient = new Redis(url, {
    connectTimeout: 10000,
    // Do not hard-fail requests
    maxRetriesPerRequest: null,
    enableReadyCheck: true,

    retryStrategy(times) {
      // Soft exponential backoff
      return Math.min(times * 500, 5000);
    },

    reconnectOnError() {
      return true;
    },

    ...(isAzure && {
      tls: {
        rejectUnauthorized: false,
      },
    }),
  });

  redisClient.on("connect", () => {
    redisAvailable = true;
    console.log("🚀 Redis connected:", isAzure ? "Azure" : "Local");
  });

  redisClient.on("error", (error) => {
    console.log("⚠️ Redis connection error", error);
    redisAvailable = false;
  });

  return redisClient;
}

/**
 * ------------------------------------------------------------
 * Dedicated Redis Client (INFRA / PUB-SUB ONLY)
 * ------------------------------------------------------------
 *
 * Use this ONLY for:
 * - Socket.IO Redis adapter
 * - Pub/Sub messaging
 *
 * Why this exists:
 * - Redis connections in SUBSCRIBE mode cannot execute
 *   normal commands (SET/GET/SCAN).
 * - Socket.IO requires dedicated pub & sub connections.
 *
 * DO NOT:
 * - Cache data
 * - Acquire locks
 * - Run SCAN / pipelines
 * - Share this client with app logic
 */
function createNewRedisClient() {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const isAzure = url.startsWith("rediss://");

  return new Redis(url, {
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,

    retryStrategy(times) {
      return Math.min(times * 500, 5000);
  },

    reconnectOnError() {
      return true;
    },

    ...(isAzure && {
      tls: {
        rejectUnauthorized: false,
      },
    }),
  });
}

/**
 * Redis availability flag
 * Used to gracefully bypass cache when Redis is down
 */
function isRedisUp() {
  return redisAvailable;
}

module.exports = {
  getRedisClient,
  createNewRedisClient,
  isRedisUp,
};
