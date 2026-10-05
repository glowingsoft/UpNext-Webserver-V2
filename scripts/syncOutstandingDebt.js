/**
 * Rebuilds every user's stored debt state from their bookings.
 *
 * The debt used to live in a single User.outstandingBooking pointer, so each new
 * failed capture overwrote the previous one — a customer with seven unpaid
 * bookings stored one, and the stored id was whichever failed most recently
 * rather than the one to settle next. This recomputes, for every user:
 *
 *   hasOutstandingDebt   any booking with paymentStatus "failed"
 *   outstandingBookings  all of them, oldest first
 *   outstandingAmount    their total
 *   outstandingBooking   the oldest (kept for older clients)
 *
 * Also repairs users whose flag drifted the other way — set true but nothing
 * actually unpaid — which would leave them unable to book at all.
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 * Usage: node scripts/syncOutstandingDebt.js [--dry-run]
 */
const mongoose = require('mongoose');
const path = require('path');
const moduleAlias = require('module-alias');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const aliases = require('../aliasConfig/pathAliases.config');
for (const [alias, target] of Object.entries(aliases)) {
  moduleAlias.addAlias(alias, path.join(__dirname, '..', target));
}
require('module-alias/register');

const { User } = require('../backend/models/UserModel');
const Booking = require('../backend/models/Bookings');
const { getOutstandingDebt, syncDebtLock } = require('../backend/app/services/paymentService');

const MONGO_URI = process.env.BASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');

const sameIds = (a = [], b = []) =>
  a.length === b.length && a.every((id, i) => String(id) === String(b[i]));

const run = async () => {
  // Everyone who either owes something now or is flagged as owing something —
  // a user with neither has nothing to correct.
  const owing = await Booking.distinct('user', { paymentStatus: 'failed' });
  const flagged = await User.distinct('_id', {
    $or: [
      { hasOutstandingDebt: true },
      { outstandingBooking: { $ne: null } },
      { outstandingBookings: { $exists: true, $ne: [] } },
    ],
  });

  const userIds = [...new Map([...owing, ...flagged].map((id) => [String(id), id])).values()];
  console.log(`${userIds.length} user(s) to check (${owing.length} with unpaid bookings)`);

  let changed = 0;
  for (const userId of userIds) {
    const user = await User.findById(userId)
      .select('name email hasOutstandingDebt outstandingBooking outstandingBookings outstandingAmount')
      .lean();
    if (!user) continue;

    const debt = await getOutstandingDebt(userId);
    const wanted = debt.bookings.map((booking) => booking._id);

    const isCurrent =
      user.hasOutstandingDebt === debt.hasDebt &&
      (user.outstandingAmount || 0) === debt.totalAmount &&
      String(user.outstandingBooking ?? null) === String(wanted[0] ?? null) &&
      sameIds(user.outstandingBookings, wanted);

    if (isCurrent) continue;
    changed++;

    console.log(
      `${DRY_RUN ? '[dry-run] ' : ''}${user.name || user.email || userId}: ` +
        `flag ${user.hasOutstandingDebt} -> ${debt.hasDebt}, ` +
        `stored ${(user.outstandingBookings || []).length} -> ${wanted.length} booking(s), ` +
        `amount ${user.outstandingAmount || 0} -> ${debt.totalAmount}`,
    );

    if (!DRY_RUN) await syncDebtLock(userId);
  }

  console.log(`\n${DRY_RUN ? 'would correct' : 'corrected'} ${changed} user(s); ${userIds.length - changed} already current`);
};

async function main() {
  if (!MONGO_URI) {
    console.error('Missing BASE_URL in environment variables.');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);

  try {
    await run();
    console.log('Done.');
  } catch (err) {
    console.error('Sync failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
