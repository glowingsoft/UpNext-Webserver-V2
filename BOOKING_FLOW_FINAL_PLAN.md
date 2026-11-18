# Booking Flow v2 — FINAL IMPLEMENTATION PLAN (Corrected)

## Executive Summary
Replace mixed booking system (old manual-approval + instant) with single instant flow using:
- **State machine**: 7 statuses (requested → confirmed → completed/canceled)
- **Provider window**: 2 min to accept/decline (all bookings: Available Now + advance)
- **Payment window**: 5 min to fix card if auto-auth fails
- **Customer decision**: 3 min to choose next provider (per attempt)
- **Attempt limits**: max 3 providers OR 15 min, then canceled (no_match)
- **Send-again-once**: Per provider, per attempt (max 2 sends via BookingOffer.sendCount)
- **Packages**: ✅ Included (same flow, no changes)
- **Penalties**: Stripe fee extraction, idempotent transfer (only after capture)

---

## Phase 1: Models & Config (DETAILED CHANGES)

### 1. Bookings.js — Status & Fields Overhaul

#### New Status Enum (7 total)
```
"requested"                    // Offer sent, provider has 2 min to accept/decline
"awaiting_customer_decision"   // Provider declined/timeout, customer picking next provider (3 min)
"accepted_awaiting_payment"    // Provider accepted, auto-auth in progress, customer can fix card (5 min)
"confirmed"                    // Both locked in, slot guaranteed, hold ready for capture
"ongoing"                       // Service started
"completed"                     // Service done, capture/transfer in progress
"canceled"                      // Terminal, reason below
```

#### New cancelReason Enum (8 reasons)
```
"no_match"           // No eligible provider found after 3 attempts or 15 min
"customer_timeout"   // Customer didn't choose next provider within 3 min
"payment_timeout"    // Auto-auth failed, customer didn't fix card within 5 min
"slot_taken"         // Last seat taken by concurrent booking (race)
"client"             // Customer manually canceled
"provider"           // Provider canceled (only before Confirmed)
"no_show"            // No-show (client-reported or provider-confirmed)
"system"             // Platform error or admin cancel
```

#### Fields to Remove
- `searchStartedAt`, `searchDeadline`, `instant.matchSimilar`, `instant.excluded`, `instant.searchDeadline`
- `liveOffer` field (moved to Booking.flow.currentOffer)

#### Fields to Keep
- `statusHistory` (reuse as-is)
- `pricing` (servicePriceCents, depositCents, feeCents, chargeFeeCents, totalCents, heldCents, settings snapshot)
- `capture` (kind, amountCents, status, attempts, retries)
- `payout` (status, grossCents, netCents, transferId, stripeFeeShareCents)
- `agreement` (text, version, agreedAt)

#### Fields to Add/Change
```javascript
{
  // Current attempt (1-based)
  attempt: { type: Number, default: 1 },

  // Payout status (separate from payout sub-doc for easier querying)
  payoutStatus: {
    type: String,
    enum: ["none", "pending", "paid", "failed", "skipped"],
    default: "none"
  },

  // Per-attempt decline tracking (for send-again-once)
  providerDeclineCount: { type: Number, default: 0 },

  // Timeouts (moved from instant sub-doc for clarity)
  offerExpiresAt: { type: Date, default: null },           // When offer expires (2 min)
  awaitingPaymentDeadline: { type: Date, default: null },  // When to give up on auth fix (5 min)
  awaitingDecisionDeadline: { type: Date, default: null }, // When to expire customer decision window (3 min)

  // Check-ins (moved from instant.checkIns)
  checkIns: {
    arrived: { at: Date, lat: Number, lng: Number },
    completed: { at: Date, lat: Number, lng: Number }
  },

  // Reason when canceled
  cancelReason: { type: String, enum: [...above...], default: null },

  // Renamed from "instant" (clearer naming)
  flow: {
    type: new Schema({
      requestedAt: { type: Date, required: true },
      location: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: [Number]  // [lon, lat]
      },
      categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
      attemptStartedAt: { type: Date },
      currentProviderIndex: { type: Number },  // For ranked re-offer (which position in list)

      // Current live offer
      currentOffer: {
        offerId: { type: Schema.Types.ObjectId, ref: "BookingOffer" },
        sentAt: { type: Date },
        expiresAt: { type: Date }
      },

      // Removed fields (no longer needed):
      // - excluded[] (tracked via BookingOffer.status + sendCount)
      // - matchSimilar (removed from flow)
      // - searchDeadline (use maxAttemptMinutes instead)
    }, { _id: false }),
    required: function() { return this.mode === "instant"; }
  },

  // New for completion/no-show
  noShow: {
    status: { type: String, enum: ["none", "reported", "contested", "upheld", "overturned"], default: "none" },
    reportedAt: Date,
    reportedBy: { type: String, enum: ["client", "provider"] },
    contestedAt: Date,
    contestNote: String,
    resolvedAt: Date,
    resolutionNote: String
  }
}
```

