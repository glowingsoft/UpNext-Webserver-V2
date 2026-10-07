const moment = require("moment-timezone");

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKEND = ["Sat", "Sun"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_PARTS = { morning: [360, 720], afternoon: [720, 1020], evening: [1020, 1320] };
const END_OF_DAY = 1440;

const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const prevDay = (day) => DAYS[(DAYS.indexOf(day) + 6) % 7];

const toMinutes = (value) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// ─── Parsing ────────────────────────────────────────────────────────────────

// "Sat,Sun" / "monday" / "weekend" / "weekdays" / "today" / "tomorrow" → ["Sat","Sun"]
function resolveDays(value, tz) {
  const zone = tz && moment.tz.zone(tz) ? tz : "UTC";
  const out = new Set();
  String(value || "")
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean)
    .forEach((token) => {
      if (token === "weekend" || token === "weekends") WEEKEND.forEach((d) => out.add(d));
      else if (token === "weekday" || token === "weekdays") WEEKDAYS.forEach((d) => out.add(d));
      else if (token === "today") out.add(moment.tz(zone).format("ddd"));
      else if (token === "tomorrow") out.add(moment.tz(zone).add(1, "day").format("ddd"));
      else {
        const day = DAYS.find((d) => d.toLowerCase() === token.slice(0, 3));
        if (day) out.add(day);
      }
    });
  return DAYS.filter((d) => out.has(d));
}

// Request params → { days, lo, hi } with the window as minutes-of-day, or null
// when no availability was asked for.
//   openOn=Sat,Sun | weekend | today …   days (any of them)
//   date=YYYY-MM-DD                       that date's weekday (only if useDate)
//   time=HH:mm                            a point in time
//   timeFrom / timeTo=HH:mm               a range — matches when the business
//                                         is open at any moment inside it
// A day with no time means "open at all that day"; a time with no day means
// "on any day". timeTo at or before timeFrom runs to the end of the day.
function parseAvailability(query = {}, { tz, useDate = false } = {}) {
  const days = resolveDays(query.openOn, tz);
  if (useDate && query.date) {
    const date = moment(query.date, "YYYY-MM-DD", true);
    if (date.isValid() && !days.includes(date.format("ddd"))) days.push(date.format("ddd"));
  }
  const from = toMinutes(query.timeFrom ?? query.time);
  const to = toMinutes(query.timeTo);
  if (!days.length && from == null && to == null) return null;

  const lo = from ?? 0;
  const hi = to != null && to > lo ? to : from != null && to == null ? from + 1 : END_OF_DAY;
  return { days: days.length ? days : DAYS, lo, hi };
}

// ─── Mongo predicates ───────────────────────────────────────────────────────

// BusinessProfile.operatingHours: { dayOfWeek, isOpen, startTime, endTime, breaks[] }.
// Overnight (endTime <= startTime) can't be told apart without comparing two
// fields of the same element, which $elemMatch can't do — hence $expr.
function businessHoursFilter({ days, lo, hi }) {
  const [L, H] = [hhmm(lo), hhmm(hi)];
  const f = (field) => `$$h.${field}`;
  const overnight = { $lte: [f("endTime"), f("startTime")] };
  // A break swallowing the whole window means the business is resting through it.
  const onBreak = {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: [f("breaks"), []] },
        as: "b",
        in: { $and: [{ $lte: ["$$b.start", L] }, { $gte: ["$$b.end", H] }] },
      },
    },
  };
  const onDay = (day) => ({
    $or: [
      {
        $and: [
          { $eq: [f("dayOfWeek"), day] },
          { $not: [overnight] },
          { $lt: [f("startTime"), H] },
          { $gt: [f("endTime"), L] },
          { $not: [onBreak] },
        ],
      },
      // Evening part of a shift that runs past midnight
      { $and: [{ $eq: [f("dayOfWeek"), day] }, overnight, { $lt: [f("startTime"), H] }, { $not: [onBreak] }] },
      // Early-morning spill of yesterday's overnight shift
      { $and: [{ $eq: [f("dayOfWeek"), prevDay(day)] }, overnight, { $gt: [f("endTime"), L] }] },
    ],
  });

  return {
    $expr: {
      $anyElementTrue: {
        $map: {
          input: { $ifNull: ["$operatingHours", []] },
          as: "h",
          in: { $and: [{ $eq: [f("isOpen"), true] }, { $or: days.map(onDay) }] },
        },
      },
    },
  };
}

