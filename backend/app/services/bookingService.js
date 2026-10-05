const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Booking = require("@models/Bookings");
const BookingDraft = require("@models/BookingDraft");
const Review = require("@models/Review");
const { Services } = require("@models/Services");
const { Packages } = require("@models/Packages");
const { Promotion } = require("@models/Promotions");
const PromotionUsage = require("@models/PromotionUsage");
const { sendUserNotifications } = require("../../commonModules/controllers/communicationController");
const { NotificationTypes } = require("@models/Notifications");
const BusinessProfile = require("@models/BusinessProfile");
const { UserProfile } = require("@models/UserProfile");
const { authorizeBookingPayment, createBookingSetupIntent, applyDebtLock } = require("./paymentService");
const { cancelStripePayment, captureStripePayment } = require("@services/stripePayment");
const { acquireLock, releaseLock } = require("@redisCache");
const {
  openOrReopenConversationForBooking,
  closeConversationIfNoActiveBookings,
  TERMINAL_BOOKING_STATUSES,
} = require("../../commonModules/chatModule/services/conversationGateService");
const Payment = require("@models/Payment");
const Bookings = require("@models/Bookings");
const { getStartAndEndOfDay, getStartAndEndOfWeek, getStartAndEndOfMonth } = require("@utils/responseUtil");
const { resolveBadgeOptionName } = require("@utils/badgeUtil");
const {
  badgeOptionRefPipeline,
  reviewStatsPipeline,
  s3UrlExpr,
  servicePipeline,
  packagePipeline,
  haversineKmExpr,
} = require("@utils/aggregationHelper");
const { getFullImageUrl } = require("@utils/imageHelper");

// Bookings <= this far in the future get an immediate authorization hold;
// further out, the card is vaulted and charged by the horizon cron (spec: 4 days).
const AUTH_HORIZON_MS = 96 * 60 * 60 * 1000;
const AUTO_SCHEDULE_WINDOW_MS = 60 * 60 * 1000; // < 1h away -> skip approval
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000; // provider response deadline
const START_WINDOW_MS = 5 * 60 * 1000; // provider can start a session up to 5 mins before its slot begins