#### Indexes to Add
```javascript
// For sweepers
{ status: 1, offerExpiresAt: 1 }
{ status: 1, awaitingPaymentDeadline: 1 }
{ status: 1, awaitingDecisionDeadline: 1 }
{ status: 1, "flow.attemptStartedAt": 1 }
```

---

### 2. BookingOffer.js — Remove Unique Constraint, Add Send Count

#### Remove
- Unique index on (booking, business) — allows resend after decline/timeout

#### Add
```javascript
{
  sendCount: { type: Number, default: 1 }  // Incremented on resend, capped per attempt
}
```

#### Update Status Enum
```
"pending"    // Offer active, waiting for response
"accepted"   // Provider accepted
"declined"   // Provider declined
"expired"    // Timed out (2 min)
"closed"     // Replaced by newer offer or booking progressed
```

#### Indexes to Add
```javascript
{ booking: 1, status: 1, expiresAt: 1 }        // Sweeper
{ business: 1, status: 1, sendCount: 1 }       // Track send-again-once
{ booking: 1, business: 1, attempt: 1 }        // Track per-provider per-attempt
```

---

### 3. AdminSettings.js — Timers, Weights, Remove Instant Payout

#### Rename/Add Timers (all in seconds)
```javascript
instant: {
  // OLD: offerWindowSec → NEW: providerAcceptSec (no change in value, just clarity)
  providerAcceptSec: { type: Number, default: 120, min: 10 },

  // NEW: How long customer has after auto-auth fails to fix card
  paymentSec: { type: Number, default: 300, min: 30 },

  // NEW: How long customer has to pick next provider after decline/timeout
  customerDecisionSec: { type: Number, default: 180, min: 30 },

  // NEW: Max total time to find a provider (3 providers OR 15 min, whichever first)
  maxAttemptMinutes: { type: Number, default: 900, min: 60 },

  // Scoring weights for ranking eligible providers (new sub-doc)
  scoringWeights: {
    travelTime: { type: Number, default: 100 },        // Most important
    rating: { type: Number, default: 50 },
    acceptanceRate: { type: Number, default: 30 },
    similarity: { type: Number, default: 20 }
  },

  // Streak: how many consecutive timeouts before suspension
  timeoutStreakLimit: { type: Number, default: 3, min: 1 },

  // Everything else (keep as-is)
  feeFloorCents,
  feeRatePercent,
  feeCapCents,
  minInstantPriceCents,
  depositPercent,
  maxProviders,
  maxSearchSec,
  radiusKm,
  penaltyDeductionCents,
  penaltyWindowDays,
  suspensionHours,
  noShowReportWindowMin,
  noShowContestWindowHours,

  // REMOVE: instantPayoutFeePercent (use standard Stripe transfer fees only)
}
```

---

