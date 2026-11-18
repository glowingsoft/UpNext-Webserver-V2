require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const Booking = require("@models/Bookings");
const { Promotion } = require("@models/Promotions");
const PromotionUsage = require("@models/PromotionUsage");

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const pricing = require("@utils/instantPricing");
const originalSettings = pricing.getInstantSettings;
pricing.getInstantSettings = async () => ({ ...pricing.INSTANT_DEFAULTS });
stub("../backend/commonModules/controllers/communicationController", { sendUserNotifications: () => {} });
stub("../backend/app/services/instantOfferService", {});
stub("../backend/app/services/instantPaymentService", {});

const { quote, getInstantBooking } = require("../backend/app/services/instantBookingService");
const originals = {
  service: Services.findById,
  package: Packages.findById,
  promotion: Promotion.findOne,
  count: PromotionUsage.countDocuments,
  booking: Booking.findOne,
};
const entity = { _id: "entity", business: "business", name: "Example", price: 50, status: "active", cancellationPolicy: "refundable_24h" };
let promotionFilter;
let totalUsed;
let userUsed;

const prepare = (promotion) => {
  Services.findById = () => ({ lean: async () => entity });
  Packages.findById = () => ({ lean: async () => entity });
  Promotion.findOne = (filter) => {
    promotionFilter = filter;
    return { lean: async () => promotion };
  };
  totalUsed = 0;
  userUsed = 0;
  PromotionUsage.countDocuments = async (filter) => filter.user ? userUsed : totalUsed;
};

test("quote exposes fee, deposit and cancellation policy", async () => {
  prepare(null);
  const result = await quote({ scope: "service", targetId: "entity", userId: "customer" });
  assert.equal(result.data.amountDueCents, 5700);
  assert.equal(result.data.pricing.depositCents, 750);
  assert.equal(result.data.pricing.heldCents, undefined);
  assert.equal(result.data.cancellationPolicy.type, "refundable_24h");
  assert.match(result.data.cancellationPolicy.text, /24 hours/);
});

test("promotion must match target, business, scope and be active and unexpired", async () => {
  prepare(null);
  const result = await quote({ scope: "package", targetId: "entity", promotionId: "promo", userId: "customer" });
  assert.equal(result.error, "promo_code_invalid");
  assert.equal(promotionFilter.business, "business");
  assert.deepEqual(promotionFilter.scope.$in, ["packages", "both"]);
  assert.equal(promotionFilter.status, "active");
  assert.ok(promotionFilter.expiresAt.$gt instanceof Date);
});

test("promotion discounts only the booking fee and obeys both usage limits", async () => {
  prepare({ _id: "promo", discountType: "fixed", discount: 100, totalUsageLimit: 2, perUserLimit: 1 });
  let result = await quote({ scope: "service", targetId: "entity", promotionId: "promo", userId: "customer" });
  assert.equal(result.data.pricing.promoDiscountCents, 700);
  assert.equal(result.data.pricing.servicePriceCents, 5000);
  assert.equal(result.data.amountDueCents, 5000);
  userUsed = 1;
  result = await quote({ scope: "service", targetId: "entity", promotionId: "promo", userId: "customer" });
  assert.equal(result.error, "promotion_user_limit_reached");
  totalUsed = 2;
  result = await quote({ scope: "service", targetId: "entity", promotionId: "promo", userId: "customer" });
  assert.equal(result.error, "promotion_usage_limit_reached");
});

test("booking reads expose the attempt deadline for existing decisions", async () => {
  const attempt = new Date("2026-11-12T12:15:00Z");
  const booking = { status: "awaiting_customer_decision", awaitingDecisionDeadline: new Date("2026-11-12T12:03:00Z"),
    flow: { attemptExpiresAt: attempt } };
  Booking.findOne = () => ({ lean: async () => booking });
  const result = await getInstantBooking({ id: "booking", userId: "customer" });
  assert.equal(result.data.awaitingDecisionDeadline, attempt);
});

test.after(() => {
  Services.findById = originals.service;
  Packages.findById = originals.package;
  Promotion.findOne = originals.promotion;
  PromotionUsage.countDocuments = originals.count;
  Booking.findOne = originals.booking;
  pricing.getInstantSettings = originalSettings;
});