const generateBookingId = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BK-${ts}-${rand}`;
};

const resolveEntity = async (scope, targetId, businessId) => {
  const Model = scope === "service" ? Services : scope === "package" ? Packages : null;
  if (!Model) return { entity: null, entityType: null };

  const populateStripe = {
    path: "business",
    select: "user _id operatingHours", // space-separated, no comma
    populate: { path: "user", select: "stripe" },
  };

  const doc = await Model.findById(targetId).populate(populateStripe).lean();
  if (!doc) return { entity: null, entityType: null };

  const bid = doc.business?._id?.toString();
  if (businessId && bid === businessId.toString()) {
    return { entity: null, entityType: null };
  }
  doc.stripe = doc.business?.user?.stripe;
  doc.business = bid;
  return { entity: doc, entityType: scope };
};

const findActivePromotion = async ({ entityId, promotionId }) => {
  return Promotion.findOne({
    _id: promotionId,
    targetId: entityId,
    status: "active",
    expiresAt: { $gt: new Date() },
  }).lean();
};

const buildSnapshot = (entity, promotion) => {
  const originalPrice = entity.price;
  const finalPrice = resolveAmount(entity, promotion);
  const discountAmount = parseFloat((originalPrice - finalPrice).toFixed(2));

  return {
    name: entity.name,
    description: entity.description || "",
    preferredServiceType: entity.preferredServiceType,
    refundPercentage: entity.refundPercentage,
    refundRules: entity.refundRules,
    howLateCanCancel: entity.howLateCanCancel,
    photos: entity.photos,
    pricing: {
      originalPrice,
      discountAmount,
      finalPrice,
    },
    promotion: promotion
      ? {
          name: promotion.name,
          promoCode: promotion.promoCode,
          discountType: promotion.discountType,
          discount: promotion.discount,
        }
      : null,
  };
};

const toMinutes = (timeStr) => {
  const [h, m] = timeStr?.split(":")?.map(Number);
  return h * 60 + m;
};

const getDaySchedule = (entity, bookingDate) => {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOfWeek = days[new Date(bookingDate).getDay()];
  return (entity.slots || []).find((d) => d.dayOfWeek === dayOfWeek && d.isOpen) || null;
};

/**
 * Bookable intervals for one day. Both modes store the same discrete shape
 * on entity.slots — explicit intervals from the business, or intervals
 * materialized from operating hours when sameAsBusinessHours is true
 * (regenerated whenever the operating hours change).
 */
const bookableSlotsForDay = (entity, daySchedule) =>
  (daySchedule.intervals || []).map((i) => ({
    open: i.open,
    close: i.close,
    isOvernight: i.isOvernight ?? toMinutes(i.close) <= toMinutes(i.open),
  }));

const slotExistsInSchedule = (entity, bookingDate, slot) => {
  const day = getDaySchedule(entity, bookingDate);
  if (!day) return false;
  const generated = bookableSlotsForDay(entity, day);
  return generated.some(
    (s) => toMinutes(s.open) === toMinutes(slot.open) && toMinutes(s.close) === toMinutes(slot.close),
  );
};

const dateRangeForDay = (date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

// A slot's seats are held by every booking that still has a claim on it:
// "scheduled", the "ongoing" ones the provider already started (a session can
// start before its slot begins, so that seat is obviously still taken), and
// "requested" — a booking awaiting the provider's approval already has the
// customer's card authorized, so it occupies the seat until it's accepted,
// rejected, or expired by the approval-window cron. Leaving "requested" out
// let a service with concurrentClients: 1 take unlimited requests for the same
// slot whenever autoSelect was off, since the draft that held the seat during
// checkout is deleted the moment the booking materializes as "requested".
const SEAT_HOLDING_STATUSES = ["requested", "scheduled", "ongoing"];

/**
 * How many clients may share one slot. Stored on the service/package as
 * concurrentClients; entities written before the field existed (or with a
 * junk value) read back as one seat rather than as "no limit" — resolveEntity
 * uses .lean(), so the schema default never gets applied here.
 */
const slotCapacity = (entity) => {
  const configured = Number(entity?.concurrentClients);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
};

// excludeBookingId leaves one booking out of the count — used when accepting,
// where the booking under review is itself "requested" and would otherwise
// fill the last seat and block its own approval.
const countAcceptedInSlot = async (entityId, date, slot, excludeBookingId = null) => {
  const { start, end } = dateRangeForDay(date);
  const match = {
    "target._id": new mongoose.Types.ObjectId(String(entityId)),
    date: { $gte: start, $lte: end },
    "slot.open": slot.open,
    "slot.close": slot.close,
  };
  const bookingMatch = { ...match, status: { $in: SEAT_HOLDING_STATUSES } };
  if (excludeBookingId) {
    bookingMatch._id = { $ne: new mongoose.Types.ObjectId(String(excludeBookingId)) };
  }
  // claimed bookings own the seat; in-checkout drafts hold it temporarily
  // (released by the abandoned-checkout cron / TTL backstop)
  const [bookedCount, draftCount] = await Promise.all([
    Booking.countDocuments(bookingMatch),
    BookingDraft.countDocuments(match),
  ]);
  return bookedCount + draftCount;
};

// timezone is optional — when provided (IANA name, e.g. "America/New_York"),
// the slot's "HH:mm" is interpreted as wall-clock time in that zone instead
// of the server's own local timezone. Existing callers that don't pass one
// keep the old server-local behavior unchanged.
const slotStartDate = (bookingDate, slot, timezone) => {
  const openTime = slot?.open || "00:00";
  if (timezone) {
    const dateStr = moment.utc(bookingDate).format("YYYY-MM-DD");
    return moment.tz(`${dateStr} ${openTime}`, "YYYY-MM-DD HH:mm", timezone).toDate();
  }
  const start = new Date(bookingDate);
  const [h, m] = openTime.split(":").map(Number);
  start.setHours(h, m, 0, 0);
  return start;
};

const slotEndDate = (bookingDate, slot, timezone) => {
  const closeTime = slot?.close || "00:00";
  if (timezone) {
    const dateStr = moment.utc(bookingDate).format("YYYY-MM-DD");
    let end = moment.tz(`${dateStr} ${closeTime}`, "YYYY-MM-DD HH:mm", timezone);
    if (slot?.isOverNight) end = end.add(1, "day");
    return end.toDate();
  }
  const end = new Date(bookingDate);
  const [h, m] = closeTime.split(":").map(Number);
  end.setHours(h, m, 0, 0);
  if (slot?.isOverNight) end.setDate(end.getDate() + 1);
  return end;
};

// ─── Shared enrichment stages ──────────────────────────────────────────────
const userLookup = {
  $lookup: {
    from: "users",
    localField: "user",
    foreignField: "_id",
    as: "userInfo",
    pipeline: [{ $project: { name: 1, email: 1, profileIcon: s3UrlExpr("$profileIcon") } }],
  },
};

const paymentLookup = {
  $lookup: {
    from: "payments",
    localField: "payment",
    foreignField: "_id",
    as: "paymentInfo",
    pipeline: [
      { $project: { status: 1, amount: 1, currency: 1, stripePaymentId: 1, "paymentObject.applicationFeeAmount": 1 } },
    ],
  },
};

// Payment.status enum ("authorized"/"captured"/"failed"/"expired"/"refunded")
// mapped to the plain paid/pending labels admin screens show
const PAYMENT_STATUS_LABELS = {
  authorized: "pending",
  captured: "paid",
  failed: "failed",
  expired: "expired",
  refunded: "refunded",
};
const paymentStatusLabel = (status) => PAYMENT_STATUS_LABELS[status] || status || null;

/**
 * What the customer actually paid, against what the service listed for.
 *
 * The Payment doc is the source of truth once one exists; target.price (the
 * promotion-adjusted amount the booking was created with) covers rows that
 * never reached payment. target.actaulPrice is the entity's list price at
 * booking time — equal to price when no promotion applied, higher when one did,
 * which is the only place the discount survives.
 *
 * Expects a booking from the aggregation pipelines above (paymentInfo already
 * flattened, target still present).
 */
const bookingPriceBreakdown = (booking) => {
  // Amounts are money: percentage-based promotion maths leaves values like
  // 36.47000000000003 on the Payment doc, which must not reach the UI.
  const toMoney = (value) => Number((Number(value) || 0).toFixed(2));

  const paid = toMoney(booking?.paymentInfo?.amount ?? booking?.price ?? 0);
  const originalPrice = toMoney(booking?.target?.[0]?.actaulPrice ?? booking?.price ?? paid);
  const discount = Math.max(0, toMoney(originalPrice - paid));

  return {
    paid,
    originalPrice,
    discount,
    isDiscounted: discount > 0,
    currency: booking?.paymentInfo?.currency ?? "usd",
  };
};

const businessLookup = {
  $lookup: {
    from: "businessprofiles",
    localField: "business",
    foreignField: "_id",
    as: "businessInfo",
    pipeline: [
      {
        $project: {
          _id: 1,
          businessName: 1,
          image: s3UrlExpr("$image"),
          location: 1,
          isAvailable: 1,
          user: 1,
        },
      },
    ],
  },
};

const flattenLookups = {
  $addFields: {
    userInfo: { $first: "$userInfo" },
    businessInfo: { $first: "$businessInfo" },
    paymentInfo: { $first: "$paymentInfo" },
  },
};

// Whether the customer and business can message each other *about this
// booking*. Two conditions, both required:
//
//  1. the shared chat thread is open. Conversation is keyed by the User pair,
//     not the booking itself (Booking has no conversation reference — see
//     conversationGateService), so this re-derives the same pair Conversation
//     is looked up by elsewhere: the booking's own `user` plus the business's
//     owning User id (businessInfo.user, already flattened by the time this
//     runs);
//  2. this booking is not itself terminal. The thread stays open as long as
//     *any* booking between the pair is active, so without this leg a
//     completed/canceled/expired booking inherits canMessage: true from an
//     unrelated live one. sendMessage already refuses a terminal bookingId
//     (resolveActiveBooking) — this keeps the flag honest about it.
//
// Must run after businessInfo has been flattened to a single object, and
// before flattenBookingDetails, while `status` is still the booking's own.
//
// That thread's id rides along as `conversationId` (null when the pair has
// never had one) so a client can open the chat without a second lookup.
const canMessageLookup = [
  {
    $lookup: {
      from: "conversations",
      let: { customerId: "$user", businessUserId: "$businessInfo.user" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$type", "direct"] },
                { $eq: [{ $size: "$participants" }, 2] },
                { $in: ["$$customerId", "$participants.user"] },
                { $in: ["$$businessUserId", "$participants.user"] },
              ],
            },
          },
        },
        { $project: { _id: 1, chatStatus: 1 } },
      ],
      as: "conversationInfo",
    },
  },
  {
    $addFields: {
      canMessage: {
        $let: {
          vars: { conv: { $first: "$conversationInfo" } },
          in: {
            $and: [
              { $cond: [{ $ifNull: ["$$conv", false] }, { $ne: ["$$conv.chatStatus", "closed"] }, false] },
              { $not: { $in: ["$status", TERMINAL_BOOKING_STATUSES] } },
            ],
          },
        },
      },
      conversationId: { $ifNull: [{ $first: "$conversationInfo._id" }, null] },
    },
  },
  { $unset: "conversationInfo" },
];

// "HH:MM" → minutes since midnight, as an aggregation expression
const slotMinutesExpr = (field) => ({
  $add: [
    { $multiply: [{ $toInt: { $arrayElemAt: [{ $split: [field, ":"] }, 0] } }, 60] },
    { $toInt: { $arrayElemAt: [{ $split: [field, ":"] }, 1] } },
  ],
});

// Lift client-facing fields to the top of the booking object and drop the raw
// snapshot. Slot duration equals the entity's sessionSlotMins at booking time
// (business-hours sessions step by sessionSlotMins), so it's derived from the slot.
// preferredServiceType gets enriched with localized badgeName/optionName.
const flattenBookingDetails = (locale) => [
  {
    $addFields: {
      name: { $first: "$target.name" },
      price: { $first: "$target.price" },
      preferredServiceType: { $ifNull: ["$snapshot.preferredServiceType", null] },
      description: { $ifNull: ["$snapshot.description", ""] },
      // Billing/receipt fields — transactionId is the Stripe PaymentIntent id;
      // platformFeeAmount is our application_fee_amount (stored in cents), converted to major units.
      transactionId: "$paymentInfo.stripePaymentId",
      platformFeeAmount: { $divide: [{ $ifNull: ["$paymentInfo.paymentObject.applicationFeeAmount", 0] }, 100] },
      sessionSlotMins: {
        $add: [
          { $subtract: [slotMinutesExpr("$slot.close"), slotMinutesExpr("$slot.open")] },
          { $cond: [{ $eq: ["$slot.isOverNight", true] }, 24 * 60, 0] },
        ],
      },
      photos: {
        $map: {
          input: { $ifNull: ["$snapshot.photos", []] },
          as: "photo",
          in: s3UrlExpr("$$photo"),
        },
      },
    },
  },
  { $unset: "snapshot" },
  ...badgeOptionRefPipeline({ locale }),
];

// ─── Service functions ─────────────────────────────────────────────────────

const resolveAmount = (entity, promotion) => {
  if (!promotion) return entity.price;
  if (promotion.discountType === "percentage") {
    return Math.max(0, entity.price - (entity.price * promotion.discount) / 100);
  }
  return Math.max(0, entity.price - promotion.discount);
};

const createBooking = async ({ req }) => {
  const { user, body } = req;
  // Wire field is stripePaymentMethodId; kept as `paymentMethod` internally
  // since that's the param name authorizeBookingPayment/createBookingSetupIntent expect.
  const { scope, targetId, date, slot, source, stripePaymentMethodId: paymentMethod, promotionId } = body;
  const userId = user._id;
  const businessId = user.businessId;
  let promotion;
  const bookingDate = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0); // strip time → midnight local

  const booking_hours = new Date(bookingDate);
  booking_hours.setHours(0, 0, 0, 0); // strip time too

  if (isNaN(booking_hours.getTime()) || booking_hours < today) {
    return { error: "booking_date_past", status: 400 };
  }

  // The date-only check above lets a same-day slot whose actual time has
  // already elapsed slip through (e.g. booking "14:50" at 15:00 today) —
  // check the real slot start too.
  if (slotStartDate(bookingDate, slot).getTime() <= Date.now()) {
    return { error: "booking_slot_past", status: 400 };
  }

  const { entity } = await resolveEntity(scope, targetId, businessId);
  if (!entity) return { error: "booking_entity_not_found", status: 404 };
  if (entity.status === "deleted" || entity.status === "inactive") {
    return { error: "booking_entity_not_found", status: 404 };
  }
  // Same gate as getSlots — a slot the schedule refuses to show can't be booked
  // by replaying an earlier slots response.
  if (entity.isAvailable === false) {
    return { error: scope === "package" ? "package_unavailable" : "service_unavailable", status: 409 };
  }
  if (promotionId) {
    promotion = await findActivePromotion({ entityId: entity._id, promotionId });
  }
  if (!slotExistsInSchedule(entity, bookingDate, slot)) {
    return { error: "booking_slot_invalid", status: 400 };
  }

  // Atomic capacity check + insert: hold the slot lock so two concurrent
  // checkouts can't both pass the count. Best effort — proceeds unlocked
  // when Redis is unavailable (same behavior as before).
  const lockKey = `booking-slot:${targetId}:${booking_hours.toISOString().split("T")[0]}:${slot.open}`;
  let lock = await acquireLock(lockKey, 10);
  if (!lock) {
    await new Promise((r) => setTimeout(r, 150));
    lock = await acquireLock(lockKey, 10);
  }

  // Same best-effort lock pattern as the slot lock, scoped to the promotion
  // instead — holds usage-limit checks + the redemption insert together so
  // two concurrent bookings can't both slip in under totalUsageLimit/perUserLimit.
  const promoLockKey = promotion ? `promo-usage:${promotion._id}` : null;
  let promoLock;
  if (promoLockKey) {
    promoLock = await acquireLock(promoLockKey, 10);
    if (!promoLock) {
      await new Promise((r) => setTimeout(r, 150));
      promoLock = await acquireLock(promoLockKey, 10);
    }
  }

  let draft;
  try {
    // Up to concurrentClients different clients share the slot (e.g. 10);
    // only the client taking the last free seat is turned away.
    const acceptedCount = await countAcceptedInSlot(entity._id, bookingDate, slot);
    if (acceptedCount >= slotCapacity(entity)) {
      return { error: "booking_slot_full", status: 400 };
    }

    const { start, end } = dateRangeForDay(bookingDate);
    const slotMatch = {
      user: userId,
      date: { $gte: start, $lte: end },
      "slot.open": slot.open,
      "slot.close": slot.close,
    };
    const [conflict, draftConflict] = await Promise.all([
      Booking.findOne({ ...slotMatch, status: { $in: ["requested", "scheduled"] } }),
      BookingDraft.findOne(slotMatch),
    ]);
    if (conflict || draftConflict) return { error: "booking_slot_conflict", status: 400 };

    if (promotion) {
      const [totalUsed, userUsed] = await Promise.all([
        PromotionUsage.countDocuments({ promotion: promotion._id }),
        PromotionUsage.countDocuments({ promotion: promotion._id, user: userId }),
      ]);
      if (totalUsed >= promotion.totalUsageLimit) {
        return { error: "promotion_usage_limit_reached", status: 400 };
      }
      if (userUsed >= promotion.perUserLimit) {
        return { error: "promotion_user_limit_reached", status: 400 };
      }
    }

    const amount = resolveAmount(entity, promotion);
    // Selected badge-option name (e.g. "Onsite") stored on the target so
    // booking lists can show the type without a badge lookup
    const preferredServiceTypeName = await resolveBadgeOptionName(entity.preferredServiceType);

    // No Booking exists yet — the draft is the temporary slot hold. It only
    // becomes a real Booking once payment is actually confirmed, either
    // synchronously below (paymentMethod supplied) or from the Stripe webhook.
    draft = await BookingDraft.create({
      scope,
      source,
      target: [
        {
          _id: targetId,
          name: entity.name,
          price: amount,
          actaulPrice: entity.actualPrice || entity.price,
          preferredServiceType: preferredServiceTypeName,
        },
      ],
      // Accept both casings — GET /slots returns `isOvernight`, older clients send `isOverNight`
      slot: { open: slot.open, close: slot.close, isOverNight: slot.isOverNight || slot.isOvernight || false },
      date: bookingDate,
      user: userId,
      business: entity.business,
      promotion: promotion ? promotion._id : undefined,
      snapshot: buildSnapshot(entity, promotion),
    });
  } finally {
    if (lock) await releaseLock(lockKey, lock);
    if (promoLock) await releaseLock(promoLockKey, promoLock);
  }

  // ── Time-based payment fork ───────────────────────────────────────────
  const slotStart = slotStartDate(bookingDate, slot);
  const withinAuthHorizon = slotStart.getTime() - Date.now() <= AUTH_HORIZON_MS;

  try {
    if (withinAuthHorizon) {
      // Branch A: authorization hold now (manual capture)
      const amount = draft.target[0].price;
      const { paymentDoc, clientSecret, stripeStatus } = await authorizeBookingPayment({
        amount,
        user,
        entity,
        paymentMethod,
        draftId: draft._id,
      });
      draft.stripePaymentIntentId = paymentDoc.stripePaymentId;
      await draft.save();

      if (stripeStatus === "requires_capture") {
        // pm was supplied and confirmed synchronously — payment secured, the
        // booking exists for the first time now
        const booking = await materializeBookingFromDraft(draft, {
          paymentStatus: "authorized",
          paymentId: paymentDoc._id,
          stripePaymentMethodId: paymentDoc.paymentObject?.paymentMethod || paymentMethod,
        });
        await routeBookingAfterPaymentSecured(booking, entity);
        return { data: { booking, intentType: "payment" } };
      }
      // Not confirmed yet — nothing exists until the frontend completes the
      // Stripe confirm and the webhook fires.
      return { data: { draftId: draft._id, clientSecret, intentType: "payment" } };
    }

    // Branch B: vault the card, charge later via the 4-day horizon cron
    const { setupIntent, clientSecret } = await createBookingSetupIntent({
      user,
      paymentMethod,
      draftId: draft._id,
      businessId: entity.business,
    });
    draft.stripeSetupIntentId = setupIntent.id;
    await draft.save();

    if (setupIntent.status === "succeeded") {
      // pm was supplied and confirmed synchronously — already vaulted, the
      // booking exists for the first time now
      const booking = await materializeBookingFromDraft(draft, {
        paymentStatus: "vaulted",
        stripePaymentMethodId: setupIntent.payment_method,
      });
      await routeBookingAfterPaymentSecured(booking, entity);
      return { data: { booking, intentType: "setup" } };
    }
    return { data: { draftId: draft._id, clientSecret, intentType: "setup" } };
  } catch (error) {
    // Payment setup failed — drop the temporary slot hold, no booking was ever created
    console.error("createBooking payment setup error:", error);
    await BookingDraft.deleteOne({ _id: draft._id });
    return { error: "booking_payment_failed", status: 400 };
  }
};

/**
 * Promote a checkout draft into a real Booking — the first time it exists —
 * once payment is actually confirmed. Idempotent-safe: only ever called once
 * per draft, immediately followed by deleting the draft.
 */
const materializeBookingFromDraft = async (draft, { paymentStatus, paymentId, stripePaymentMethodId }) => {
  const plainDraft = draft.toObject();
  const booking = new Booking({
    bookingId: generateBookingId(),
    scope: plainDraft.scope,
    source: plainDraft.source,
    target: plainDraft.target,
    slot: plainDraft.slot,
    date: plainDraft.date,
    status: "requested",
    paymentStatus,
    payment: paymentId || undefined,
    stripePaymentMethodId: stripePaymentMethodId || undefined,
    stripeSetupIntentId: plainDraft.stripeSetupIntentId || undefined,
    user: plainDraft.user,
    business: plainDraft.business,
    snapshot: plainDraft.snapshot,
  });
  await booking.save();

  if (draft.promotion) {
    await PromotionUsage.create({ promotion: draft.promotion, user: draft.user, booking: booking._id });
  }

  await BookingDraft.deleteOne({ _id: draft._id });

  openOrReopenConversationForBooking(booking).catch((err) =>
    console.error(`openOrReopenConversationForBooking failed for booking ${booking._id}:`, err.message),
  );

  return booking;
};

/**
 * Webhook lookup for a PaymentIntent: if a draft is still waiting on this
 * intent, this is the first confirmation — materialize the Booking now.
 * Otherwise the booking already exists (synchronous confirm, or a duplicate
 * webhook delivery) — find it via the Payment doc instead of Stripe metadata,
 * since metadata never carries a real bookingId until after materialization.
 */
const findOrCreateBookingForPaymentIntent = async (paymentIntent) => {
  const draft = await BookingDraft.findOne({ stripePaymentIntentId: paymentIntent.id });
  if (draft) {
    const booking = await materializeBookingFromDraft(draft, {
      paymentStatus: "authorized",
      paymentId: paymentIntent.metadata?.paymentId,
      stripePaymentMethodId: paymentIntent.payment_method,
    });
    return { booking, isNew: true };
  }

  const payment = await Payment.findOne({ stripePaymentId: paymentIntent.id });
  if (!payment) return { booking: null, isNew: false };
  const booking = await Booking.findOne({ payment: payment._id });
  return { booking, isNew: false };
};

/**
 * Same idea as findOrCreateBookingForPaymentIntent, for SetupIntents (Branch B).
 */
const findOrCreateBookingForSetupIntent = async (setupIntent) => {
  const draft = await BookingDraft.findOne({ stripeSetupIntentId: setupIntent.id });
  if (draft) {
    const booking = await materializeBookingFromDraft(draft, {
      paymentStatus: "vaulted",
      stripePaymentMethodId: setupIntent.payment_method,
    });
    return { booking, isNew: true };
  }

  const booking = await Booking.findOne({ stripeSetupIntentId: setupIntent.id });
  return { booking, isNew: false };
};

/**
 * Spec Phase 3.1 — called once payment is secured (authorized or vaulted),
 * either synchronously (pm supplied) or from a Stripe webhook.
 * Idempotent: does nothing if the booking already left the routing stage.
 */
const routeBookingAfterPaymentSecured = async (booking, entity = null) => {
  if (booking.status !== "requested") return booking;
  if (booking.expiresAt) return booking; // already routed to manual approval

  if (!entity) {
    const resolved = await resolveEntity(booking.scope, booking.target[0]._id);
    entity = resolved.entity;
  }

  const slotStart = slotStartDate(booking.date, booking.slot);
  const autoSchedule = entity?.autoSelect === true || slotStart.getTime() - Date.now() < AUTO_SCHEDULE_WINDOW_MS;

  if (autoSchedule) {
    booking.status = "scheduled";
    await booking.save();
    sendUserNotifications({
      recipientIds: [booking.user],
      title: "Booking Confirmed",
      body: `Your booking for ${booking.target[0]?.name} is confirmed`,
      data: { type: "booking_scheduled", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_APPROVED,
      objectId: booking._id,
    });
    // The business never heard about an auto-scheduled booking — it skips the
    // approval step, so the "New Booking Request" notification never fires.
    sendUserNotifications({
      recipientIds: [booking.business],
      title: "New Booking",
      body: `New booking for ${booking.target[0]?.name}`,
      data: { type: "booking_scheduled", objectType: "booking" },
      notificationType: NotificationTypes.NEW_BOOKING,
      objectId: booking._id,
      sender: booking.user,
    });
  } else {
    booking.expiresAt = new Date(Date.now() + APPROVAL_WINDOW_MS);
    await booking.save();
    sendUserNotifications({
      recipientIds: [booking.business],
      title: "New Booking Request",
      body: `New booking request for ${booking.target[0]?.name}`,
      data: { type: "booking_requested", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_REQUEST,
      objectId: booking._id,
      sender: booking.user,
    });
  }

  return booking;
};

// Count bookings per status for the given filter (ignoring its status field),
// zero-filled across the schema's status enum — used for list-screen tabs.
const countBookingStatuses = async (filter) => {
  const baseFilter = { ...filter };
  delete baseFilter.status;
  const counts = await Booking.aggregate([{ $match: baseFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
  // "all" first, then every status zero-filled from the schema enum — same
  // shape as the billing-history statusCounts, so an "All" tab can be rendered
  // from the counts alone instead of summing them client-side. It totals
  // everything the filter matched, including any status not in the enum.
  const statuses = { all: 0 };
  Booking.schema.path("status").enumValues.forEach((s) => {
    statuses[s] = 0;
  });
  counts.forEach(({ _id, count }) => {
    statuses.all += count;
    if (_id in statuses) statuses[_id] = count;
  });
  return statuses;
};

const getUserBookings = async ({ userId, business, page, limit, status, scope, date, keyword, locale }) => {
  const filter = { user: new mongoose.Types.ObjectId(String(userId)) };
  // Optional: scope to one business — e.g. "my bookings with this business" tab
  if (business) filter.business = new mongoose.Types.ObjectId(String(business));
  if (status) filter.status = status;
  if (scope) filter.scope = scope;
  if (date) {
    const { start, end } = dateRangeForDay(new Date(date));
    filter.date = { $gte: start, $lte: end };
  }
  if (keyword) {
    filter.$or = [
      { bookingId: { $regex: keyword, $options: "i" } },
      { "target.name": { $regex: keyword, $options: "i" } },
    ];
  }

  const pipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    businessLookup,
    paymentLookup,
    { $addFields: { businessInfo: { $first: "$businessInfo" }, paymentInfo: { $first: "$paymentInfo" } } },
    ...canMessageLookup,
    ...flattenBookingDetails(locale),
    { $unset: "business" },
  ];
  if (page && limit) {
    pipeline.push({ $skip: (parseInt(page) - 1) * parseInt(limit) });
    pipeline.push({ $limit: parseInt(limit) });
  }

  const [rawBookings, total, statuses] = await Promise.all([
    Booking.aggregate(pipeline),
    Booking.countDocuments(filter),
    countBookingStatuses(filter),
  ]);

  const bookings = rawBookings.map(({ paymentInfo, ...booking }) => ({
    ...booking,
    source: booking.source,
    payment: paymentStatusLabel(paymentInfo?.status),
  }));

  const meta = {
    ...(page && limit ? { page: parseInt(page), limit: parseInt(limit) } : {}),
    total,
    statuses,
  };
  return { data: bookings, meta };
};

const getBusinessBookings = async ({ businessId, page, limit, status, scope, date, userId, keyword, locale }) => {
  const filter = { business: new mongoose.Types.ObjectId(String(businessId)) };
  if (status) filter.status = status;
  if (scope) filter.scope = scope;
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    filter.user = new mongoose.Types.ObjectId(String(userId));
  }
  if (date) {
    const { start, end } = dateRangeForDay(new Date(date));
    filter.date = { $gte: start, $lte: end };
  }
  if (keyword) {
    filter.$or = [
      { bookingId: { $regex: keyword, $options: "i" } },
      { "target.name": { $regex: keyword, $options: "i" } },
    ];
  }

  const pipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    userLookup,
    businessLookup,
    paymentLookup,
    {
      $addFields: {
        userInfo: { $first: "$userInfo" },
        businessInfo: { $first: "$businessInfo" },
        paymentInfo: { $first: "$paymentInfo" },
      },
    },
    ...canMessageLookup,
    ...flattenBookingDetails(locale),
    { $unset: "business" },
  ];
  if (page && limit) {
    pipeline.push({ $skip: (parseInt(page) - 1) * parseInt(limit) });
    pipeline.push({ $limit: parseInt(limit) });
  }

  const [bookings, total, statuses] = await Promise.all([
    Booking.aggregate(pipeline),
    Booking.countDocuments(filter),
    countBookingStatuses(filter),
  ]);

  const meta = {
    ...(page && limit ? { page: parseInt(page), limit: parseInt(limit) } : {}),
    total,
    statuses,
  };
  return { data: bookings, meta };
};

// Same shape as the target subdocument stored on the booking itself
// (name/price/actaulPrice/preferredServiceType) — preferredServiceType here
// is the plain display string resolved at booking time (e.g. "Onsite").
// photos comes from the top-level `photos` field flattenBookingDetails
// derives from the booking's snapshot (already full S3 URLs), not the target subdocument.
const billingTarget = (booking) =>
  booking.target?.[0]
    ? {
        id: booking.target[0]._id,
        name: booking.target[0].name,
        price: booking.target[0].price,
        actaulPrice: booking.target[0].actaulPrice,
        preferredServiceType: booking.target[0].preferredServiceType,
        photos: booking.photos || [],
      }
    : null;

// Billing/transactions tab (business only) — one row per paid-or-attempted
// booking, keyword search across service/customer/transaction id/amount, and
// filterable by the payment status label rather than the raw Payment.status
// enum. Rows, tab counts and the ?status= filter all speak the same
// vocabulary — the labels paymentStatusLabel produces — so a tab can never
// disagree with the rows underneath it or with the detail screen.
const PAYMENT_STATUS_ENUM = [
  "pending",
  "authorized",
  "captured",
  "partially_captured",
  "released",
  "failed",
  "expired",
  "refunded",
];

// Several raw statuses share a label (authorized and pending both read
// "pending"), so filtering by a label has to match every raw status behind it.
// A label with no known raw status maps to itself, which keeps the filter
// working for anything stored outside the enum.
const rawStatusesForLabel = (label) => {
  const matches = PAYMENT_STATUS_ENUM.filter((raw) => paymentStatusLabel(raw) === label);
  return matches.length > 0 ? matches : [label];
};

// Every label a payment can carry, zeroed — the starting point for
// meta.statusCounts so a tab with no rows reports 0 instead of going missing.
// Its keys double as the accepted ?status= values (see BILLING_STATUS_FILTERS),
// so the tabs the API reports and the filters it accepts can't drift apart.
const BILLING_STATUS_COUNT_TEMPLATE = PAYMENT_STATUS_ENUM.reduce(
  (template, raw) => ({ ...template, [paymentStatusLabel(raw)]: 0 }),
  { all: 0 },
);

// Accepted ?status= values — exactly the keys of meta.statusCounts, so every
// tab the API hands back can be clicked.
const BILLING_STATUS_FILTERS = Object.keys(BILLING_STATUS_COUNT_TEMPLATE);

const getBillingHistory = async ({ businessId, page = 1, limit = 10, keyword, status, startDate, endDate, locale }) => {
  const filter = {
    business: new mongoose.Types.ObjectId(String(businessId)),
    payment: { $exists: true, $ne: null },
  };
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  // basePipeline respects every filter except the status tab itself, so the
  // All/Paid/Pending/Refunded/Failed tab counts stay stable while switching tabs.
  const basePipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    userLookup,
    paymentLookup,
    { $addFields: { userInfo: { $first: "$userInfo" }, paymentInfo: { $first: "$paymentInfo" } } },
  ];

  if (keyword) {
    basePipeline.push({
      $match: {
        $or: [
          { "target.name": { $regex: keyword, $options: "i" } },
          { "userInfo.name": { $regex: keyword, $options: "i" } },
          { "userInfo.email": { $regex: keyword, $options: "i" } },
          { "paymentInfo.stripePaymentId": { $regex: keyword, $options: "i" } },
          {
            $expr: {
              $regexMatch: {
                input: { $toString: { $ifNull: ["$paymentInfo.amount", 0] } },
                regex: keyword,
                options: "i",
              },
            },
          },
        ],
      },
    });
  }

  const pipeline = [...basePipeline];
  if (status && status !== "all") {
    pipeline.push({ $match: { "paymentInfo.status": { $in: rawStatusesForLabel(status) } } });
  }

  const dataPipeline = [
    ...pipeline,
    ...flattenBookingDetails(locale),
    { $skip: (parseInt(page) - 1) * parseInt(limit) },
    { $limit: parseInt(limit) },
  ];

  const [rows, countResult, statusCountsAgg] = await Promise.all([
    Booking.aggregate(dataPipeline),
    Booking.aggregate([...pipeline, { $count: "count" }]),
    Booking.aggregate([...basePipeline, { $group: { _id: "$paymentInfo.status", count: { $sum: 1 } } }]),
  ]);

  // Counted per label, not per raw status, so the keys are exactly the values
  // rows carry in `status` and every booking lands in a tab — the labels that
  // collapse several raw statuses (authorized + pending → "pending") are
  // summed together, and the per-label counts add up to `all`.
  //
  // Zero-filled from the enum first: every tab is always present, so the UI
  // renders a stable set of tabs instead of one that appears and disappears
  // with the data. A label outside the enum still gets added on demand.
  const statusCounts = { ...BILLING_STATUS_COUNT_TEMPLATE };
  statusCountsAgg.forEach(({ _id, count }) => {
    statusCounts.all += count;
    const label = paymentStatusLabel(_id);
    if (label) statusCounts[label] = (statusCounts[label] || 0) + count;
  });

  const data = rows.map((b) => ({
    bookingId: b._id,
    bookingNumber: b.bookingId,
    target: billingTarget(b),
    customer: {
      id: b.userInfo?._id,
      name: b.userInfo?.name,
      email: b.userInfo?.email,
      profileImage: b.userInfo?.profileIcon,
    },
    date: b.date,
    slot: b.slot,
    source: b.source,
    paymentMethod: "Stripe",
    transactionId: b.transactionId,
    amount: b.paymentInfo?.amount ?? b.price,
    // Same label getBillingHistoryDetail returns, and the same key used in
    // meta.statusCounts and accepted by ?status= — one vocabulary everywhere.
    status: paymentStatusLabel(b.paymentInfo?.status),
  }));

  return {
    data,
    meta: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: countResult[0]?.count || 0,
      statusCounts,
    },
  };
};

// Billing receipt/detail screen (business only) — trimmed to just the
// receipt fields, unlike getBookingById's full booking-detail shape.
const getBillingHistoryDetail = async ({ id, businessId, locale }) => {
  const [booking] = await Booking.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(String(id)) } },
    userLookup,
    businessLookup,
    paymentLookup,
    flattenLookups,
    ...flattenBookingDetails(locale),
  ]);

  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business?.toString() !== businessId?.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }

  return {
    data: {
      bookingId: booking._id,
      bookingNumber: booking.bookingId,
      businessName: booking.businessInfo?.businessName,
      target: billingTarget(booking),
      slot: booking.slot,
      sessionSlotMins: booking.sessionSlotMins,
      customer: {
        id: booking.userInfo?._id,
        name: booking.userInfo?.name,
        email: booking.userInfo?.email,
        profileImage: booking.userInfo?.profileIcon,
      },
      paymentStatus: paymentStatusLabel(booking.paymentInfo?.status),
      paymentMethod: "Stripe",
      transactionId: booking.transactionId,
      price: booking.paymentInfo?.amount ?? booking.price,
      currency: booking.paymentInfo?.currency,
      platformPayment: booking.platformFeeAmount,
    },
  };
};

// Admin: every booking across every business/customer — no ownership filter.
const getAllBookingsAdmin = async ({ page, limit, status, scope, date, businessId, userId, keyword, locale }) => {
  const filter = {};
  if (status) filter.status = status;
  if (scope) filter.scope = scope;
  if (businessId && mongoose.Types.ObjectId.isValid(businessId)) {
    filter.business = new mongoose.Types.ObjectId(String(businessId));
  }
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    filter.user = new mongoose.Types.ObjectId(String(userId));
  }
  if (date) {
    const { start, end } = dateRangeForDay(new Date(date));
    filter.date = { $gte: start, $lte: end };
  }
  if (keyword) {
    filter.$or = [
      { bookingId: { $regex: keyword, $options: "i" } },
      { "target.name": { $regex: keyword, $options: "i" } },
    ];
  }

  const pipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    userLookup,
    businessLookup,
    paymentLookup,
    {
      $addFields: {
        userInfo: { $first: "$userInfo" },
        businessInfo: { $first: "$businessInfo" },
        paymentInfo: { $first: "$paymentInfo" },
      },
    },
    ...flattenBookingDetails(locale),
    { $unset: "business" },
  ];
  if (page && limit) {
    pipeline.push({ $skip: (parseInt(page) - 1) * parseInt(limit) });
    pipeline.push({ $limit: parseInt(limit) });
  }

  const [bookings, total, statuses] = await Promise.all([
    Booking.aggregate(pipeline),
    Booking.countDocuments(filter),
    countBookingStatuses(filter),
  ]);

  const meta = {
    ...(page && limit ? { page: parseInt(page), limit: parseInt(limit) } : {}),
    total,
    statuses,
  };
  return { data: bookings, meta };
};

// A canceled or expired booking is a dead end, so the detail screen offers
// somewhere to go next: live alternatives in the same category as the one that
// fell through, of the same kind — a service booking suggests services, a
// package booking suggests packages. Best rated first, the booked entity itself
// excluded. Same card shape the service/package detail suggestions use.
const REBOOK_SUGGESTION_STATUSES = ["canceled", "expired"];
const REBOOK_SUGGESTION_LIMIT = 5;

const getRebookSuggestions = async ({ scope, excludeId, categoryId, lat, lng, locale, viewerBusinessId }) => {
  if (!categoryId) return [];

  const isService = scope === "service";
  const Model = isService ? Services : Packages;
  const entityPipeline = isService ? servicePipeline : packagePipeline;
  const categoryObjId = new mongoose.Types.ObjectId(String(categoryId));

  return Model.aggregate([
    {
      $match: {
        _id: { $ne: new mongoose.Types.ObjectId(String(excludeId)) },
        $or: [{ category: categoryObjId }, { subcategory: categoryObjId }],
        status: "active",
        isAvailable: { $ne: false },
      },
    },
    ...entityPipeline({
      userLat: lat != null ? Number(lat) : null,
      userLng: lng != null ? Number(lng) : null,
      locale,
      viewerBusinessId,
    }),
    { $sort: { avgRating: -1, totalReviews: -1 } },
    { $limit: REBOOK_SUGGESTION_LIMIT },
    {
      $project: {
        _id: 1,
        name: 1,
        description: 1,
        ...(isService ? { photos: 1 } : { coverImage: 1 }),
        price: 1,
        durationMins: "$sessionSlotMins",
        canBook: 1,
        avgRating: 1,
        totalReviews: 1,
        // The providing business, same shape the list rows carry
        business: 1,
        // Neither a service nor a package has a location of its own — it's the
        // business's. packagePipeline already lifts it (and the distance) to the
        // top level; servicePipeline leaves both on the business sub-object.
        location: isService ? "$business.location" : 1,
        distanceKm: isService ? "$business.distanceKm" : 1,
      },
    },
  ]);
};

const getBookingById = async ({
  id,
  requesterId,
  businessId,
  userType,
  locale,
  timezone = "UTC",
  lat = null,
  lng = null,
  viewerBusinessId = null,
}) => {
  const hasUserCoords = lat != null && lng != null;
  const [booking] = await Booking.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(String(id)) } },
    userLookup,
    businessLookup,
    paymentLookup,
    flattenLookups,
    ...canMessageLookup,
    // How far the booked business is from the caller — businessInfo.location is
    // already on the response, this puts the same distanceKm beside it that the
    // service/package/business lists report.
    ...(hasUserCoords
      ? [
          {
            $addFields: {
              "businessInfo.distanceKm": haversineKmExpr(
                { $arrayElemAt: ["$businessInfo.location.coordinates", 1] },
                { $arrayElemAt: ["$businessInfo.location.coordinates", 0] },
                Number(lat),
                Number(lng),
              ),
            },
          },
        ]
      : []),
    ...flattenBookingDetails(locale),
  ]);

  if (!booking) return { error: "booking_not_found", status: 404 };

  // Friendly paid/pending/refunded/failed label, same mapping used on the
  // booking-list endpoints — kept alongside the raw paymentInfo.status.
  booking.paymentStatusLabel = paymentStatusLabel(booking.paymentInfo?.status);

  // booking.business holds the BusinessProfile id, not the User id
  const isOwner =
    (requesterId && booking.userInfo?._id?.toString() === requesterId.toString()) ||
    (businessId && booking.business?.toString() === businessId.toString());
  if (!isOwner && userType !== "admin") return { error: "booking_not_yours", status: 403 };

  // The review left for this specific booking, if any — not just any review
  // the customer left for the target service/package. Shaped to match
  // getProductReviews (reviewController/reviewService): reviewType/object/
  // subject/__v dropped, reviewer surfaced as its own { name, profileIcon } object.
  const reviewDoc = await Review.findOne({ booking: booking._id }).populate("subject", "name profileIcon").lean();
  // A customer may always see their own submission and admins may moderate it,
  // but providers cannot see it until it has been approved.
  const canSeeReview = reviewDoc && (userType === "admin" || userType === "user" || reviewDoc.status === "approved");
  if (canSeeReview) {
    const { reviewType, object, subject, __v, ...rest } = reviewDoc;
    booking.review = {
      ...rest,
      reviewer: subject
        ? {
            ...subject,
            profileIcon: subject.profileIcon ? getFullImageUrl(subject.profileIcon) : subject.profileIcon,
          }
        : subject,
    };
  } else {
    booking.review = null;
  }

  // Live rating + live bookability of the booked service/package (target holds
  // the snapshot taken at booking time, which carries neither). status and
  // isAvailable let the client decide whether to offer "Book again" — an entity
  // the business has since deactivated or flipped unavailable can't be rebooked,
  // and getSlots/createBooking would reject it. A hard-deleted entity reports
  // status null / isAvailable false for the same reason.
  if (booking.target?.[0]) {
    const reviewType = booking.scope === "service" ? "services" : "packages";
    const Model = booking.scope === "service" ? Services : Packages;
    const [[ratingStats], liveEntity] = await Promise.all([
      Review.aggregate(reviewStatsPipeline({ reviewType, object: booking.target[0]._id })),
      // category rides along for the rebook suggestions below
      Model.findById(booking.target[0]._id).select("status isAvailable category").lean(),
    ]);
    booking.target[0].rating = {
      avgRating: Math.round((ratingStats?.avgRating || 0) * 10) / 10,
      totalReviews: ratingStats?.totalReviews || 0,
    };
    booking.target[0].status = liveEntity?.status ?? null;
    booking.target[0].isAvailable = liveEntity ? liveEntity.isAvailable !== false : false;

    // Customer-facing only — a business or admin opening the same booking has no
    // use for a rebooking prompt. The key is always present on a terminal
    // booking (empty when the entity was hard-deleted, so its category is gone),
    // so the client can render the section without a shape check.
    if (userType === "user" && REBOOK_SUGGESTION_STATUSES.includes(booking.status)) {
      const suggestions = await getRebookSuggestions({
        scope: booking.scope,
        excludeId: booking.target[0]._id,
        categoryId: liveEntity?.category,
        lat,
        lng,
        locale,
        viewerBusinessId,
      });
      booking[booking.scope === "service" ? "suggestedServices" : "suggestedPackages"] = suggestions;
    }
  }

  // canStart / timer: the provider can start a "scheduled" session once it's
  // within START_WINDOW_MS of its slot start — the frontend uses timer to
  // count down to that moment and show/enable the Start button. The slot's
  // "HH:mm" is interpreted in the requesting user's own timezone so the
  // window lines up with their wall-clock, not the server's.
  if (booking.status === "scheduled") {
    const now = new Date();
    const slotStart = slotStartDate(booking.date, booking.slot, timezone);
    const canStartAt = new Date(slotStart.getTime() - START_WINDOW_MS);
    booking.canStart = now >= canStartAt;
    booking.timer = {
      slotStart,
      canStartAt,
      secondsUntilStart: Math.floor((slotStart.getTime() - now.getTime()) / 1000),
      secondsUntilCanStart: Math.max(0, Math.floor((canStartAt.getTime() - now.getTime()) / 1000)),
    };
  } else {
    booking.canStart = false;
    booking.timer = null;
  }

  return { data: booking };
};

const acceptBooking = async ({ id, businessId }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business.toString() !== businessId.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }
  if (booking.status !== "requested") return { error: "booking_cannot_accept", status: 400 };

  const { entity } = await resolveEntity(booking.scope, booking.target[0]._id);
  if (!entity) return { error: "booking_entity_not_found", status: 404 };

  // This booking is "requested" and so already counts towards the slot —
  // exclude it, or a single-seat service could never approve anything.
  const acceptedCount = await countAcceptedInSlot(entity._id, booking.date, booking.slot, booking._id);
  if (acceptedCount >= slotCapacity(entity)) return { error: "booking_slot_full", status: 400 };

  booking.status = "scheduled";
  await booking.save();

  sendUserNotifications({
    recipientIds: [booking.user],
    title: "Booking Accepted",
    body: `Your booking for ${booking.target[0]?.name} has been accepted`,
    data: { type: "booking_accepted", objectType: "booking" },
    notificationType: NotificationTypes.BOOKING_APPROVED,
    objectId: booking._id,
    sender: businessId,
  });

  return { data: booking };
};

/**
 * Provider manually starts a scheduled session — replaces the old cron-driven
 * auto-transition. Only allowed within START_WINDOW_MS of the slot start.
 */
const startBooking = async ({ id, businessId, timezone = "UTC" }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business.toString() !== businessId.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }
  if (booking.status !== "scheduled") return { error: "booking_cannot_start", status: 400 };

  // Same timezone reference as the detail page's canStart/timer, so the
  // window the provider sees matches what the mutation actually enforces.
  const slotStart = slotStartDate(booking.date, booking.slot, timezone);
  const canStartAt = new Date(slotStart.getTime() - START_WINDOW_MS);
  if (new Date() < canStartAt) {
    return { error: "booking_start_too_early", status: 400 };
  }

  booking.status = "ongoing";
  await booking.save();

  sendUserNotifications({
    recipientIds: [booking.user],
    title: "Session Started",
    body: `Your session for ${booking.target[0]?.name} has started`,
    data: { type: "booking_started", objectType: "booking" },
    notificationType: NotificationTypes.BOOKING_PICKED,
    objectId: booking._id,
    sender: businessId,
  });

  return { data: booking };
};

const rejectBooking = async ({ id, businessId, reason }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business.toString() !== businessId.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }
  if (booking.status !== "requested") return { error: "booking_cannot_reject", status: 400 };

  const rejectReason = reason || "Stylist rejected your Booking Request";
  booking.status = "canceled";
  booking.cancel = { reason: rejectReason, by: "business" };
  await booking.save();

  // Provider rejected — release the hold fully, no fees charged
  await releaseBookingPayment(booking);

  closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
    console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
  );

  sendUserNotifications({
    recipientIds: [booking.user],
    title: "Booking Rejected",
    body: `Your booking for ${booking.target[0]?.name} was not accepted: ${rejectReason}`,
    data: { type: "booking_rejected", objectType: "booking" },
    notificationType: NotificationTypes.BOOKING_REJECTED,
    objectId: booking._id,
    sender: businessId,
  });

  return { data: booking };
};

const cancelBooking = async ({ id, requesterId, businessId, reason }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };

  const isUser = booking.user.toString() === requesterId.toString();
  const isBusiness = businessId && booking.business.toString() === businessId.toString();
  if (!isUser && !isBusiness) return { error: "booking_not_yours", status: 403 };

  if (!["requested", "scheduled"].includes(booking.status)) {
    return { error: "booking_cannot_cancel", status: 400 };
  }

  booking.status = "canceled";
  booking.cancel = { reason: reason || "", by: isUser ? "user" : "business" };
  await booking.save();

  // Cancellation matrix: who cancels + policy window decides what Stripe does
  await resolveCancellationPayment(booking, isUser ? "user" : "business");

  closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
    console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
  );

  const notifyId = isUser ? booking.business : booking.user;
  sendUserNotifications({
    recipientIds: [notifyId],
    title: "Booking Cancelled",
    body: `A booking for ${booking.target[0]?.name} has been cancelled${reason ? `: ${reason}` : ""}`,
    data: { type: "booking_cancelled", objectType: "booking" },
    notificationType: NotificationTypes.BOOKING_CANCELED,
    objectId: booking._id,
    sender: requesterId,
  });

  return { data: booking };
};

const buildReminderMessage = (type, booking) => {
  const name = booking.target[0]?.name ?? "your session";
  const date = new Date(booking.date).toDateString();
  const time = booking.slot?.open ?? "";

  const messages = {
    payment: {
      title: "Payment Reminder",
      body: `Please complete your payment for "${name}" scheduled on ${date} at ${time}.`,
    },
    slot: {
      title: "Upcoming Session Reminder",
      body: `Reminder: Your session for "${name}" is on ${date} at ${time}. See you soon!`,
    },
    start: {
      title: "Your Session Is Starting",
      body: `Your session for "${name}" is starting now at ${time}. Please be ready.`,
    },
  };

  return messages[type];
};

const sendReminder = async ({ id, businessId, type }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business.toString() !== businessId.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }
  if (booking.status !== "scheduled") return { error: "booking_reminder_not_accepted", status: 400 };

  // The customer's own "Booking Reminders" toggle gates this specific
  // notification type — separate from their general Push Notifications toggle
  const customerProfile = await UserProfile.findOne({ user: booking.user }).select("notificationPreferences");
  if (customerProfile && customerProfile.notificationPreferences.bookingReminders === false) {
    return { data: null };
  }

  const { title, body } = buildReminderMessage(type, booking);

  sendUserNotifications({
    recipientIds: [booking.user],
    title,
    body,
    data: { type: `booking_reminder_${type}`, objectType: "booking" },
    notificationType: NotificationTypes.REMINDER,
    objectId: booking._id,
    sender: businessId,
  });

  return { data: null };
};

const getSlots = async ({ scope, targetId, date }) => {
  const bookingDate = new Date(date);
  if (isNaN(bookingDate.getTime())) return { error: "booking_date_invalid", status: 400 };

  // const now = new Date();
  // const todayStart = new Date(now.toDateString());
  // if (bookingDate < todayStart) {
  //   return { error: "booking_date_past", status: 400 };
  // }

  const { entity } = await resolveEntity(scope, targetId);
  if (!entity) return { error: "booking_entity_not_found", status: 404 };
  if (entity.status === "deleted" || entity.status === "inactive") {
    return { error: "booking_entity_not_found", status: 404 };
  }
  // Unavailable is a live toggle, not a deletion: the business can flip it
  // while a customer already has the detail screen open (unavailable items are
  // filtered out of the lists), so name the reason instead of returning an
  // empty schedule or a bare "not found".
  if (entity.isAvailable === false) {
    return { error: scope === "package" ? "package_unavailable" : "service_unavailable", status: 409 };
  }

  // const promotion = await findActivePromotion(entity._id, scope);
  const daySchedule = getDaySchedule(entity, bookingDate);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOfWeek = days[bookingDate.getDay()];

  if (!daySchedule) {
    return {
      data: {
        entityName: entity.name,
        date,
        dayOfWeek,
        isOpen: false,
        slots: [],
      },
    };
  }

  const generatedSlots = bookableSlotsForDay(entity, daySchedule);

  // Seats taken per slot for this date — counted exactly like
  // countAcceptedInSlot (confirmed bookings + in-checkout drafts), otherwise
  // a slot shown as available here gets rejected as full at booking time.
  const { start, end } = dateRangeForDay(bookingDate);
  const groupBySlot = {
    $group: {
      _id: { open: "$slot.open", close: "$slot.close" },
      count: { $sum: 1 },
    },
  };
  const [bookingCounts, draftCounts] = await Promise.all([
    Booking.aggregate([
      {
        $match: {
          "target._id": entity._id,
          date: { $gte: start, $lte: end },
          status: { $in: SEAT_HOLDING_STATUSES },
        },
      },
      groupBySlot,
    ]),
    BookingDraft.aggregate([
      {
        $match: {
          "target._id": entity._id,
          date: { $gte: start, $lte: end },
        },
      },
      groupBySlot,
    ]),
  ]);

  const countMap = {};
  [...bookingCounts, ...draftCounts].forEach(({ _id, count }) => {
    const key = `${_id.open}-${_id.close}`;
    countMap[key] = (countMap[key] ?? 0) + count;
  });

  const capacity = slotCapacity(entity);
  const slots = generatedSlots.map((slot) => {
    const acceptedCount = countMap[`${slot.open}-${slot.close}`] ?? 0;
    const availableSpots = Math.max(0, capacity - acceptedCount);

    // Same check createBooking uses to reject a stale slot (booking_slot_past)
    let status = slotStartDate(bookingDate, slot).getTime() <= Date.now() ? "past" : "available";
    if (status !== "past" && availableSpots === 0) status = "full";

    return {
      open: slot.open,
      close: slot.close,
      isOvernight: slot.isOvernight,
      status,
      availableSpots: status === "past" ? 0 : availableSpots,
      concurrentClients: capacity,
    };
  });

  return {
    data: {
      entityName: entity.name,
      originalPrice: scope === "service" ? entity.price : entity.actualPrice,
      finalPrice: entity.price,
      // finalPrice: resolveAmount(entity, promotion),
      // promotion: promotion
      //   ? {
      //       name: promotion.name,
      //       promoCode: promotion.promoCode,
      //       discountType: promotion.discountType,
      //       discount: promotion.discount,
      //     }
      //   : null,
      date,
      dayOfWeek,
      isOpen: true,
      slots,
    },
  };
};

// How far ahead to look before calling a business unbookable. Two weeks covers
// every weekly schedule, including one that only opens on a single day.
const NEXT_SLOT_SEARCH_DAYS = 14;

/**
 * The business's next bookable slot, across all of its active services and
 * packages — the soonest one that hasn't started and still has a free seat.
 *
 * Walks forward a day at a time and stops at the first day that yields a
 * bookable slot, so the usual case costs one pair of seat-count queries.
 * Availability is judged exactly as getSlots judges it (same seat-holding
 * statuses, same in-checkout drafts), so a slot reported here is one a customer
 * can actually take.
 *
 * Returns null when the business has nothing bookable in the search window.
 */
const getNextAvailableSlot = async ({ businessId }) => {
  const business = new mongoose.Types.ObjectId(String(businessId));
  const entityFilter = { business, status: "active", isAvailable: { $ne: false } };
  const selection = "name slots concurrentClients";

  const [services, packages] = await Promise.all([
    Services.find(entityFilter).select(selection).lean(),
    Packages.find(entityFilter).select(selection).lean(),
  ]);

  const entities = [
    ...services.map((entity) => ({ ...entity, scope: "service" })),
    ...packages.map((entity) => ({ ...entity, scope: "package" })),
  ];
  if (entities.length === 0) return null;

  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < NEXT_SLOT_SEARCH_DAYS; offset++) {
    const day = new Date(today);
    day.setDate(day.getDate() + offset);

    // Every not-yet-started slot every entity offers on this day, soonest first.
    const candidates = [];
    for (const entity of entities) {
      const daySchedule = getDaySchedule(entity, day);
      if (!daySchedule) continue;

      for (const slot of bookableSlotsForDay(entity, daySchedule)) {
        const startsAt = slotStartDate(day, slot);
        if (startsAt.getTime() <= now) continue; // same cut-off as booking_slot_past
        candidates.push({ entity, slot, startsAt });
      }
    }
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => a.startsAt - b.startsAt);

    // Seats taken on this day, counted once for every entity in play rather
    // than per candidate slot.
    const { start, end } = dateRangeForDay(day);
    const dayMatch = {
      "target._id": { $in: [...new Set(candidates.map((c) => c.entity._id))] },
      date: { $gte: start, $lte: end },
    };
    const groupBySlot = {
      $group: {
        _id: { entityId: "$target._id", open: "$slot.open", close: "$slot.close" },
        count: { $sum: 1 },
      },
    };
    const [bookingCounts, draftCounts] = await Promise.all([
      Booking.aggregate([{ $match: { ...dayMatch, status: { $in: SEAT_HOLDING_STATUSES } } }, groupBySlot]),
      BookingDraft.aggregate([{ $match: dayMatch }, groupBySlot]),
    ]);

    const takenSeats = new Map();
    for (const { _id, count } of [...bookingCounts, ...draftCounts]) {
      const key = `${_id.entityId}-${_id.open}-${_id.close}`;
      takenSeats.set(key, (takenSeats.get(key) ?? 0) + count);
    }

    for (const { entity, slot, startsAt } of candidates) {
      const key = `${entity._id}-${slot.open}-${slot.close}`;
      const availableSpots = slotCapacity(entity) - (takenSeats.get(key) ?? 0);
      if (availableSpots <= 0) continue;

      return {
        // "Today"/"Tomorrow" while it's near, an actual date once it isn't —
        // the label the overview card renders as-is.
        label: offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : moment(day).format("MMM D, YYYY"),
        date: moment(day).format("YYYY-MM-DD"),
        dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.getDay()],
        open: slot.open,
        close: slot.close,
        isOvernight: slot.isOvernight,
        startsAt,
        availableSpots,
        concurrentClients: slotCapacity(entity),
        target: { _id: entity._id, name: entity.name, scope: entity.scope },
      };
    }
  }

  return null;
};

/**
 * Provider marks the service as completed → capture the authorization hold.
 * Stripe splits the funds (application fee → platform, rest → connected
 * account, prod only). Capture failure triggers the debt lock.
 */
const completeBooking = async ({ id, businessId }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.business.toString() !== businessId.toString()) {
    return { error: "booking_not_yours", status: 403 };
  }

  const now = new Date();
  const sessionEnded = slotEndDate(booking.date, booking.slot) <= now;
  const canComplete = booking.status === "ongoing" || (booking.status === "scheduled" && sessionEnded);
  if (!canComplete) return { error: "booking_cannot_complete", status: 400 };

  if (booking.paymentStatus === "captured") {
    booking.status = "completed";
    await booking.save();
    closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
      console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
    );
    return { data: booking };
  }

  if (booking.paymentStatus !== "authorized" || !booking.payment) {
    return { error: "booking_payment_not_captured", status: 400 };
  }

  const payment = await Payment.findById(booking.payment);
  if (!payment) return { error: "booking_payment_not_captured", status: 400 };

  try {
    const captured = await captureStripePayment(payment.stripePaymentId);
    payment.status = "captured";
    payment.capturedAmount = (captured.amount_received ?? captured.amount) / 100;
    await payment.save();

    booking.status = "completed";
    booking.paymentStatus = "captured";
    await booking.save();

    closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
      console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
    );

    sendUserNotifications({
      recipientIds: [booking.user],
      title: "Booking Completed",
      body: `Your booking for ${booking.target[0]?.name} has been completed. Payment has been processed.`,
      data: { type: "booking_completed", objectType: "booking" },
      notificationType: NotificationTypes.BOOKING_COMPLETED,
      objectId: booking._id,
      sender: businessId,
    });

    return { data: booking };
  } catch (error) {
    // Card failed at capture (e.g. frozen mid-week) — debt-lock the customer
    console.error(`completeBooking capture failed for ${booking.bookingId}:`, error.message);
    payment.status = "failed";
    await payment.save();
    booking.status = "completed";
    await applyDebtLock({ booking });
    closeConversationIfNoActiveBookings({ userId: booking.user, businessId: booking.business }).catch((err) =>
      console.error(`closeConversationIfNoActiveBookings failed for booking ${booking._id}:`, err.message),
    );
    return { error: "booking_capture_failed", status: 402 };
  }
};

// Revenue stats for a single service/package, for the owning business's own
// detail view — totalEarned (all-time), thisWeek, thisMonth. Only bookings
// with a captured (actually paid) payment count as earned.
const getEntityEarnings = async ({ entityId, timezone = "UTC" }) => {
  const now = new Date();
  const { start: weekStart } = getStartAndEndOfWeek(now, timezone);
  const { start: monthStart } = getStartAndEndOfMonth(now, timezone);

  const [result] = await Booking.aggregate([
    { $match: { "target._id": new mongoose.Types.ObjectId(String(entityId)) } },
    {
      $lookup: {
        from: "payments",
        localField: "payment",
        foreignField: "_id",
        as: "paymentDetails",
      },
    },
    { $addFields: { paymentDetails: { $first: "$paymentDetails" } } },
    { $match: { "paymentDetails.status": "captured" } },
    {
      $facet: {
        total: [{ $group: { _id: null, sum: { $sum: "$paymentDetails.amount" } } }],
        thisWeek: [
          { $match: { "paymentDetails.createdAt": { $gte: weekStart } } },
          { $group: { _id: null, sum: { $sum: "$paymentDetails.amount" } } },
        ],
        thisMonth: [
          { $match: { "paymentDetails.createdAt": { $gte: monthStart } } },
          { $group: { _id: null, sum: { $sum: "$paymentDetails.amount" } } },
        ],
      },
    },
  ]);

  return {
    totalEarned: result?.total?.[0]?.sum || 0,
    thisWeek: result?.thisWeek?.[0]?.sum || 0,
    thisMonth: result?.thisMonth?.[0]?.sum || 0,
  };
};

/**
 * Insufficient-funds recovery for a requires_payment_fix booking. Two modes,
 * chosen by whether the caller supplied a fresh stripePaymentMethodId:
 * - Omitted: retry the card already on file (on-session — customer is
 *   present, so a required 3DS challenge surfaces a clientSecret instead of
 *   hard-failing).
 * - Supplied: vault the new card and retry with it. When it confirms
 *   synchronously the hold is retried immediately; otherwise the frontend
 *   confirms via client_secret and the setup_intent.succeeded webhook
 *   triggers the retry.
 */
const fixBookingPayment = async ({ id, user, paymentMethod }) => {
  const booking = await Booking.findById(id);
  if (!booking) return { error: "booking_not_found", status: 404 };
  if (booking.user.toString() !== user._id.toString()) return { error: "booking_not_yours", status: 403 };
  if (booking.paymentStatus !== "requires_payment_fix") {
    return { error: "booking_payment_fix_not_required", status: 400 };
  }

  if (!paymentMethod) {
    if (!booking.stripePaymentMethodId) {
      return { error: "booking_payment_method_required", status: 400 };
    }
    // Lazy require: bookingLifecycleService imports from this module
    const { chargeVaultedBooking } = require("./bookingLifecycleService");
    try {
      const { stripeStatus, clientSecret } = await chargeVaultedBooking(booking, { offSession: false });
      if (stripeStatus === "requires_capture") {
        return { data: { booking, intentType: "payment" } };
      }
      // requires_action — customer needs to complete a fresh 3DS challenge
      // on the same card via handleNextAction(clientSecret)
      return { data: { booking, clientSecret, intentType: "payment" } };
    } catch (err) {
      console.error(`fixBookingPayment retry (existing card) failed for ${booking.bookingId}:`, err.message);
      return { error: "booking_payment_fix_failed", status: 400 };
    }
  }

  // A fresh card was supplied — vault it and retry
  const { setupIntent, clientSecret } = await createBookingSetupIntent({
    user,
    paymentMethod,
    bookingId: booking._id,
    businessId: booking.business,
  });

  booking.stripeSetupIntentId = setupIntent.id;
  if (setupIntent.status === "succeeded") {
    booking.stripePaymentMethodId = setupIntent.payment_method;
    await booking.save();
    // Lazy require: bookingLifecycleService imports from this module
    const { retryHorizonAuthorization } = require("./bookingLifecycleService");
    // Customer is present in this exact request — on-session, so a required
    // 3DS challenge on the freshly-vaulted card surfaces a clientSecret
    // instead of hard-declining.
    const retry = await retryHorizonAuthorization(booking, { offSession: false });
    if (retry.stripeStatus === "requires_capture") {
      return { data: { booking, intentType: "setup" } };
    }
    if (retry.clientSecret) {
      // Vaulted fine, but the immediate charge needs a fresh 3DS challenge
      return { data: { booking, clientSecret: retry.clientSecret, intentType: "payment" } };
    }
    // Vaulted fine, but the charge was declined outright — card is now on
    // file for next time, but this attempt didn't clear the fix-required state
    return { error: "booking_payment_fix_failed", status: 400 };
  }

  await booking.save();
  return { data: { booking, clientSecret, intentType: "setup" } };
};

/**
 * Release whatever payment mechanism the booking holds:
 * cancel the PaymentIntent when funds are on hold, or unlink the vaulted card.
 * The customer is never charged.
 */
const releaseBookingPayment = async (booking) => {
  if (booking.payment) {
    const payment = await Payment.findById(booking.payment);
    if (payment && ["pending", "authorized"].includes(payment.status)) {
      try {
        await cancelStripePayment(payment.stripePaymentId);
      } catch (err) {
        // Already canceled/expired on Stripe's side — releasing locally is still correct
        console.error(`releaseBookingPayment cancel failed for ${payment.stripePaymentId}:`, err.message);
      }
      payment.status = "released";
      await payment.save();
    }
  }
  booking.stripePaymentMethodId = undefined;
  booking.paymentStatus = "released";
  await booking.save();
  return booking;
};

/**
 * Cancellation matrix (spec Phase 5):
 * - provider-initiated → full release, no fees
 * - customer, free window / fully refundable → full release
 * - customer, late (inside howLateCanCancel) → capture the non-refundable
 *   share as a late fee, void the remainder
 * - nothing held yet (pending / vaulted) → release / unlink only
 */
const resolveCancellationPayment = async (booking, canceledBy) => {
  if (canceledBy === "business") return releaseBookingPayment(booking);

  if (booking.paymentStatus !== "authorized" || !booking.payment) {
    return releaseBookingPayment(booking);
  }

  const snapshot = booking.snapshot || {};
  const cutoff = snapshot.howLateCanCancel || {};
  const cutoffMs = ((cutoff.hours || 0) * 60 + (cutoff.mins || 0)) * 60 * 1000;
  const slotStart = slotStartDate(booking.date, booking.slot);
  const isLate = slotStart.getTime() - Date.now() < cutoffMs;

  const refundPct = snapshot.refundPercentage ?? 0;
  const feePct = 100 - refundPct;

  if (!isLate || feePct <= 0) return releaseBookingPayment(booking);

  const payment = await Payment.findById(booking.payment);
  if (!payment) return releaseBookingPayment(booking);

  const amount = booking.target[0]?.price ?? payment.amount;
  const feeAmount = parseFloat(((amount * feePct) / 100).toFixed(2));

  try {
    if (feePct >= 100) {
      // Non-refundable: capture the full authorized amount
      await captureStripePayment(payment.stripePaymentId);
      payment.status = "captured";
      payment.capturedAmount = amount;
      booking.paymentStatus = "captured";
    } else {
      // Late fee: partial capture — Stripe voids the uncaptured remainder
      await captureStripePayment(payment.stripePaymentId, Math.round(feeAmount * 100));
      payment.status = "partially_captured";
      payment.capturedAmount = feeAmount;
      booking.paymentStatus = "partially_captured";
    }
    await payment.save();
    booking.stripePaymentMethodId = undefined;
    await booking.save();
  } catch (err) {
    // Capture failed (hold expired etc.) — releasing is the safe fallback
    console.error(`resolveCancellationPayment capture failed for ${booking.bookingId}:`, err.message);
    return releaseBookingPayment(booking);
  }
  return booking;
};

// Calendar view (Today / Weekly / Monthly): scoped to the caller (user or
// business), a lean projection of just what the calendar cell/tooltip needs
// rather than the full booking-detail shape.
const getBookingsCalendar = async ({ userId, businessId, userType, range, date, status, timezone = "UTC" }) => {
  const filter =
    userType === "business"
      ? { business: new mongoose.Types.ObjectId(String(businessId)) }
      : { user: new mongoose.Types.ObjectId(String(userId)) };

  const refDate = date ? new Date(date) : new Date();
  const { start, end } =
    range === "monthly"
      ? getStartAndEndOfMonth(refDate, timezone)
      : range === "weekly"
        ? getStartAndEndOfWeek(refDate, timezone)
        : getStartAndEndOfDay(refDate, timezone);
  filter.date = { $gte: start, $lte: end };

  // statuses breakdown reflects everything in range regardless of the status
  // filter — same "unfiltered tab counts" pattern as getUserBookings/getBusinessBookings
  const statuses = await countBookingStatuses(filter);

  if (status) filter.status = status;

  const pipeline = [
    { $match: filter },
    { $sort: { date: 1, "slot.open": 1 } },
    userLookup,
    businessLookup,
    { $addFields: { userInfo: { $first: "$userInfo" }, businessInfo: { $first: "$businessInfo" } } },
    {
      $project: {
        _id: 1,
        bookingId: 1,
        scope: 1,
        slot: 1,
        date: 1,
        status: 1,
        userInfo: 1,
        businessInfo: 1,
        name: { $first: "$target.name" },
        photos: {
          $map: {
            input: { $ifNull: ["$snapshot.photos", []] },
            as: "photo",
            in: s3UrlExpr("$$photo"),
          },
        },
      },
    },
  ];

  const bookings = await Booking.aggregate(pipeline);
  return { data: bookings, meta: { range, start, end, statuses } };
};

module.exports = {
  createBooking,
  getUserBookings,
  getBusinessBookings,
  getBillingHistory,
  getBillingHistoryDetail,
  BILLING_STATUS_FILTERS,
  getAllBookingsAdmin,
  getBookingsCalendar,
  getBookingById,
  acceptBooking,
  startBooking,
  rejectBooking,
  cancelBooking,
  sendReminder,
  getSlots,
  getNextAvailableSlot,
  paymentStatusLabel,
  bookingPriceBreakdown,
  getEntityEarnings,
  routeBookingAfterPaymentSecured,
  releaseBookingPayment,
  fixBookingPayment,
  completeBooking,
  resolveEntity,
  slotStartDate,
  slotEndDate,
  countBookingStatuses,
  materializeBookingFromDraft,
  findOrCreateBookingForPaymentIntent,
  findOrCreateBookingForSetupIntent,
};