### 4. Services.js — Replace Refund Fields with Policy Enum

#### Remove
```javascript
howLateCanBook: { removed }
howLateCanCancel: { removed }
refundPercentage: { removed }
refundRules: { removed }
```

#### Add
```javascript
cancellationPolicy: {
  type: String,
  enum: ["non_refundable", "refundable_24h"],
  default: "non_refundable"
}
```

**Semantics**:
- `non_refundable` — After Confirmed, all charges non-refundable (booking fee + deposit always; service if no cancellation policy specified).
- `refundable_24h` — If canceled 24+ hours before slot, refund service + deposit, keep fee. If < 24h, keep fee + deposit.

---

### 5. BusinessProfile.js — Remove liveOffer

#### Remove
```javascript
liveOffer: {
  offer: ObjectId,
  booking: ObjectId,
  expiresAt: Date
}
```

**Why**: Moved to Booking.flow.currentOffer (per-booking instead of per-provider).

#### Keep (No Changes)
- `matchStats` (offersReceived/Accepted/Declined/Expired, responseCount/SecTotal, completed, penaltyWeight30d, lastOfferAt)
- `suspendedUntil` (when provider timeout streak expires)
- `isAvailable` (flipped by penalty system)

---

### 6. Card.js — No Changes
✅ Reuse as-is (paymentMethodId, last4, brand, expMonth, expYear, isDefault).

---

### 7. UserModel.js — No Changes
✅ Reuse as-is (hasOutstandingDebt, outstandingBookings, outstandingAmount, instantBlocked).

---

### 8. Payment.js — No Changes
✅ Reuse as-is (status enum already has "authorized", "captured", "partially_captured", "released", "failed").

---

### 9. Dispute.js — No Changes
✅ Reuse as-is (stripeDisputeId, booking, provider, amountCents, status, faultParty, deductionRecorded).

---

### 10. ProviderPenalty.js — No Changes
✅ Reuse as-is (provider, booking, type: cancellation/no_show/dispute, weight, deductionCents, appliedCents).

---

### 11. scripts/createIndexes.js — Add New Indexes

```javascript
// Booking indexes (for sweepers + queries)
db.bookings.createIndex({ status: 1, offerExpiresAt: 1 });
db.bookings.createIndex({ status: 1, awaitingPaymentDeadline: 1 });
db.bookings.createIndex({ status: 1, awaitingDecisionDeadline: 1 });
db.bookings.createIndex({ status: 1, "flow.attemptStartedAt": 1 });

// BookingOffer indexes (for sweepers + send-again-once)
db.bookingoffer.createIndex({ booking: 1, status: 1, expiresAt: 1 });
db.bookingoffer.createIndex({ business: 1, status: 1, sendCount: 1 });
db.bookingoffer.createIndex({ booking: 1, business: 1, attempt: 1 });
```

---

## Phase 2: API Endpoints (Brief Overview)

### Send Booking Request
```
POST /api/v1/app/bookings/send-request
{
  scope: "service" | "package",
  targetId: ObjectId,
  date: Date,
  slot: { open: "HH:mm", close: "HH:mm", isOvernight: bool },
  providerId: ObjectId,        // ONE provider only
  stripePaymentMethodId: String // Required (saved card)
}
Response: { bookingId, offerId, expiresAt, serverNow, prices: { ... } }
```

### Provider Accept
```
POST /api/v1/app/bookings/:id/accept
Response: { bookingId, status, paymentStatus, expiresAt? }
// On success: status = "confirmed" OR "accepted_awaiting_payment"
// If awaiting_payment: 5 min to call pay endpoint
```

### Provider Decline
```
POST /api/v1/app/bookings/:id/decline
Response: { bookingId, status: "awaiting_customer_decision" }
// No eligible providers list here; customer calls GET /next-providers
```

