require("module-alias/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const BookingOffer = require("@models/BookingOffer");
const { getProviderOffers } = require("../backend/app/services/bookingProviderOffers");

const originalAggregate = BookingOffer.aggregate;
const businessId = new mongoose.Types.ObjectId();
const now = new Date();
const future = new Date(now.getTime() + 60000);
let pipeline, rows;
const setup = () => {
  rows = [{
    statusCounts: [{ _id: "pending", count: 2 }, { _id: "expired", count: 3 }],
    total: [{ count: 2 }],
    data: [{ offerId: "offer", status: "pending", expiresAt: future, attemptExpiresAt: future,
      pauseAttempt: false, serviceId: "service", businessId, listing: { photos: ["service.jpg"] },
      businessInfo: { businessName: "Provider", image: "provider.jpg" },
      booking: { bookingId: "IB-123", target: [{ _id: "service", name: "Haircut" }] } }],
  }];
  BookingOffer.aggregate = async (value) => { pipeline = value; return rows; };
};
const facet = () => pipeline.find((stage) => stage.$facet).$facet;

test("lists the provider's live offers with pagination and unfiltered status counts", async () => {
  setup();
  const result = await getProviderOffers({ businessId, page: 2, limit: 1, now });
  assert.equal(String(pipeline[0].$match.business), String(businessId));
  assert.deepEqual(facet().data[0], { $match: { status: "pending" } });
  assert.ok(facet().data.some((stage) => stage.$skip === 1));
  assert.ok(facet().data.some((stage) => stage.$limit === 1));
  assert.equal(result.meta.totalRecords, 2);
  assert.equal(result.meta.totalPages, 2);
  assert.deepEqual(result.meta.statusCounts, { all: 5, pending: 2, accepted: 0, declined: 0, expired: 3, closed: 0 });
  assert.equal(result.data[0].attemptExpiresAt, undefined);
  assert.equal(result.data[0].pauseAttempt, undefined);
  assert.equal(result.data[0].service.name, "Haircut");
  assert.equal(result.data[0].business.businessName, "Provider");
  assert.ok(result.data[0].serverNow instanceof Date);
});

test("returns offer-owned service and business details with resolved images", async () => {
  setup();
  const previous = process.env.S3_BASE_URL;
  process.env.S3_BASE_URL = "https://cdn.example/";
  try {
    const result = await getProviderOffers({ businessId, now });
    assert.deepEqual(result.data[0].service, { _id: "service", name: "Haircut", image: "https://cdn.example/service.jpg" });
    assert.deepEqual(result.data[0].business, { _id: businessId, businessName: "Provider", image: "https://cdn.example/provider.jpg" });
    const dataStages = facet().data;
    const businessLookup = dataStages.find((stage) => stage.$lookup?.from === "businessprofiles").$lookup;
    assert.equal(businessLookup.localField, "business");
    const listingLookups = pipeline.filter((stage) => ["services", "packages"].includes(stage.$lookup?.from));
    for (const stage of listingLookups) {
      assert.deepEqual(stage.$lookup.pipeline[0].$match.$expr.$and[1], { $eq: ["$business", "$$providerId"] });
    }
    const snapshot = pipeline.find((stage) => stage.$set?.visibleTarget).$set.visibleTarget.$let.vars.snapshot.$filter;
    assert.deepEqual(snapshot.cond.$and[0], { $eq: ["$business", "$bookingDoc.business"] });
    assert.equal(result.data[0].listing, undefined);
    assert.equal(result.data[0].businessInfo, undefined);
  } finally {
    if (previous === undefined) delete process.env.S3_BASE_URL; else process.env.S3_BASE_URL = previous;
  }
});

test("historical packages use their own cover and missing listings do not borrow another provider's data", async () => {
  setup();
  rows[0].data[0] = {
    offerId: "old-offer", status: "expired", serviceId: "package", businessId,
    listing: { coverImage: "https://images.example/package.jpg", photos: ["unused.jpg"] },
    businessInfo: { businessName: "Original", image: "https://images.example/provider.jpg" },
    booking: { target: [{ _id: "package", name: "Original package" }] },
  };
  let result = await getProviderOffers({ businessId, status: "all", now });
  assert.deepEqual(result.data[0].service, { _id: "package", name: "Original package", image: "https://images.example/package.jpg" });
  assert.equal(result.data[0].business.image, "https://images.example/provider.jpg");
  rows[0].data[0].listing = { photos: [] };
  result = await getProviderOffers({ businessId, status: "all", now });
  assert.ok(result.data[0].service.image.endsWith("noimg.png"));
  rows[0].data[0].listing = null;
  rows[0].data[0].businessInfo = null;
  rows[0].data[0].booking.target = [];
  result = await getProviderOffers({ businessId, status: "all", now });
  assert.deepEqual(result.data[0].service, { _id: "package", name: null, image: null });
  assert.deepEqual(result.data[0].business, { _id: businessId, businessName: null, image: null });
});

test("history filters and literal keyword search apply before pagination and counts", async () => {
  setup();
  await getProviderOffers({ businessId, status: "expired", keyword: " IB.[1] ", now });
  const search = pipeline.find((stage) => stage.$match?.$or?.some((part) => part["bookingDoc.bookingId"]));
  assert.equal(search.$match.$or[0]["bookingDoc.bookingId"].$regex, "IB\\.\\[1\\]");
  assert.equal(search.$match.$or[1]["visibleTarget.name"].$regex, "IB\\.\\[1\\]");
  assert.deepEqual(facet().total[0], { $match: { status: "expired" } });
  assert.deepEqual(facet().data[0], { $match: { status: "expired" } });
  assert.equal(facet().statusCounts[0].$group._id, "$status");
  await getProviderOffers({ businessId, status: "all", now });
  assert.equal(facet().total[0].$count, "count");
});

test("rejects invalid filters and omits offers that expire during lookup", async () => {
  setup();
  assert.equal((await getProviderOffers({})).status, 409);
  assert.equal((await getProviderOffers({ businessId, status: "bad" })).status, 400);
  assert.equal((await getProviderOffers({ businessId, keyword: {} })).status, 400);
  rows[0].data[0].expiresAt = new Date(now.getTime() - 1);
  assert.deepEqual((await getProviderOffers({ businessId, now })).data, []);
});

test.after(() => { BookingOffer.aggregate = originalAggregate; });
