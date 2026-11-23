require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const Booking = require("@models/Bookings");
const BusinessProfile = require("@models/BusinessProfile");
const { User } = require("@models/UserModel");
const { Promotion } = require("@models/Promotions");
const PromotionUsage = require("@models/PromotionUsage");
const Review = require("@models/Review");
const Conversation = require("../backend/commonModules/chatModule/models/Conversation");

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
  business: BusinessProfile.findById,
  user: User.findById,
  review: Review.aggregate,
  reviewForBooking: Review.findOne,
  conversation: Conversation.findOne,
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
  const targetId = "507f1f77bcf86cd799439011";
  const booking = {
    _id: "booking",
    status: "awaiting_customer_decision",
    user: "customer",
    business: "business",
    scope: "service",
    target: [{ _id: targetId, name: "Booked service", price: 75, preferredServiceType: "At Business Location" }],
    flow: {
      attemptExpiresAt: attempt,
      location: { type: "Point", coordinates: [-73.9, 40.7] },
    },
    capture: { stripeFeeCents: 25, chargeId: "ch_secret" },
    payout: { netCents: 5000 },
    cancellation: {
      providerCancellationNumber: 2,
      providerPenalty: "penalty-id",
      warningIssued: true,
      rankingReductionApplied: true,
      suspendedUntil: new Date("2026-11-13T12:00:00Z"),
      reason: "provider_unavailable",
    },
  };
  Booking.findOne = () => ({ lean: async () => booking });
  Services.findById = () => ({
    lean: async () => ({
      name: "Live service",
      price: 80,
      description: "Service details",
      photos: ["https://cdn.example/service.jpg"],
      sessionSlotMins: 45,
    }),
  });
  Review.aggregate = async () => [{ avgRating: 4.7, totalReviews: 12 }];
  Review.findOne = () => ({
    populate: () => ({
      lean: async () => ({
        _id: "review",
        reviewType: "services",
        object: targetId,
        subject: { _id: "customer", name: "Customer", profileIcon: "https://cdn.example/customer.jpg" },
        __v: 0,
        status: "approved",
        rating: 5,
        comment: "Great booking",
        booking: "booking",
      }),
    }),
  });
  Conversation.findOne = () => ({
    lean: async () => ({ _id: "conversation-id", chatStatus: "open" }),
  });
  BusinessProfile.findById = () => ({
    lean: async () => ({ _id: "business", businessName: "Studio", image: "https://cdn.example/studio.jpg",
      user: "provider-user", location: { address: "123 Main St", coordinates: [-73.8, 40.8] } }),
  });
  User.findById = (id) => ({
    lean: async () => id === "customer"
      ? { _id: "customer", name: "Customer", profileIcon: "https://cdn.example/customer.jpg", email: "customer@example.com" }
      : { _id: "provider-user", email: "provider@example.com" },
  });
  const result = await getInstantBooking({ id: "booking", userId: "customer" });
  assert.equal(result.data.awaitingDecisionDeadline, attempt);
  assert.deepEqual(result.data.customer, {
    _id: "customer", name: "Customer", image: "https://cdn.example/customer.jpg", email: "customer@example.com",
  });
  assert.deepEqual(result.data.provider, {
    _id: "business", name: "Studio", image: "https://cdn.example/studio.jpg", email: "provider@example.com",
  });
  assert.deepEqual(result.data.userInfo, {
    _id: "customer",
    name: "Customer",
    email: "customer@example.com",
    profileIcon: "https://cdn.example/customer.jpg",
    location: { type: "Point", coordinates: [-73.9, 40.7] },
  });
  assert.deepEqual(result.data.businessInfo, {
    _id: "business",
    user: "provider-user",
    businessName: "Studio",
    image: "https://cdn.example/studio.jpg",
    email: "provider@example.com",
    location: { address: "123 Main St", coordinates: [-73.8, 40.8] },
  });
  assert.deepEqual(result.data.target[0], {
    _id: "507f1f77bcf86cd799439011",
    name: "Booked service",
    price: 75,
    preferredServiceType: { optionName: "At Business Location" },
    photos: ["https://cdn.example/service.jpg"],
    image: "https://cdn.example/service.jpg",
    description: "Service details",
    sessionSlotMins: 45,
    rating: { avgRating: 4.7, totalReviews: 12 },
  });
  assert.equal(result.data.canMessage, true);
  assert.equal(result.data.conversationId, "conversation-id");
  assert.deepEqual(result.data.review, {
    _id: "review",
    status: "approved",
    rating: 5,
    comment: "Great booking",
    booking: "booking",
    reviewer: {
      _id: "customer",
      name: "Customer",
      profileIcon: "https://cdn.example/customer.jpg",
    },
  });
  assert.equal(result.data.payout, undefined);
  assert.equal(result.data.capture.stripeFeeCents, undefined);
  assert.equal(result.data.capture.chargeId, undefined);
  assert.equal(result.data.cancellation.providerCancellationNumber, undefined);
  assert.equal(result.data.cancellation.providerPenalty, undefined);
  assert.equal(result.data.cancellation.warningIssued, undefined);
  assert.equal(result.data.cancellation.rankingReductionApplied, undefined);
  assert.equal(result.data.cancellation.suspendedUntil, undefined);
});

