// One-off migration for the profile category/serviceType restructure:
//
//   UserProfile      — drop legacy `categories` and `serviceType` (customer
//                      preferences live in badges now)
//   BusinessProfile  — rewrite `categories` from [ObjectId] to the combined
//                      [{ _id, name }] form (names resolved from the
//                      categories collection) and drop legacy `categoryNames`
//
// Uses the native driver so legacy paths the schemas no longer define can
// still be matched and $unset. Safe to re-run: already-migrated docs are
// left untouched.

const mongoose = require("mongoose");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const MONGO_URI = process.env.BASE_URL;

async function main() {
  if (!MONGO_URI) {
    console.error("Missing BASE_URL in environment variables.");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  // ── UserProfile: unset legacy fields ─────────────────────────────
  const userRes = await db.collection("userprofiles").updateMany(
    { $or: [{ categories: { $exists: true } }, { serviceType: { $exists: true } }] },
    { $unset: { categories: "", serviceType: "" } },
  );
  console.log(`UserProfile: cleaned ${userRes.modifiedCount} document(s)`);

  // ── BusinessProfile: combine categories + categoryNames ──────────
  const bizCol = db.collection("businessprofiles");
  const catCol = db.collection("categories");

  // Docs whose categories array still holds plain ObjectIds (no subdoc name)
  const cursor = bizCol.find({
    $or: [
      { categories: { $elemMatch: { $type: "objectId" } } },
      { categoryNames: { $exists: true } },
    ],
  });

  let migrated = 0;
  for await (const doc of cursor) {
    const ids = (doc.categories || []).map((c) => (c && c._id ? c._id : c)).filter(Boolean);

    let combined = [];
    if (ids.length) {
      const catDocs = await catCol.find({ _id: { $in: ids } }).project({ name: 1 }).toArray();
      const nameById = new Map(catDocs.map((c) => [String(c._id), c.name || ""]));
      combined = ids.map((id) => ({ _id: id, name: nameById.get(String(id)) || "" }));
    }

    await bizCol.updateOne(
      { _id: doc._id },
      { $set: { categories: combined }, $unset: { categoryNames: "" } },
    );
    migrated += 1;
  }
  console.log(`BusinessProfile: migrated ${migrated} document(s)`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
