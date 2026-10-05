/**
 * One-off migration: brings service/package `slots` to the final discrete
 * intervals shape
 *   { dayOfWeek, isOpen, intervals: [{ open, close, isOvernight }] }
 * from either older shape:
 *   - window + breaks: { dayOfWeek, isOpen, startTime, endTime, breaks: [...] }
 *   - interim discrete: { dayOfWeek, isOpen, slots: [{ start, end }] }
 *
 * Rules:
 * - sameAsBusinessHours docs get their intervals materialized from the
 *   business operatingHours using the stored sessionSlotMins/gapBetweenSlotMins
 *   (work segments as-is when no sessionSlotMins is stored).
 * - custom docs: each day's stored blocks become intervals, preserving times.
 *
 * BusinessProfile.operatingHours keeps the window + breaks shape — untouched.
 * Idempotent — docs already carrying `intervals` (and biz-mode docs with
 * non-empty intervals) are not matched.
 *
 * Usage: node scripts/migrateServiceSlots.js [--dry-run]
 */
const mongoose = require('mongoose');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { buildDaySegments, generateWeeklySlots } = require('../backend/helperUtils/serviceUtil');

const MONGO_URI = process.env.BASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');
const DAY_MINS = 24 * 60;

const timeToMins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

const fromMinutes = (mins) => {
  const normalized = mins % DAY_MINS;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const convertDay = (day) => {
  if (day.isOpen === false) return { dayOfWeek: day.dayOfWeek, isOpen: false, intervals: [] };

  let intervals;
  if (Array.isArray(day.intervals)) {
    // already the final shape
    intervals = day.intervals.map((i) => ({
      open: i.open,
      close: i.close,
      isOvernight: i.isOvernight ?? timeToMins(i.close) <= timeToMins(i.open),
    }));
  } else if (Array.isArray(day.slots)) {
    // interim discrete { start, end }
    intervals = day.slots.map((s) => ({
      open: s.start,
      close: s.end,
      isOvernight: timeToMins(s.end) <= timeToMins(s.start),
    }));
  } else {
    // window + breaks → one interval per work segment
    intervals = buildDaySegments(day).map((seg) => ({
      open: fromMinutes(seg.start),
      close: fromMinutes(seg.end),
      isOvernight: seg.end >= DAY_MINS, // end at "00:00" already belongs to the next day
    }));
  }
  return { dayOfWeek: day.dayOfWeek, isOpen: intervals.length > 0, intervals };
};

const migrateCollection = async (collectionName) => {
  // Native collection access — the Mongoose schema would strip old fields.
  const db = mongoose.connection;
  const collection = db.collection(collectionName);
  const businessProfiles = db.collection('businessprofiles');

  const cursor = collection.find({
    $or: [
      { 'slots.startTime': { $exists: true } }, // window + breaks
      { 'slots.slots': { $exists: true } }, // interim discrete
      { sameAsBusinessHours: true, 'slots.0.intervals.0': { $exists: false } }, // biz-mode, not materialized
    ],
  });

  const ops = [];
  let count = 0;
  for await (const doc of cursor) {
    count++;
    let converted;
    if (doc.sameAsBusinessHours) {
      const profile = await businessProfiles.findOne({ _id: doc.business }, { projection: { operatingHours: 1 } });
      const hours = profile?.operatingHours || [];
      if (Number.isInteger(doc.sessionSlotMins) && doc.sessionSlotMins > 0) {
        converted = generateWeeklySlots(hours, doc.sessionSlotMins, doc.gapBetweenSlotMins || 0);
      } else {
        // no session length stored — store the work segments as intervals
        converted = hours.map(convertDay);
      }
    } else {
      converted = (doc.slots || []).map(convertDay);
    }

    if (DRY_RUN) {
      console.log(`[dry-run] ${collectionName} ${doc._id} (sameAsBusinessHours: ${!!doc.sameAsBusinessHours}):`);
      console.log(JSON.stringify(converted, null, 2));
    } else {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { slots: converted } } } });
    }
  }

  if (!DRY_RUN && ops.length > 0) {
    await collection.bulkWrite(ops);
  }
  console.log(`${collectionName}.slots: ${DRY_RUN ? 'would migrate' : 'migrated'} ${count} document(s)`);
};

async function main() {
  if (!MONGO_URI) {
    console.error('Missing BASE_URL in environment variables.');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);

  try {
    await migrateCollection('services');
    await migrateCollection('packages');
    console.log('Done.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
