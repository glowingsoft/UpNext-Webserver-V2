const test = require("node:test");
const assert = require("node:assert/strict");
const { providerDeadline, attemptDeadline, windowDeadline } = require("../backend/helperUtils/bookingDeadlines");

const now = new Date("2026-11-11T12:00:00Z");
const settings = { providerAcceptSec: 120, providerAcceptSecAdvance: 1800 };
const at = (seconds) => new Date(now.getTime() + seconds * 1000);

test("available-now offer gets the configured 120-second window", () => {
  assert.deepEqual(providerDeadline({ now, appointmentStart: at(600), isAvailableNow: true, settings }), at(120));
});

test("advance offers get 30 minutes or half the time to the appointment", () => {
  assert.deepEqual(providerDeadline({ now, appointmentStart: at(7200), isAvailableNow: false, settings }), at(1800));
  assert.deepEqual(providerDeadline({ now, appointmentStart: at(1200), isAvailableNow: false, settings }), at(600));
});

test("advance offer time is excluded from the attempt clock", () => {
  assert.deepEqual(
    attemptDeadline({ startedAt: now, pausedMs: 120000, pausedAt: at(180), now: at(1980), maxAttemptMinutes: 15 }),
    at(2820),
  );
  assert.deepEqual(
    attemptDeadline({ startedAt: now, pausedMs: 1920000, now: at(1980), maxAttemptMinutes: 15 }),
    at(2820),
  );
});

test("payment and decision windows can be capped by the active attempt", () => {
  assert.deepEqual(windowDeadline({ now, seconds: 300 }), at(300));
  assert.deepEqual(windowDeadline({ now, seconds: 180, attemptExpiresAt: at(90) }), at(90));
});

test("rejects malformed deadlines instead of silently constructing invalid dates", () => {
  assert.throws(() => providerDeadline({ now, appointmentStart: at(-1), isAvailableNow: false, settings }), RangeError);
  assert.throws(() => attemptDeadline({ startedAt: now, pausedMs: -1, now, maxAttemptMinutes: 15 }), TypeError);
  assert.throws(() => windowDeadline({ now, seconds: NaN }), TypeError);
});