test("provider booking reads retain payout and cancellation details", async () => {
  const review = {
    _id: "review",
    reviewType: "packages",
    object: "507f1f77bcf86cd799439012",
    subject: { _id: "customer", name: "Customer", profileIcon: "customer.jpg" },
    __v: 0,
    status: "approved",
    rating: 4,
    comment: "Package was excellent",
    booking: "booking",
  };
  const booking = {
    _id: "booking",
    status: "confirmed",
    user: "customer",
    business: "business",
    scope: "package",
    target: [{ _id: "507f1f77bcf86cd799439012", name: "Booked package", price: 125 }],
    capture: { stripeFeeCents: 25, chargeId: "ch_test" },
    payout: { netCents: 10000 },
    cancellation: { providerCancellationNumber: 3, providerPenalty: "penalty-id", warningIssued: false },
  };
  Booking.findOne = () => ({ lean: async () => booking });
  Packages.findById = () => ({
    lean: async () => ({
      description: "Package details",
      photos: ["https://cdn.example/package-photo.jpg"],
      coverImage: "https://cdn.example/package-cover.jpg",
      sessionSlotMins: 90,
    }),
  });
  Review.aggregate = async () => [{ avgRating: 4.2, totalReviews: 5 }];
  Review.findOne = () => ({
    populate: () => ({
      lean: async () => review,
    }),
  });
  Conversation.findOne = () => ({
    lean: async () => ({ _id: "conversation-id", chatStatus: "closed" }),
  });
  BusinessProfile.findById = () => ({
    lean: async () => ({ _id: "business", businessName: "Studio", image: "studio.jpg", user: "provider-user" }),
  });
  User.findById = (id) => ({
    lean: async () => id === "customer"
      ? { _id: "customer", name: "Customer", profileIcon: "customer.jpg", email: "customer@example.com" }
      : { _id: "provider-user", email: "provider@example.com" },
  });

  const result = await getInstantBooking({ id: "booking", userId: "provider-user", businessId: "business" });
  assert.equal(result.data.userInfo.email, "customer@example.com");
  assert.equal(result.data.businessInfo.user, "provider-user");
  assert.equal(result.data.target[0].image, "https://cdn.example/package-cover.jpg");
  assert.equal(result.data.target[0].preferredServiceType.optionName, null);
  assert.equal(result.data.target[0].rating.avgRating, 4.2);
  assert.equal(result.data.review.status, "approved");
  assert.equal(result.data.review.reviewer.name, "Customer");
  assert.equal(result.data.canMessage, false);
  assert.equal(result.data.conversationId, "conversation-id");
  assert.equal(result.data.payout.netCents, 10000);
  assert.equal(result.data.capture.stripeFeeCents, 25);
  assert.equal(result.data.capture.chargeId, "ch_test");
  assert.equal(result.data.cancellation.providerCancellationNumber, 3);

  review.status = "pending";
  const pendingResult = await getInstantBooking({ id: "booking", userId: "provider-user", businessId: "business" });
  assert.equal(pendingResult.data.review, null);
});

test.after(() => {
  Services.findById = originals.service;
  Packages.findById = originals.package;
  Promotion.findOne = originals.promotion;
  PromotionUsage.countDocuments = originals.count;
  Booking.findOne = originals.booking;
  BusinessProfile.findById = originals.business;
  User.findById = originals.user;
  Review.aggregate = originals.review;
  Review.findOne = originals.reviewForBooking;
  Conversation.findOne = originals.conversation;
  pricing.getInstantSettings = originalSettings;
});
