require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("@models/Bookings");
const Payment = require("@models/Payment");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub("../backend/app/services/paymentService", { syncDebtLock: async () => {} });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("@config/stripe", {});
const { handlePaymentCaptured } = require("../backend/services/stripeWebhook");
const original = { paymentFind: Payment.findOne, paymentUpdate: Payment.findOneAndUpdate, booking: Booking.findOne };

test("generic capture webhook does not bypass safeguarded capture reconciliation", async () => {
  let updates = 0;
  Payment.findOne = async () => ({ _id: "payment" });
  Payment.findOneAndUpdate = async () => { updates++; };
  Booking.findOne = async () => ({ capture: { safeguarded: true }, paymentStatus: "capture_retrying" });
  await handlePaymentCaptured({ id: "pi_test", metadata: {}, status: "succeeded", amount_received: 5000 });
  assert.equal(updates, 0);
});

test.after(() => {
  Payment.findOne = original.paymentFind;
  Payment.findOneAndUpdate = original.paymentUpdate;
  Booking.findOne = original.booking;
});
