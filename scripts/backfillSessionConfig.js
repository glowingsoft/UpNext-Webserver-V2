/**
 * One-off backfill: fills in `sessionSlotMins` / `gapBetweenSlotMins` on
 * services and packages that don't have them.
 *
 * Both fields were only ever written in sameAsBusinessHours mode — explicit
 * slots used to clear them — so entities created that way carry a schedule
 * with no session length or gap recorded. That leaves listings without a
 * duration (they project `durationMins: "$sessionSlotMins"`) and, for
 * sameAsBusinessHours docs, makes regenerateBusinessHourSlots produce nothing
 * the next time the business edits its operating hours.
 *
 * The values are measured back from the stored intervals with the same helper
 * the API uses (deriveSessionConfigFromSlots), so a doc backfilled here and one
 * written by the current controllers end up with identical numbers: interval
 * length for the session, distance between consecutive intervals on a day for
 * the gap, rounded average when either varies.
 *
 * Caveat worth knowing: for a schedule built around a mid-day break, the jump
 * across the break counts as one large gap and pulls the average up. It's the
 * same rule the API applies, kept deliberately consistent — spot-check with
 * --dry-run before running live.
 *
 * Only missing fields are written; anything already stored is left alone, so
 * the script is safe to re-run. Docs whose slots have no measurable interval
 * (every day closed/empty) are reported and skipped rather than guessed at.
 *
 * Usage: node scripts/backfillSessionConfig.js [--dry-run]
 */
const mongoose = require("mongoose");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { deriveSessionConfigFromSlots } = require("../backend/helperUtils/serviceUtil");

const MONGO_URI = process.env.BASE_URL;
const DRY_RUN = process.argv.includes("--dry-run");

const backfillCollection = async (collectionName) => {
  const collection = mongoose.connection.collection(collectionName);

  // $in: [null] matches both an explicit null and a missing field.
  const cursor = collection.find({
    $or: [{ sessionSlotMins: { $in: [null] } }, { gapBetweenSlotMins: { $in: [null] } }],
  });

  const ops = [];
  let scanned = 0;
  const skipped = [];

  for await (const doc of cursor) {
    scanned++;
    const measured = deriveSessionConfigFromSlots(doc.slots);

    // Nothing to measure and no session length stored — a duration can't be
    // invented, so leave the doc for a human to look at.
    if (doc.sessionSlotMins == null && measured.sessionSlotMins == null) {
      skipped.push(doc._id);
      continue;
    }

    const update = {};
    if (doc.sessionSlotMins == null) update.sessionSlotMins = measured.sessionSlotMins;
    if (doc.gapBetweenSlotMins == null) update.gapBetweenSlotMins = measured.gapBetweenSlotMins;
    if (Object.keys(update).length === 0) continue;

    if (DRY_RUN) {
      console.log(
        `[dry-run] ${collectionName} ${doc._id} (sameAsBusinessHours: ${!!doc.sameAsBusinessHours}) → ${JSON.stringify(update)}`,
      );
    } else {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: update } } });
    }
  }

  if (!DRY_RUN && ops.length > 0) {
    await collection.bulkWrite(ops);
  }

  const changed = DRY_RUN ? scanned - skipped.length : ops.length;
  console.log(
    `${collectionName}: scanned ${scanned}, ${DRY_RUN ? "would backfill" : "backfilled"} ${changed}, skipped ${skipped.length}`,
  );
  if (skipped.length) {
    console.log(`  no measurable intervals — left untouched: ${skipped.join(", ")}`);
  }
};

async function main() {
  if (!MONGO_URI) {
    console.error("Missing BASE_URL in environment variables.");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);

  try {
    await backfillCollection("services");
    await backfillCollection("packages");
    console.log("Done.");
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
