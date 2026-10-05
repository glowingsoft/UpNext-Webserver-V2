// ─── Slot Validation Helpers ─────────────────────────────────────
const VALID_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MINS = 24 * 60;

const timeToMins = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Reduces a day schedule ({ isOpen, startTime, endTime, breaks }) to sorted
 * work segments in minutes: [{ start, end }]. `end` may exceed 1440 when the
 * window crosses midnight (endTime <= startTime means overnight).
 * Breaks are subtracted from the window. Returns [] for closed or malformed
 * days — it does NOT validate; run validateSlotsFormat first on user input.
 */
const buildDaySegments = (day) => {
  if (!day || day.isOpen === false) return [];
  if (!TIME_RE.test(day.startTime || "") || !TIME_RE.test(day.endTime || "")) return [];

  const S = timeToMins(day.startTime);
  let E = timeToMins(day.endTime);
  if (E === S) return [];
  if (E < S) E += DAY_MINS; // overnight window

  const breaks = (day.breaks || [])
    .filter((b) => TIME_RE.test(b?.start || "") && TIME_RE.test(b?.end || ""))
    .map((b) => {
      let b0 = timeToMins(b.start);
      if (b0 < S) b0 += DAY_MINS; // break sits in the after-midnight part
      let b1 = timeToMins(b.end);
      if (b1 <= b0) b1 += DAY_MINS;
      return { start: b0, end: b1 };
    })
    .filter((b) => b.start >= S && b.end <= E)
    .sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = S;
  for (const brk of breaks) {
    if (brk.start > cursor) segments.push({ start: cursor, end: brk.start });
    cursor = Math.max(cursor, brk.end);
  }
  if (cursor < E) segments.push({ start: cursor, end: E });
  return segments;
};

/** Returns { translationKey, data } on the first format violation, null if valid. */
const validateSlotsFormat = (slots) => {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { translationKey: "service_slots_required" };
  }

  const seen = new Set();
  for (const day of slots) {
    if (!VALID_DAYS.includes(day.dayOfWeek)) {
      return { translationKey: "slots_invalid_day", data: { day: day.dayOfWeek } };
    }
    if (seen.has(day.dayOfWeek)) {
      return { translationKey: "slots_duplicate_day", data: { day: day.dayOfWeek } };
    }
    seen.add(day.dayOfWeek);

    // Closed days carry no times/breaks; omitted days are closed too.
    if (day.isOpen === false) continue;

    if (!day.startTime || !day.endTime) {
      return { translationKey: "slots_open_day_needs_times", data: { day: day.dayOfWeek } };
    }
    if (!TIME_RE.test(day.startTime) || !TIME_RE.test(day.endTime)) {
      return { translationKey: "slots_invalid_time_format", data: { day: day.dayOfWeek } };
    }

    const S = timeToMins(day.startTime);
    let E = timeToMins(day.endTime);
    if (E === S) {
      return { translationKey: "slots_invalid_time_range", data: { day: day.dayOfWeek } };
    }
    const isOvernightDay = E < S; // e.g. 22:00 → 02:00 crosses midnight
    if (isOvernightDay) E += DAY_MINS;

    const ranges = [];
    for (const brk of day.breaks || []) {
      if (!TIME_RE.test(brk?.start || "") || !TIME_RE.test(brk?.end || "")) {
        return { translationKey: "slots_invalid_time_format", data: { day: day.dayOfWeek } };
      }
      const rawStart = timeToMins(brk.start);
      const rawEnd = timeToMins(brk.end);
      // Same-day window: a break can't wrap midnight, so end must be after start.
      if (rawEnd <= rawStart && !isOvernightDay) {
        return { translationKey: "slots_invalid_break_range", data: { day: day.dayOfWeek } };
      }
      let b0 = rawStart;
      if (b0 < S) b0 += DAY_MINS;
      let b1 = rawEnd;
      if (b1 <= b0) b1 += DAY_MINS;
      if (b0 < S || b1 > E) {
        return { translationKey: "slots_break_outside_window", data: { day: day.dayOfWeek } };
      }
      ranges.push({ start: b0, end: b1 });
    }

    // Breaks must not overlap or repeat; touching breaks are allowed.
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) {
        return { translationKey: "slots_overlapping_breaks", data: { day: day.dayOfWeek } };
      }
    }
  }

  return null;
};

const segmentFitsInSegments = (seg, containers) =>
  containers.some((c) => seg.start >= c.start && seg.end <= c.end);