### Get Eligible Next Providers
```
GET /api/v1/app/bookings/:id/next-providers
Query: skip=0, limit=3
Response: {
  providers: [
    { providerId, businessName, rating, distance, matchScore, ... },
    ...
  ],
  deadline: Date  // When customer must decide (3 min from now)
}
```

### Customer Send Again (Same Provider)
```
POST /api/v1/app/bookings/:id/send-again
{ providerId: ObjectId }
Response: { offerId, expiresAt }
// Enforced: max 2 sends per provider per attempt (BookingOffer.sendCount >= 2 blocks)
```

### Customer Send to Next Provider
```
POST /api/v1/app/bookings/:id/send-request-to-next-provider
{ providerId: ObjectId }
Response: { offerId, expiresAt, newAttempt: false }
// Resets timer, picks from ranked list. May increment attempt if all preferred exhausted.
```

### Customer Pay for Authorization (Fix Card)
```
POST /api/v1/app/bookings/:id/pay-for-authorization
{ stripePaymentMethodId?: String }  // Optional (use default if not provided)
Response: { status: "confirmed" | "requires_action", clientSecret?: String }
// Only valid during "accepted_awaiting_payment" status
// After deadline: 422 "Payment window expired"
```

### Cancel Booking
```
POST /api/v1/app/bookings/:id/cancel
{ reason: "client" | "provider" | "system" }
Response: { bookingId, status: "canceled", cancelReason, refundAmount }
```

### Provider Arrived Check-In
```
POST /api/v1/app/bookings/:id/check-in/arrived
{ lat: Number, lng: Number }
Response: { bookingId, checkIns: { arrived: { at, lat, lng } } }
```

### Complete Booking (Provider)
```
POST /api/v1/app/bookings/:id/complete
{ lat?: Number, lng?: Number }
Response: { bookingId, status: "completed", payoutStatus, transfer?: { id, amount } }
```

### Report No-Show (Customer, within 1 hour of slot start)
```
POST /api/v1/app/bookings/:id/report-no-show
{ reportedBy: "client" }
Response: { bookingId, noShow: { status: "reported", reportedAt } }
```

### Contest No-Show (Provider, within 24 hours)
```
POST /api/v1/app/bookings/:id/contest-no-show
{ contestNote: String, arrivedCheckInTime: Date }
Response: { bookingId, noShow: { status: "contested", contestedAt } }
```

---

## Phase 3: Business Logic (Services Layer)

### instantBookingFlowService.js (NEW ~1000 lines)
- `sendBookingRequest()` — Validate slot, card, eligibility, create offer, emit socket.
- `acceptBookingOffer()` — Provider accept, auto-auth, atomically confirm or await payment.
- `declineBookingOffer()` — Mark declined, emit to customer, return eligible next-providers list.
- `providerTimeoutHandler()` — Mark timeout, update streak, emit to customer.
- `fetchEligibleProviders()` — Filter + rank for next-provider screen.
- `sendAgain()` — Resend to same provider (max 2 per attempt).
- `sendToNextProvider()` — Send to ranked provider, may increment attempt.
- `customerPaymentFix()` — Retry auto-auth on new card.
- `cancelBooking()` — All scenarios, compute refund.
- `reportNoShow()` — Customer report (within 1h).
- `contestNoShow()` — Provider contest (within 24h, requires Arrived check-in).

### bookingLifecycleService.js (REFACTOR ~500 lines)
- ❌ Remove: `runApprovalExpiryCron`, `runHorizonChargeCron`, `runPaymentFixGraceCron` (old crons).
- ✅ Add: `sweepOfferTimeouts()` — Every 5s, mark expired offers as expired, fail booking.
- ✅ Add: `sweepPaymentWindowTimeouts()` — Every 5s, mark expired awaitingPaymentDeadline as payment_timeout.
- ✅ Add: `sweepCustomerDecisionTimeouts()` — Every 5s, mark expired awaitingDecisionDeadline as customer_timeout.
- ✅ Add: `sweepAttemptTimeouts()` — Every 5s, mark booking as no_match if > 15 min or 3 providers tried.

