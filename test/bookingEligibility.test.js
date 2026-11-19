require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { savedCardIsValid, resolveScheduledSlot } = require("@utils/bookingEligibility");

const now = new Date("2026-11-11T14:00:00Z");
const input = () => ({
  date: "2026-11-11",
  slot: { open: "09:15", close: "10:00" },
  timezone: "America/New_York",
  slots: [{ dayOfWeek: "Wed", isOpen: true, intervals: [{ open: "09:15", close: "10:00" }] }],
  operatingHours: [{ dayOfWeek: "Wed", isOpen: true, startTime: "08:00", endTime: "18:00", breaks: [] }],
  now,
  maxAdvanceDays: 7,
});

test("card expiration is valid through the end of its expiration month", () => {
  assert.equal(savedCardIsValid({ expMonth: 11, expYear: 2026 }, now), true);
  assert.equal(savedCardIsValid({ expMonth: 10, expYear: 2026 }, now), false);
  assert.equal(savedCardIsValid({ expMonth: 13, expYear: 2027 }, now), false);
  assert.equal(savedCardIsValid({ expMonth: null, expYear: 2027 }, now), false);
});

test("slot resolves in provider timezone and identifies available now", () => {
  const value = resolveScheduledSlot(input());
  assert.equal(value.appointmentStart.toISOString(), "2026-11-11T14:15:00.000Z");
  assert.equal(value.isAvailableNow, true);
  assert.equal(value.slot.isOverNight, false);
});

test("slot must exist in the service schedule and avoid business breaks", () => {
  const data = input();
  data.operatingHours[0].breaks = [{ start: "09:30", end: "09:45" }];
  assert.equal(resolveScheduledSlot(data), null);
  data.operatingHours[0].breaks = [];
  data.slots[0].intervals = [];
  assert.equal(resolveScheduledSlot(data), null);
});

test("rejects invalid timezone, malformed time, expired and beyond limit", () => {
  const data = input();
  data.timezone = "Bad/Timezone";
  assert.equal(resolveScheduledSlot(data), null);
  data.timezone = "America/New_York";
  data.date = "2026-11-11Tinvalid";
  assert.equal(resolveScheduledSlot(data), null);
  data.date = "2026-11-11";
  data.slot.open = "25:00";
  assert.equal(resolveScheduledSlot(data), null);
  data.slot.open = "09:15";
  data.now = new Date("2026-11-11T14:15:00Z");
  assert.equal(resolveScheduledSlot(data), null);
  data.now = new Date("2026-11-04T14:14:59Z");
  assert.equal(resolveScheduledSlot(data), null);
});

test("rejects nonexistent DST wall times", () => {
  const data = input();
  data.date = "2027-03-14";
  data.slot = { open: "02:30", close: "03:30" };
  data.slots = [{ dayOfWeek: "Sun", intervals: [data.slot] }];
  data.operatingHours = [{ dayOfWeek: "Sun", isOpen: true, startTime: "00:00", endTime: "05:00" }];
  data.now = new Date("2027-03-13T00:00:00Z");
  assert.equal(resolveScheduledSlot(data), null);
});

test("overnight intervals fit operating hours without trusting client overnight flag", () => {
  const data = input();
  data.date = "2026-11-11";
  data.slot = { open: "23:00", close: "01:00", isOverNight: false };
  data.slots = [{ dayOfWeek: "Wed", intervals: [data.slot] }];
  data.operatingHours = [{ dayOfWeek: "Wed", isOpen: true, startTime: "22:00", endTime: "02:00", breaks: [] }];
  const result = resolveScheduledSlot(data);
  assert.equal(result.slot.isOverNight, true);
  assert.equal(result.isAvailableNow, false);
});