const fromMinutes = (mins) => {
  const normalized = mins % DAY_MINS;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// ─── Service/Package slots — discrete bookable intervals per day ─
// Shape: [{ dayOfWeek, isOpen, intervals: [{ open, close, isOvernight }] }]
// isOvernight is derived: close <= open means the interval crosses midnight.

/** Normalizes an { open, close } interval to minutes; close may exceed 1440. */
const intervalToRange = (interval) => {
  const start = timeToMins(interval.open);
  let end = timeToMins(interval.close);
  if (end <= start) end += DAY_MINS;
  return { start, end };
};

/** Returns { translationKey, data } on the first violation, null if valid. */
const validateServiceSlots = (slots) => {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { translationKey: "service_slots_required" };
  }

  const seen = new Set();
  for (const day of slots) {
    if (!VALID_DAYS.includes(day.dayOfWeek)) {
      return { translationKey: "slots_invalid_day", data: { day: day.dayOfWeek } };
    }
    if (seen.has(day.dayOfWeek)) {
      return { translationKey: "slots_duplicate_day", data: { day: day.dayOfWeek } };
    }
    seen.add(day.dayOfWeek);

    if (day.isOpen === false) continue;

    if (!Array.isArray(day.intervals) || day.intervals.length === 0) {
      return { translationKey: "slots_open_day_needs_slots", data: { day: day.dayOfWeek } };
    }

    const ranges = [];
    for (const interval of day.intervals) {
      if (!TIME_RE.test(interval?.open || "") || !TIME_RE.test(interval?.close || "")) {
        return { translationKey: "slots_invalid_time_format", data: { day: day.dayOfWeek } };
      }
      if (interval.open === interval.close) {
        return { translationKey: "slots_invalid_time_range", data: { day: day.dayOfWeek } };
      }
      ranges.push(intervalToRange(interval));
    }

    // Pairwise overlap check with midnight wrap (lists are small).
    // Touching slots (end == next start) are allowed.
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        const overlaps =
          (a.start < b.end && b.start < a.end) ||
          (a.start < b.end + DAY_MINS && b.start + DAY_MINS < a.end) ||
          (a.start + DAY_MINS < b.end && b.start < a.end + DAY_MINS);
        if (overlaps) {
          return { translationKey: "slots_overlapping", data: { day: day.dayOfWeek } };
        }
      }
    }
  }

  return null;
};

/**
 * Every explicit interval must sit inside the business working window for
 * that day, outside its breaks (breaks split the segments), and only on days
 * the business works. Returns { translationKey, data } or null.
 */
const validateServiceSlotsAgainstOperatingHours = (slots, operatingHours) => {
  if (!slots || slots.length === 0) return null;

  const bizByDay = Object.fromEntries((operatingHours || []).map((d) => [d.dayOfWeek, d]));

  for (const slotDay of slots) {
    if (slotDay.isOpen === false) continue;

    const bizDay = bizByDay[slotDay.dayOfWeek];
    if (!bizDay || !bizDay.isOpen) {
      return { translationKey: "slot_day_not_in_operating_hours", data: { day: slotDay.dayOfWeek } };
    }

    const bizSegments = buildDaySegments(bizDay);
    for (const interval of slotDay.intervals || []) {
      const seg = intervalToRange(interval);
      const shifted = { start: seg.start + DAY_MINS, end: seg.end + DAY_MINS };
      if (!segmentFitsInSegments(seg, bizSegments) && !segmentFitsInSegments(shifted, bizSegments)) {
        return { translationKey: "service_slot_exceeds_operating_hours", data: { day: slotDay.dayOfWeek } };
      }
    }
  }

  return null;
};

/** Divides one operating-hours day (minus breaks) into bookable intervals. */
const generateDaySlots = (day, sessionSlotMins, gapBetweenSlotMins = 0) => {
  const out = [];
  if (!Number.isInteger(sessionSlotMins) || sessionSlotMins <= 0) return out;
  const gap = Number.isInteger(gapBetweenSlotMins) && gapBetweenSlotMins > 0 ? gapBetweenSlotMins : 0;
  for (const seg of buildDaySegments(day)) {
    let start = seg.start;
    while (start + sessionSlotMins <= seg.end) {
      const end = start + sessionSlotMins;
      // end === DAY_MINS closes at "00:00", which already belongs to the next day
      out.push({ open: fromMinutes(start), close: fromMinutes(end), isOvernight: end >= DAY_MINS });
      start = end + gap;
    }
  }
  return out;
};

const average = (nums) => Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);

/**
 * Measures the session config of explicit intervals — the counterpart of
 * generateDaySlots. Business-hours mode gets sessionSlotMins/gapBetweenSlotMins
 * from the business; explicit mode derives them so duration (used as
 * durationMins on listings) and gap stay populated in both modes.
 *
 * sessionSlotMins is the interval length and gapBetweenSlotMins the distance
 * between consecutive intervals on the same day; when a business mixes lengths
 * or gaps, the rounded average across the week is used. Days are measured
 * independently — the wrap from one day's last interval to the next day's
 * first is not a gap.
 *
 * Returns { sessionSlotMins: null, gapBetweenSlotMins: 0 } when there is
 * nothing to measure (every day closed or empty).
 */