All sweepers use CAS (findOneAndUpdate with status conditions) to avoid races.

### paymentService.js (REFACTOR ~300 lines)
- ❌ Remove: Old setup-intent logic, 4-day horizon vaulting, application fee.
- ✅ Add: `authorizeBookingPaymentOffSession()` — Auto-auth (off-session), manual-capture PI, no destination, no fee.
- ✅ Keep: `captureBookingPayment()` — Manual capture after confirmed (completion) or on cancellation.
- ✅ Keep: `refundBookingPayment()` — Full/partial refunds.
- ✅ Add: `computeRefundAmount()` — Per scenario (pre-Confirmed, post-Confirmed, cancellationPolicy).

### instantPaymentService.js (REFACTOR ~400 lines)
- ✅ Keep: Retry logic (capture retries, payout retries).
- ✅ Add: `captureOnCompletion()` — After provider calls complete, charge held amount.
- ✅ Add: `handleExpiredAuthorization()` — If hold expired, charge fresh PI (post-completion only).
- ✅ Add: `transferProviderShare()` — Idempotent transfer (only after capture succeeds), Stripe fee extraction.
- ✅ Add: `autoRetryPaymentDue()` — Small retry window for failed completion capture.

### instantOfferService.js (REFACTOR ~300 lines)
- ✅ Reuse: `findRerouteCandidates()`, adapt for new eligibility (30-min route duration, free slot).
- ✅ Reuse: `transitionOffer()`, adapt for new statuses.
- ✅ Reuse: `sendOffer()`, adapt for new socket payloads.
- ✅ Reuse: `rankCandidates()` — Use new scoringWeights from AdminSettings.

### penaltyService.js (KEEP ~200 lines)
- ✅ Reuse: `recordPenalty()`, `rollingWeights()`, `refreshPenaltyState()`, `consumeDeductions()`.

---

## Phase 4: Cron Jobs (Consolidate into Single 5s Job)

### config/cron/index.js (REFACTOR ~50 lines)

**Remove old crons:**
- `runApprovalExpiryCron` (every hour)
- `runHorizonChargeCron` (every hour)
- `runPaymentFixGraceCron` (every hour)
- `runStatusTransitionCron` (every 5 min)

**Add new cron (every 5s):**
```javascript
cron.schedule("*/5 * * * * *", withLock("cron:instant-booking-sweepers", async () => {
  await sweepOfferTimeouts();
  await sweepPaymentWindowTimeouts();
  await sweepCustomerDecisionTimeouts();
  await sweepAttemptTimeouts();
}, 4));
```

**Keep (no changes):**
- Every 1 min: `refreshPenaltyState` (penaltyService).
- Every 1 min: `runInstantPaymentsCron` (instantPaymentService).
- Every 30 min: `runBookingCompletionReminderCron`.

---

## Send-Again-Once Enforcement (Detailed)

### Mechanism
1. **Per BookingOffer**: Track `sendCount` (starts at 1 when created, incremented on resend).
2. **Per Booking + Provider**: Only one live offer per provider per booking.
3. **Per Attempt**: Once provider declines or times out, they are excluded from the same attempt.

### Flow
```
Customer sends request to Provider A (Attempt 1)
├─ BookingOffer.sendCount = 1, status = "pending"
├─ Provider A declines or times out
├─ offer.status = "declined" | "expired"
├─ Booking.flow.currentOffer cleared

Customer calls GET /next-providers
├─ Returns ranked eligible providers (excluding A, because it declined/timed out)
├─ Deadline: 3 min to choose

Customer calls POST /send-again to Provider A
├─ Check: Is Provider A in declined/expired/closed offers for this booking?
├─ If NO → Create new BookingOffer, sendCount = 1
├─ If YES, check sendCount in existing offers for A:
│   ├─ If sendCount >= 2 → 422 "Max resend attempts reached"
│   └─ If sendCount < 2 → Create new offer, sendCount = 2 (or increment)

Customer calls POST /send-request-to-next-provider (Provider B, from eligible list)
├─ Attempt remains 1 (same attempt, same 3-provider limit)
├─ Clear previous offer, create new offer for B

After 3 sends OR 15 min → no_match, canceled
```