// Service/Package slots: [{ dayOfWeek, isOpen, intervals: [{ open, close, isOvernight }] }].
// The overnight flag is stored, so plain index-friendly $elemMatch is enough.
function slotsFilter({ days, lo, hi }) {
  const [L, H] = [hhmm(lo), hhmm(hi)];
  const onDay = (dayOfWeek, intervals) => ({
    slots: { $elemMatch: { dayOfWeek, isOpen: true, intervals: { $elemMatch: intervals } } },
  });
  return {
    $or: days.flatMap((day) => [
      onDay(day, { isOvernight: { $ne: true }, open: { $lt: H }, close: { $gt: L } }),
      onDay(day, { isOvernight: true, open: { $lt: H } }),
      onDay(prevDay(day), { isOvernight: true, close: { $gt: L } }),
    ]),
  };
}

// Adds the availability clause (if the request asks for one) under $and, which
// survives callers that overwrite `filter.$or` (category filters do).
function applyAvailability(filter, req, kind, { useDate = false } = {}) {
  const query = req?.query || {};
  const availability = parseAvailability(query, { tz: query.tz || req?.user?.timezone, useDate });
  if (!availability) return filter;

  const clause = kind === "business" ? businessHoursFilter(availability) : slotsFilter(availability);
  filter.$and = [...(filter.$and || []), clause];
  return filter;
}

// ─── Keyword extraction ─────────────────────────────────────────────────────

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const RANGE_RE = new RegExp(String.raw`\b(from|between)?\s*${TIME}\s*(?:-|to|until|till|and)\s*${TIME}\b`, "i");
const POINT_RE = new RegExp(String.raw`\b(at\s+)?${TIME}\b`, "i");
const DAY_RE = /\b(?:(mon|tues|wednes|thurs|fri|satur|sun)day|(weekend|weekday|today|tomorrow))s?\b/gi;
const PART_RE = /\b(morning|afternoon|evening)s?\b/i;
const FILLER_RE = /\b(open|opens|opened|available|availability|on|at|this|next|every|during|the|from|between)\b/gi;

const clock = (h, m, meridiem) => {
  let hours = Number(h);
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return hours > 23 || Number(m || 0) > 59 ? null : hours * 60 + Number(m || 0);
};

// "bridal makeup open this weekend from 9am to 12pm" →
//   { text: "bridal makeup", availability: { openOn: "weekend", timeFrom: "09:00", timeTo: "12:00" } }
// Pure regex — no AI call — so it is free and deterministic. The phrases are
// cut out of the text so words like "open" never reach the text match, and the
// result is the same param shape parseAvailability reads. `null` availability
// leaves the text untouched.
function extractAvailability(input) {
  let text = String(input || "");
  const found = { days: [], from: null, to: null };

  text = text.replace(DAY_RE, (match, dayStem, keyword) => {
    found.days.push(dayStem ? `${dayStem}day` : keyword);
    return " ";
  });

  text = text.replace(RANGE_RE, (match, lead, h1, m1, mer1, h2, m2, mer2) => {
    if (!(lead || m1 || m2 || mer1 || mer2)) return match; // "2 and 3 bedroom"
    const end = clock(h2, m2, mer2);
    let start = clock(h1, m1, mer1 || mer2);
    if (start != null && end != null && start >= end) start = clock(h1, m1, "am");
    if (start == null || end == null) return match;
    [found.from, found.to] = [start, end];
    return " ";
  });

  if (found.from == null) {
    text = text.replace(POINT_RE, (match, at, h, m, mer) => {
      if (found.from != null || !(at || m || mer)) return match; // a bare number isn't a time
      const point = clock(h, m, mer);
      if (point == null) return match;
      found.from = point;
      return " ";
    });
  }

  if (found.from == null) {
    text = text.replace(PART_RE, (match, part) => {
      [found.from, found.to] = DAY_PARTS[part.toLowerCase()];
      return " ";
    });
  }

  if (!found.days.length && found.from == null) return { text: String(input || ""), availability: null };

  const availability = {};
  if (found.days.length) availability.openOn = [...new Set(found.days.map((d) => d.toLowerCase()))].join(",");
  if (found.from != null) availability.timeFrom = hhmm(found.from);
  if (found.to != null) availability.timeTo = hhmm(found.to);
  return { text: text.replace(FILLER_RE, " ").replace(/\s+/g, " ").trim(), availability };
}

module.exports = { parseAvailability, applyAvailability, extractAvailability };
