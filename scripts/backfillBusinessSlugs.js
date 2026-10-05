// One-off migration: generate `nameSlug` for existing BusinessProfile records
// that don't have one yet, and ensure the unique index exists.
//
// Usage:
//   node scripts/backfillBusinessSlugs.js            # writes slugs
//   node scripts/backfillBusinessSlugs.js --dry-run   # reports only

const mongoose = require("mongoose");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
require("module-alias/register");

const BusinessProfile = require("@models/BusinessProfile");
const { generateUniqueSlug } = require("@utils/slugUtil");

const MONGO_URI = process.env.BASE_URL;
const isDryRun = process.argv.includes("--dry-run");

async function main() {
  if (!MONGO_URI) {
    console.error("Missing BASE_URL in environment variables.");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const cursor = BusinessProfile.find({
    $or: [{ nameSlug: { $exists: false } }, { nameSlug: null }, { nameSlug: "" }],
  })
    .select("_id businessName nameSlug")
    .cursor();

  let migrated = 0;
  for await (const doc of cursor) {
    const slug = await generateUniqueSlug(BusinessProfile, doc.businessName, { excludeId: doc._id });
    console.log(`${doc._id}: "${doc.businessName || ""}" -> "${slug}"`);
    if (!isDryRun) {
      await BusinessProfile.updateOne({ _id: doc._id }, { $set: { nameSlug: slug } });
    }
    migrated += 1;
  }

  console.log(`${isDryRun ? "[dry-run] Would migrate" : "Migrated"} ${migrated} document(s).`);

  // Ensures the unique index defined on the schema exists on the collection.
  if (!isDryRun) {
    await BusinessProfile.syncIndexes();
    console.log("Indexes synced.");
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