### Enforcement Code Pattern
```javascript
// When sending request:
const sendBookingRequest = async (booking, providerId, ...) => {
  // 1. Count live offers for this booking + provider in this attempt
  const existingOffers = await BookingOffer.find({
    booking: booking._id,
    business: providerId,
    status: { $in: ["pending", "accepted"] }
  }).lean();

  if (existingOffers.length > 0) {
    return error("Offer already pending for this provider");
  }

  // 2. Count declined/expired offers to enforce max 2 sends
  const priorOffers = await BookingOffer.find({
    booking: booking._id,
    business: providerId,
    status: { $in: ["declined", "expired", "closed"] }
  }).lean();

  if (priorOffers.length > 0 && priorOffers[priorOffers.length - 1].sendCount >= 2) {
    return error("Max resend attempts reached for this provider");
  }

  // 3. Create new offer
  const sendCount = priorOffers.length > 0 ? priorOffers[priorOffers.length - 1].sendCount + 1 : 1;
  const offer = await BookingOffer.create({ ..., sendCount });
  return success(offer);
};
```

---

## Stripe Integration (Phase 3+)

### Features Required
1. ✅ **Off-session auto-auth** — Customer saved PaymentMethod + manual-capture PI.
2. ✅ **Manual capture** — Authorize at accept, capture at completion or on cancellation.
3. ✅ **Refunds** — Full or partial per scenario.
4. ✅ **Transfers** — Standard platform → provider (transfer_group, source_transaction).
5. ❌ **No destination charges** — Remove from current code.
6. ❌ **No 5% application fee** — Remove from current code.

### Stripe Balance Transactions (for fee extraction)
- After capture, fetch the balance transaction (source_transaction) to extract Stripe fee.
- Formula: `Provider Share = Service Price - Stripe Fee (from balance) - Penalties`.

### Idempotent Transfer (Critical)
```javascript
// Only transfer AFTER capture succeeds
const transferProviderShare = async (booking) => {
  if (booking.capture.status !== "captured") {
    throw new Error("Cannot transfer before capture");
  }
  if (booking.payout.transferId) {
    // Already transferred, return existing
    return { transferId: booking.payout.transferId, duplicate: true };
  }

  const transfer = await stripe.transfers.create({
    amount: booking.payout.netCents,
    currency: "usd",
    destination: booking.provider.stripe.accountId,
    transfer_group: String(booking._id),
    source_transaction: booking.capture.chargeId,
    metadata: { bookingId: String(booking._id) }
  });

  await Booking.updateOne(
    { _id: booking._id, "payout.transferId": null },
    { $set: { "payout.transferId": transfer.id, "payout.status": "paid", payoutStatus: "paid" } }
  );
  return transfer;
};
```

---

## Cron Dependency Check (Before Removal)

### Old Crons to Remove
1. **runApprovalExpiryCron** (old "requested" status expiry)
2. **runHorizonChargeCron** (4-day pre-auth vaulted card charge)
3. **runPaymentFixGraceCron** (24h grace for payment-fix)

### Any Active Bookings Still Using These?
- **No** — New flow uses different status names + timers.
- Old "requested" → becomes "requested" (but 2 min timeout via sweeper, not 24h).
- Old vaulted charge → removed (no pre-auth; only confirm-time auth).
- Old payment-fix → becomes "accepted_awaiting_payment" (5 min window via sweeper).

### Action
✅ Safe to remove old crons. New sweeper handles all timeouts uniformly.

---

