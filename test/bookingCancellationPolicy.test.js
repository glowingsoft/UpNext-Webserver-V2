require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { clientCancellationCaptureCents } = require("@utils/bookingPolicy");

const now = new Date("2026-11-17T12:00:00Z");
const booking = (policy, isAvailableNow, hours) => ({
  pricing: { depositCents: 1500, chargeFeeCents: 700, totalCents: 10700 },
  cancellationPolicySnapshot: { policy },
  flow: { isAvailableNow, appointmentStart: new Date(now.getTime() + hours * 3600000) },
});

test("refundable advance bookings retain only the fee at least 24 hours ahead", () => {
  assert.equal(clientCancellationCaptureCents(booking("refundable_24h", false, 24), now), 700);
  assert.equal(clientCancellationCaptureCents(booking("refundable_24h", false, 23.99), now), 2200);
});

test("available-now and non-refundable bookings retain deposit plus discounted fee", () => {
  assert.equal(clientCancellationCaptureCents(booking("refundable_24h", true, 0.5), now), 2200);
  assert.equal(clientCancellationCaptureCents(booking("non_refundable", false, 48), now), 2200);
  const discounted = booking("non_refundable", false, 48);
  discounted.pricing.chargeFeeCents = 200;
  assert.equal(clientCancellationCaptureCents(discounted, now), 1700);
});

test("incomplete or inconsistent snapshots cannot determine a charge", () => {
  const invalid = booking("non_refundable", false, 48);
  delete invalid.flow.appointmentStart;
  assert.throws(() => clientCancellationCaptureCents(invalid, now), /Invalid booking cancellation snapshot/);
  invalid.flow.appointmentStart = new Date();
  invalid.pricing.depositCents = 20000;
  assert.throws(() => clientCancellationCaptureCents(invalid, now), /Invalid booking cancellation snapshot/);
});
