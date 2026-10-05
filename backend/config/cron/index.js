const cron = require("node-cron");
const { acquireLock, releaseLock } = require("../redis/redisCache");
const { isRedisUp } = require("../redis/redisConfig");

const { runEventReminderCron } = require("./events/eventReminder.cron");
const { runBookingCompletionReminderCron } = require("./bookings/bookingCompletionReminder.cron");
const {
  runApprovalExpiryCron,
  runHorizonChargeCron,
  runPaymentFixGraceCron,
  runStatusTransitionCron,
} = require("../../app/services/bookingLifecycleService");

const withLock = (lockKey, fn, ttl = 300) => async () => {
  // Best effort, same as slot locks and cache(): when Redis is down
  // (single-instance dev) run unlocked instead of silently skipping.
  const redisUp = isRedisUp();
  const lock = redisUp ? await acquireLock(lockKey, ttl) : null;
  if (redisUp && !lock) return; // another instance holds the lock
  try {
    await fn();
  } catch (err) {
    console.error(`Cron ${lockKey} error:`, err);
  } finally {
    if (lock) await releaseLock(lockKey, lock);
  }
};

const startCrons = () => {

  ///* ======================================================
  //   🕛 CRON - Event reminders (every minute)
  //   ====================================================== */
  cron.schedule("* * * * *", async () => {
    const lockKey = "cron:event-reminders";
    const lock = await acquireLock(lockKey, 50);
    if (!lock) return;
    try {
      // await runEventReminderCron();
    } catch (err) {
      console.error("Reminder cron error:", err);
    } finally {
      await releaseLock(lockKey, lock);
    }
  });

  /* ======================================================
     🕛 CRON - Booking completion reminders (every 30 min)
     ====================================================== */
  cron.schedule("*/30 * * * *", async () => {
    const lockKey = "cron:booking-completion-reminders";
    const lock = await acquireLock(lockKey, 50);
    if (!lock) return;
    try {
      await runBookingCompletionReminderCron();
    } catch (err) {
      console.error("Booking completion cron error:", err);
    } finally {
      await releaseLock(lockKey, lock);
    }
  });

  /* ======================================================
     🕛 CRON - Booking approval expiry + provider reminders (hourly)
     ====================================================== */
  cron.schedule("0 * * * *", withLock("cron:booking-approval-expiry", runApprovalExpiryCron));

  /* ======================================================
     🕛 CRON - 4-day horizon: charge vaulted cards (hourly)
     ====================================================== */
  cron.schedule("15 * * * *", withLock("cron:booking-horizon-charge", runHorizonChargeCron));

  /* ======================================================
     🕛 CRON - Payment-fix grace period expiry (hourly)
     ====================================================== */
  cron.schedule("30 * * * *", withLock("cron:booking-payment-fix-grace", runPaymentFixGraceCron));

  /* ======================================================
     🕛 CRON - Status transitions, 30-min reminders,
        abandoned checkouts (every 5 min)
     ====================================================== */
  cron.schedule("*/5 * * * *", withLock("cron:booking-status-transition", runStatusTransitionCron, 240));
};

module.exports = { startCrons };
