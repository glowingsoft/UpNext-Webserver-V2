/**
 * Builds the indexes the Up Next instant flow depends on. Mongoose autoIndex
 * already does this on connect (it is not disabled in server-setup.js), so this
 * is for environments where autoIndex is off or an index build must be run on
 * demand. Idempotent.
 *
 *   BusinessProfile    2dsphere on location
 *   BookingOffer       sweeper indexes and one pending offer per booking
 *   Booking            sweeper indexes and one active attempt per customer
 *   ProviderPenalty    { provider, createdAt }, unique { booking, type }
 *
 * The active-attempt partial index uses $in, requiring MongoDB 6.0 or later.
 * Existing duplicate active attempts or pending offers make index creation fail;
 * this script does not modify or remove booking data.
 *
 * Usage: npm run db:indexes
 */
const mongoose = require("mongoose");
const path = require("path");
const moduleAlias = require("module-alias");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const aliases = require("../aliasConfig/pathAliases.config");
for (const [alias, target] of Object.entries(aliases)) {
  moduleAlias.addAlias(alias, path.join(__dirname, "..", target));
}

const MODELS = ["@models/BusinessProfile", "@models/BookingOffer", "@models/Bookings", "@models/ProviderPenalty"];

(async () => {
  await mongoose.connect(process.env.BASE_URL);
  try {
    for (const modelPath of MODELS) {
      const Model = require(modelPath);
      await Model.createIndexes();
      const indexes = await Model.collection.indexes();
      console.log(`${Model.modelName}: ${indexes.map((i) => i.name).join(", ")}`);
    }
    console.log("\n✅ All indexes created successfully");
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
