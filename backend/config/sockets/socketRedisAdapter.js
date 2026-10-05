/**
 * ============================================================
 * Socket.IO Redis Adapter
 * ============================================================
 *
 * PURPOSE:
 * This file attaches the Redis adapter to Socket.IO so that:
 * - Events emitted on one Node.js instance
 * - Are delivered to sockets connected to other Node.js instances
 *
 * This is REQUIRED for horizontal scaling.
 *
 * ------------------------------------------------------------
 * ⚠️ VERY IMPORTANT REDIS RULE
 * ------------------------------------------------------------
 * Socket.IO Redis adapter MUST use DEDICATED Redis connections.
 *
 * DO NOT reuse:
 * - getRedisClient()
 * - cache Redis
 * - lock Redis
 *
 * Reason:
 * Redis Pub/Sub connections cannot safely execute normal
 * commands (SET / GET / SCAN / PIPELINE).
 *
 * Mixing cache + pub/sub on the same connection will cause
 * subtle, production-only bugs (missed events, deadlocks).
 */

const { createAdapter } = require("@socket.io/redis-adapter");
const { createNewRedisClient } = require("../redis/redisConfig");

/**
 * Attaches Redis adapter to a Socket.IO server instance.
 *
 * This creates:
 * - One Redis connection for publishing events
 * - One Redis connection for subscribing to events
 *
 * These connections:
 * - Are ephemeral
 * - Do NOT store data
 * - Do NOT create keys
 * - Act purely as a message relay (pub/sub)
 *
 * @param {import("socket.io").Server} io
 */
function attachRedisAdapter(io) {
  /**
   * Dedicated Redis connection for publishing events
   * (used when io.emit(...) is called)
   */
  const pubClient = createNewRedisClient();

  /**
   * Dedicated Redis connection for subscribing to events
   * (used to receive events from other Node instances)
   */
  const subClient = createNewRedisClient();

  /**
   * Attach the adapter to Socket.IO
   * After this:
   * - io.emit() becomes cluster-aware
   * - Rooms are synchronized across servers
   * - Events fan out via Redis pub/sub
   */
  io.adapter(createAdapter(pubClient, subClient));

  console.log("🔗 Socket.IO Redis adapter attached");
}

module.exports = { attachRedisAdapter };