## Travel Duration in Route Distance Helper (Phase 3)

### Current State
- routeDistanceHelper.js computes straight-line (haversine) or road distance (Google Maps).

### Extension Needed
- Add `duration` output (driving/walking minutes).
- Use for eligibility: Available Now bookings must be reachable within 30 min.

### Code Pattern
```javascript
const attachRouteDistances = async (payload, userLat, userLng, travelMode = "driving") => {
  // Existing logic: fetch distances
  // NEW: Also extract duration from Google response
  const result = {
    distanceKm: ...,
    distanceMode: ...,
    durationMins: route.duration.value / 60  // Extract from response
  };
  return result;
};

// In eligibility filter:
const isReachable = (distanceKm, durationMins, isAvailableNow) => {
  if (isAvailableNow) return durationMins <= 30; // 30 min rule
  return true; // Advance bookings have no distance cap
};
```

---

## Packages in Instant Flow (DECISION: INCLUDE ✅)

### Rationale
- Same state machine (request → accept → confirm → complete).
- Same pricing, holds, captures, payouts.
- No additional complexity.

### Required Changes
- **None** — Booking.scope already branches on "service" vs "package".
- Service entity resolution (used for slot loading) already handles both.

### No Changes Needed To
- Eligibility filters (isAvailable, status, price, category checks work for packages).
- Concurrency logic (concurrentClients applies per service/package).
- Distance logic (distance to provider's business location applies).
- Pricing/fee calculations (same formula).
- Cancellation policy (apply same refund logic per service type).

---

## Separate Issues (NOT IN THIS TASK)

1. **Socket auth gap** — `/chat` push notifications (provider accept/decline reminders, payment-fix prompts).
   - Requires: Real-time channel per provider + customer.
   - Separate task: Implement socket auth, emit events.

2. **Native app work** — Full-screen offer countdown, push sound, notification channel.
   - Requires: Push notification service config, mobile SDK updates.
   - Separate task: Implement push channel, countdown UI.

---

## Summary: What Changes, What Stays

### Phase 1 (Models) — 6 files edited
- ✏️ Bookings.js, BookingOffer.js, AdminSettings.js, Services.js, BusinessProfile.js, scripts/createIndexes.js
- ✅ Card, UserModel, Payment, Dispute, ProviderPenalty (no changes)

### Phase 2 (Business Logic) — ~2500 lines new/refactored
- ✏️ instantBookingFlowService.js (new, ~1000 lines)
- ✏️ bookingLifecycleService.js (refactor, remove old crons, add sweepers, ~500 lines)
- ✏️ paymentService.js (refactor, remove app fee + horizon, add off-session auth, ~300 lines)
- ✏️ instantPaymentService.js (refactor, add completion capture + transfer, ~400 lines)
- ✏️ instantOfferService.js (adapt ranking + offer logic, ~300 lines)
- ✅ penaltyService.js (reuse as-is, ~200 lines)

### Phase 3 (API) — ~400 lines new
- ✏️ bookingController.js (new endpoints, refactor existing)

### Phase 4 (Cron) — ~50 lines
- ✏️ config/cron/index.js (consolidate into single 5s job)

### Tests (~500 lines)
- instantBookingFlowService.test.js — Stripe mocked, all scenarios.

### No Migration Script
- Dev DB only; drop old collections, rerun schema init.

---

## Pauses (User Review Points)

### ⏸️ STOP 1: After Phase 1 (Models)
- Confirm model changes before code implementation.

### ⏸️ STOP 2: After State Machine + Scoring + Sweepers (Phase 2a)
- Confirm status transitions, CAS logic, sweeper design before payment integration.

### ⏸️ STOP 3: After Payments + Payout (Phase 2b/3)
- Confirm Stripe capture, transfer, refund logic before testing.

### ✅ Go: Phase 4 (Cron + Tests)
- No review needed; mechanical consolidation + test coverage.

