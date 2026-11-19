const moment = require("moment-timezone");
const { buildDaySegments } = require("@utils/serviceUtil");

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const instantTestFlowEnabled = () => !["prod", "production"].includes(process.env.NODE_ENV) &&
  /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || "");

const savedCardIsValid = (card, now = new Date()) => {
  if (!card || !Number.isInteger(card.expMonth) || card.expMonth < 1 || card.expMonth > 12 ||
      !Number.isInteger(card.expYear) || card.expYear < 1 || !Number.isFinite(now.getTime())) return false;
  return card.expYear > now.getUTCFullYear() ||
    (card.expYear === now.getUTCFullYear() && card.expMonth >= now.getUTCMonth() + 1);
};

const resolveScheduledSlot = ({ date, slot, timezone, slots, operatingHours, now, maxAdvanceDays }) => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) ||
      (date.length > 10 && !moment.parseZone(date, moment.ISO_8601, true).isValid()) ||
      !slot || !TIME_PATTERN.test(slot.open || "") || !TIME_PATTERN.test(slot.close || "") ||
      slot.open === slot.close || typeof timezone !== "string" || !moment.tz.zone(timezone) ||
      !Array.isArray(slots) || !Array.isArray(operatingHours) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isFinite(maxAdvanceDays) || maxAdvanceDays <= 0) return null;

  const datePart = date.slice(0, 10);
  if (!moment.utc(datePart, "YYYY-MM-DD", true).isValid()) return null;
  const dayIndex = moment.utc(datePart, "YYYY-MM-DD", true).day();
  const dayName = DAY_NAMES[dayIndex];
  const day = slots.find((item) => item.dayOfWeek === dayName && item.isOpen !== false);
  if (!day?.intervals?.some((interval) => interval.open === slot.open && interval.close === slot.close)) return null;

  const startMinute = minutes(slot.open);
  let endMinute = minutes(slot.close);
  if (endMinute <= startMinute) endMinute += 1440;
  const businessDay = operatingHours.find((item) => item.dayOfWeek === dayName);
  if (!buildDaySegments(businessDay).some((part) => startMinute >= part.start && endMinute <= part.end)) return null;

  const wallTime = `${datePart} ${slot.open}`;
  const start = moment.tz(wallTime, "YYYY-MM-DD HH:mm", true, timezone);
  if (!start.isValid() || start.format("YYYY-MM-DD HH:mm") !== wallTime) return null;
  const appointmentStart = start.toDate();
  const remainingMs = appointmentStart.getTime() - now.getTime();
  if (remainingMs <= 0 || remainingMs > maxAdvanceDays * 86400000) return null;
  return {
    date: moment.utc(datePart, "YYYY-MM-DD", true).toDate(),
    appointmentStart,
    isAvailableNow: remainingMs <= 30 * 60 * 1000,
    slot: { open: slot.open, close: slot.close, isOverNight: endMinute > 1440 },
  };
};

module.exports = { savedCardIsValid, resolveScheduledSlot, instantTestFlowEnabled };
