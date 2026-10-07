/**
 * One-off backfill: builds `search_keywords` (name, description and vision tags
 * of the photos) for existing services and packages so unified search can
 * match them. New/edited records are indexed by the controllers.
 *
 * Sequential on purpose — each doc costs up to a few vision calls. Re-runs are
 * cheap: vision results are cached per image, and only docs still without
 * keywords are processed.
 *
 * Usage: npm run backfill:search
 */
const mongoose = require("mongoose");
const path = require("path");

require("module-alias/register");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { Services } = require("../backend/models/Services");
const { Packages } = require("../backend/models/Packages");
const { indexEntityKeywords } = require("../backend/services/ai/features/indexEntityKeywords");

async function backfill(Model) {
  let count = 0;
  const cursor = Model.find({ status: { $ne: "deleted" }, "search_keywords.0": { $exists: false } })
    .select("name description photos coverImage")
    .cursor();
  for await (const doc of cursor) {
    await indexEntityKeywords(Model, doc);
    count++;
  }
  console.log(`${Model.collection.name}: indexed ${count}`);
}

async function main() {
  if (!process.env.BASE_URL) {
    console.error("Missing BASE_URL in environment variables.");
    process.exit(1);
  }
  await mongoose.connect(process.env.BASE_URL);
  try {
    await backfill(Services);
    await backfill(Packages);
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
