const requireDate = (value, name) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value.getTime();
};

const requireNonNegative = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`);
  return value;
};

const providerDeadline = ({ now, appointmentStart, isAvailableNow, settings }) => {
  const start = requireDate(now, "now");
  const appointment = requireDate(appointmentStart, "appointmentStart");
  if (typeof isAvailableNow !== "boolean") throw new TypeError("isAvailableNow must be a boolean");
  if (appointment <= start) throw new RangeError("appointmentStart must be in the future");
  const seconds = requireNonNegative(
    isAvailableNow ? settings.providerAcceptSec : settings.providerAcceptSecAdvance,
    isAvailableNow ? "providerAcceptSec" : "providerAcceptSecAdvance",
  );
  const windowMs = isAvailableNow ? seconds * 1000 : Math.min(seconds * 1000, (appointment - start) / 2);
  return new Date(start + windowMs);
};

const attemptDeadline = ({ startedAt, pausedMs, pausedAt, maxAttemptMinutes, now }) => {
  const start = requireDate(startedAt, "startedAt");
  const current = requireDate(now, "now");
  const accumulatedPause = requireNonNegative(pausedMs, "pausedMs");
  const limit = requireNonNegative(maxAttemptMinutes, "maxAttemptMinutes") * 60 * 1000;
  if (current < start) throw new RangeError("now cannot precede startedAt");
  let runningPause = 0;
  if (pausedAt !== null && pausedAt !== undefined) {
    const pauseStart = requireDate(pausedAt, "pausedAt");
    if (pauseStart < start || pauseStart > current) throw new RangeError("pausedAt must be within the attempt");
    runningPause = current - pauseStart;
  }
  return new Date(start + limit + accumulatedPause + runningPause);
};

const windowDeadline = ({ now, seconds, attemptExpiresAt }) => {
  const start = requireDate(now, "now");
  const windowMs = requireNonNegative(seconds, "seconds") * 1000;
  const end = start + windowMs;
  return new Date(attemptExpiresAt === undefined ? end : Math.min(end, requireDate(attemptExpiresAt, "attemptExpiresAt")));
};

module.exports = { providerDeadline, attemptDeadline, windowDeadline };