const deriveSessionConfigFromSlots = (slots) => {
  const durations = [];
  const gaps = [];

  for (const day of slots || []) {
    if (!day || day.isOpen === false) continue;

    const ranges = (day.intervals || [])
      .filter((i) => TIME_RE.test(i?.open || "") && TIME_RE.test(i?.close || "") && i.open !== i.close)
      .map(intervalToRange)
      .sort((a, b) => a.start - b.start);

    for (const range of ranges) durations.push(range.end - range.start);
    for (let i = 1; i < ranges.length; i++) {
      const gap = ranges[i].start - ranges[i - 1].end;
      // Negative means overlapping intervals — rejected by validateServiceSlots,
      // so this only guards callers that skipped validation.
      if (gap >= 0) gaps.push(gap);
    }
  }

  return {
    sessionSlotMins: durations.length ? average(durations) : null,
    gapBetweenSlotMins: gaps.length ? average(gaps) : 0,
  };
};

/**
 * Validates business-hours mode config: sessionSlotMins must be a positive
 * integer; gapBetweenSlotMins may be null/undefined (no gap) or a
 * non-negative integer. Returns { translationKey } or null.
 */
const validateSessionConfig = (sessionSlotMins, gapBetweenSlotMins) => {
  if (!Number.isInteger(sessionSlotMins) || sessionSlotMins <= 0) {
    return { translationKey: "session_slot_mins_invalid" };
  }
  if (gapBetweenSlotMins != null && (!Number.isInteger(gapBetweenSlotMins) || gapBetweenSlotMins < 0)) {
    return { translationKey: "gap_between_slot_mins_invalid" };
  }
  return null;
};

/**
 * Auto-generates the weekly slot schedule from business operating hours —
 * stored on the service/package when sameAsBusinessHours is true. Only days
 * present and open in the operating hours produce intervals; sessions never
 * touch breaks (buildDaySegments subtracts them).
 */
const generateWeeklySlots = (operatingHours, sessionSlotMins, gapBetweenSlotMins = 0) =>
  (operatingHours || []).map((day) =>
    day.isOpen
      ? {
          dayOfWeek: day.dayOfWeek,
          isOpen: true,
          intervals: generateDaySlots(day, sessionSlotMins, gapBetweenSlotMins),
        }
      : { dayOfWeek: day.dayOfWeek, isOpen: false, intervals: [] },
  );

/**
 * Re-materializes the stored slots of every service/package that follows the
 * business hours (sameAsBusinessHours: true). Must be called after a
 * business's operatingHours change, or their stored sessions go stale.
 */
const regenerateBusinessHourSlots = async (businessProfileId, operatingHours) => {
  if (!businessProfileId || !Array.isArray(operatingHours)) return;
  // Lazy requires: this helper is loaded by model-free scripts too.
  const { Services } = require("@models/Services");
  const { Packages } = require("@models/Packages");

  for (const Model of [Services, Packages]) {
    const docs = await Model.find({ business: businessProfileId, sameAsBusinessHours: true }).select(
      "sessionSlotMins gapBetweenSlotMins",
    );
    if (!docs.length) continue;
    await Model.bulkWrite(
      docs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: { slots: generateWeeklySlots(operatingHours, d.sessionSlotMins, d.gapBetweenSlotMins || 0) },
          },
        },
      })),
    );
  }
};

/**
 * Resolves a service/package `category` input to a ServiceCategory id owned
 * by this business — either an existing id belonging to the business, or a
 * freeform name that gets created on the spot (find-or-create, case-insensitive).
 * Returns { id } on success or { errorKey } when the input is an id that
 * doesn't belong to this business.
 */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const resolveServiceCategory = async (businessId, categoryInput) => {
  const mongoose = require("mongoose");
  const ServiceCategory = require("@models/ServiceCategory");

  const raw = typeof categoryInput === "string" ? categoryInput.trim() : categoryInput;

  if (mongoose.Types.ObjectId.isValid(raw)) {
    const existing = await ServiceCategory.findOne({ _id: raw, business: businessId }).select("_id").lean();
    if (existing) return { id: existing._id };
    return { errorKey: "service_category_not_allowed" };
  }

  const name = String(raw || "").trim();
  if (!name) return { errorKey: "service_category_not_allowed" };

  const category = await ServiceCategory.findOneAndUpdate(
    { business: businessId, name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } },
    { $setOnInsert: { business: businessId, name } },
    { upsert: true, new: true },
  );
  return { id: category._id };
};

module.exports = {
  escapeRegex,
  timeToMins,
  buildDaySegments,
  validateSlotsFormat,
  validateServiceSlots,
  validateServiceSlotsAgainstOperatingHours,
  validateSessionConfig,
  deriveSessionConfigFromSlots,
  generateDaySlots,
  generateWeeklySlots,
  regenerateBusinessHourSlots,
  resolveServiceCategory,
};
