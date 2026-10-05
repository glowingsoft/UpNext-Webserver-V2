/**
 * One-off migration: converts day schedules from the old work-interval shape
 *   { dayOfWeek, isOpen, intervals: [{ open, close, isOvernight }] }
 * to the new window + breaks shape
 *   { dayOfWeek, isOpen, startTime, endTime, breaks: [{ start, end }] }
 *
 * Rule: startTime = first interval open, endTime = last interval close,
 * breaks = gaps between consecutive sorted intervals (touching → no break).
 *
 * Targets: businessprofiles.operatingHours, services.slots, packages.slots.
 * Idempotent — only documents still carrying `intervals` are matched.
 *
 * Usage: node scripts/migrateOperatingHours.js [--dry-run]
 */
const mongoose = require('mongoose');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.BASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');
const DAY_MINS = 24 * 60;

const timeToMins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

const convertDay = (day) => {
  const base = { dayOfWeek: day.dayOfWeek, isOpen: day.isOpen !== false, breaks: [] };

  const intervals = Array.isArray(day.intervals) ? day.intervals : [];
  if (!base.isOpen || intervals.length === 0) {
    return { dayOfWeek: day.dayOfWeek, isOpen: false, breaks: [] };
  }

  // Sort by open time; an overnight interval's close gets +24h so ordering
  // and gap detection work across midnight.
  const sorted = intervals
    .map((i) => {
      const open = timeToMins(i.open);
      let close = timeToMins(i.close);
      if (i.isOvernight && close <= open) close += DAY_MINS;
      return { ...i, _open: open, _close: close };
    })
    .sort((a, b) => a._open - b._open);

  base.startTime = sorted[0].open;
  base.endTime = sorted[sorted.length - 1].close; // overnight → endTime < startTime, inferred by new model

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]._open > sorted[i - 1]._close) {
      base.breaks.push({ start: sorted[i - 1].close, end: sorted[i].open });
    }
  }
  return base;
};

const migrateCollection = async (collectionName, field) => {
  // Native collection access — the new Mongoose schema would strip the old
  // `intervals` field on read.
  const collection = mongoose.connection.collection(collectionName);
  const cursor = collection.find({ [`${field}.intervals`]: { $exists: true } });

  const ops = [];
  let count = 0;
  for await (const doc of cursor) {
    count++;
    const converted = (doc[field] || []).map(convertDay);
    if (DRY_RUN) {
      console.log(`[dry-run] ${collectionName} ${doc._id}:`);
      console.log(JSON.stringify(converted, null, 2));
    } else {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [field]: converted } } } });
    }
  }

  if (!DRY_RUN && ops.length > 0) {
    await collection.bulkWrite(ops);
  }
  console.log(`${collectionName}.${field}: ${DRY_RUN ? 'would migrate' : 'migrated'} ${count} document(s)`);
};

async function main() {
  if (!MONGO_URI) {
    console.error('Missing BASE_URL in environment variables.');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);

  try {
    await migrateCollection('businessprofiles', 'operatingHours');
    await migrateCollection('services', 'slots');
    await migrateCollection('packages', 'slots');
    console.log('Done.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
