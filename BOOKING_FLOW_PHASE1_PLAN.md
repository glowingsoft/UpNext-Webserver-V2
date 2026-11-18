# Booking Flow v2 — UPDATED PLAN + AUDIT RESULTS

## Model Audit Summary (What Exists, What Needs Changes)

### ✅ Already Exist (Reuse As-Is)
- **Card.js** — Saved payment methods (paymentMethodId, last4, brand, expMonth, expYear, isDefault). ✅ Needed for "saved valid card required" gate.
- **Dispute.js** — Stripe dispute records (stripeDisputeId, booking, provider, amountCents, status, outcome, faultParty, deductionRecorded). ✅ Needed for payout deductions.
- **ProviderPenalty.js** — Ledger (provider, booking, type: cancellation/no_show/dispute, weight, deductionCents, appliedCents, appliedAt). ✅ Reuse entire model.
- **BusinessProfile.matchStats** — offersReceived/Accepted/Declined/Expired, responseSecTotal/Count, completed, penaltyWeight30d, lastOfferAt. ✅ Reuse.
- **UserModel.hasOutstandingDebt, outstandingBookings, outstandingAmount, outstandingBooking** — Debt tracking. ✅ Reuse.
- **Payment.js** — status enum includes "authorized", "captured", "partially_captured", "released", "failed", "expired", "refunded". ✅ Reuse.
- **Services.js** — Has `howLateCanBook`, `howLateCanCancel`, `refundPercentage`, `refundRules`. ⚠️ Need to replace with `cancellationPolicy` enum.

### ⚠️ Exist But Need Changes
- **Bookings.js**
  - ❌ Remove: old status enum, `searchStartedAt`, `searchDeadline`, `instant.matchSimilar`, `instant.excluded`, `liveOffer` (move to attempt-level tracking).
  - ✅ Keep: `statusHistory`, `pricing`, `capture`, `payout`, `agreement`.
  - 🔄 Change status enum → `requested`, `awaiting_customer_decision`, `accepted_awaiting_payment`, `confirmed`, `ongoing`, `completed`, `canceled`.
  - 🔄 Change `cancelReason` → enum `no_match`, `customer_timeout`, `payment_timeout`, `slot_taken`, `client`, `provider`, `no_show`, `system`.
  - 🔄 Add `attempt` (1-based attempt number, for "send-again" enforcement).
  - 🔄 Add `payoutStatus` → enum `none`, `pending`, `paid`, `failed`, `skipped` (separate from payout sub-doc for easier querying).
  - 🔄 Add `providerDeclineCount` (for per-attempt tracking).
  - 🔄 Flatten `instant.offer.expiresAt` → `offerExpiresAt` at booking root level.
  - 🔄 Add `awaitingPaymentDeadline` (payment window expiry).
  - 🔄 Add `awaitingDecisionDeadline` (customer decision window expiry).
  - 🔄 Add `checkIns.arrived` → { at, lat, lng } (provider Arrived).
  - 🔄 Add `checkIns.completed` → { at, lat, lng } (completion check-in).
  - 🔄 Rename `instant` sub-doc → `flow` (clearer naming).
  - 🔄 Add to `flow`: `attemptStartedAt`, `currentProviderIndex` (for ranking on reroute).

- **BookingOffer.js**
  - ❌ Remove unique index on (booking, business) — allow resend after timeout/decline.
  - 🔄 Change status enum → `pending`, `accepted`, `declined`, `expired`, `closed`.
  - 🔄 Add `sendCount` (for per-provider send-again-once enforcement: e.g., max 2 sends per provider per attempt).

- **AdminSettings.js** (instant sub-doc)
  - ✅ Keep: `feeFloorCents`, `feeRatePercent`, `feeCapCents`, `minInstantPriceCents`, `depositPercent`.
  - ✅ Keep: `maxProviders`, `maxSearchSec`, `radiusKm`, `penaltyDeductionCents`, `penaltyWindowDays`, `suspensionHours`, `noShowReportWindowMin`, `noShowContestWindowHours`.
  - 🔄 Rename `offerWindowSec` → `providerAcceptSec` (120 default).
  - 🔄 Add `paymentSec` (300 default, awaiting_payment deadline).
  - 🔄 Add `customerDecisionSec` (180 default, awaiting_customer_decision deadline).
  - 🔄 Add `maxAttemptMinutes` (900 default, total search time limit).
  - 🔄 Add `timeoutStreakLimit` (3 default, consecutive timeouts before suspension).
  - 🔄 Add `scoringWeights` sub-doc: `travelTime`, `rating`, `acceptanceRate`, `similarity`.
  - ✅ Keep: `instantPayoutFeePercent` → **REMOVE** (no Instant Payout; standard Stripe transfers only).

- **BusinessProfile.liveOffer**
  - ❌ Remove: liveOffer entire field (move to per-attempt tracking in Booking.flow.currentOffer).
  - 🔄 Track current offer at booking level, not provider level.

- **Services.js**
  - ❌ Remove: `howLateCanBook`, `howLateCanCancel`, `refundPercentage`, `refundRules`.
  - 🔄 Add: `cancellationPolicy` → enum `non_refundable` (default) or `refundable_24h`.

### ❌ Do Not Need (No Impact)
- **BookingDraft.js** — Used for old checkout flow; handled by new single instant-flow (no checkout stage).
- **Packages** — See decision below.

---

## Key Decisions

### 1. Send-Again-Once Enforcement
**Mechanism**: Track per BookingOffer + per booking attempt.
- BookingOffer.sendCount (starts at 1, incremented on resend).
- **Enforcement rule**: `GET /next-providers` only returns providers NOT in (declined, timed out, or with sendCount >= 2) for this attempt.
- When provider times out or declines, the offer is excluded from future sends in the same attempt.
- **New attempt** = customer taps "Review next provider" or clicks "next provider" on awaiting_customer_decision screen → booking.attempt incremented, booking.flow.currentProviderIndex reset.

### 2. Advance Bookings (Lessons for 2-Minute Provider Accept Window)
**Recommendation**: Use same 2-minute window for all bookings (both Available Now and future dates).
- **Rationale**: Simplicity (single timer), fairness (provider accepts or moves on), and consistency (same UX everywhere).
- **Risk mitigation**: Require Arrived check-in before slot start → no "ghost accepts". If provider doesn't arrive in time, they're no-show (penalty).
- **Provider protection**: Admin can extend window per business in AdminSettings if needed (advanced tuning).
- **Decision**: ✅ Keep 2 min for all bookings (providerAcceptSec=120).

### 3. Packages Feasibility
**Decision**: ✅ **Include packages in instant flow with no changes to booking/payment logic.**
- Booking.scope still branches: "service" or "package".
- Eligibility filter: package.isAvailable, status "active", price >= minInstantPrice.
- Pricing, holds, captures, payouts work identically.
- **Changes needed**: None in booking flow; only in slot loading and service entity resolution (both already handle packages).
- **Why include**: Zero complexity addition; same state machine for both. Deferring wastes scope.

---

## Updated Phase 1: Models & Config (DETAILED)

### Bookings.js Changes
```javascript
// Remove old fields/enums, keep/add these:

status: {
  enum: [
    "requested",                    // Customer sent to provider, waiting for accept/decline
    "awaiting_customer_decision",   // Provider declined/timeout, customer choosing next provider
    "accepted_awaiting_payment",    // Provider accepted, auto-auth initiated, awaiting customer to fix card if failed
    "confirmed",                    // Both parties locked in, slot guaranteed
    "ongoing",                       // Service started
    "completed",                     // Service finished, capture/payout in progress
    "canceled"                       // Terminal, refund released (or none owed)
  ]
}

// Terminal cancellation reasons (set on cancel)
cancelReason: {
  enum: [
    "no_match",                      // No eligible provider found in max attempts
    "customer_timeout",              // Customer didn't choose next provider within 3 min
    "payment_timeout",               // Auth failed, customer didn't fix card within 5 min
    "slot_taken",                    // Last seat taken by another booking race
    "client",                         // Customer manually canceled
    "provider",                       // Provider canceled (before Confirmed)
    "no_show",                        // Customer no-show or provider no-show
    "system"                          // Platform error/refund
  ]
}

// New fields
attempt: { type: Number, default: 1 },  // 1-based attempt number
payoutStatus: {
  enum: ["none", "pending", "paid", "failed", "skipped"],
  default: "none"
}
providerDeclineCount: { type: Number, default: 0 }

// Flatten instant.offer.expiresAt
offerExpiresAt: { type: Date, default: null }
awaitingPaymentDeadline: { type: Date, default: null }  // payment_timeout window
awaitingDecisionDeadline: { type: Date, default: null } // customer_timeout window

// Rename instant → flow for clarity
flow: {
  type: new Schema({
    requestedAt: Date,
    location: { type: { type: String, enum: ["Point"], default: "Point" }, coordinates: [Number] },
    categoryId: Schema.Types.ObjectId,
    attemptStartedAt: Date,
    currentProviderIndex: Number,  // for ranked re-offers
    // Removed: excluded[], matchSimilar, searchDeadline
    currentOffer: {
      offerId: Schema.Types.ObjectId,
      expiresAt: Date,
      sentAt: Date
    }
  }, { _id: false }),
  required: function () { return this.mode === "instant"; }
}

// Check-ins under flow or root?
// Root level (clearer for queries):
checkIns: {
  arrived: { at: Date, lat: Number, lng: Number },
  completed: { at: Date, lat: Number, lng: Number }
}
```

### BookingOffer.js Changes
```javascript
status: {
  enum: ["pending", "accepted", "declined", "expired", "closed"],
  default: "pending"
}
sendCount: { type: Number, default: 1 }  // Track resends

// Remove unique index on (booking, business)
// Add index for sweeper:
index({ booking: 1, status: 1, expiresAt: 1 })
```

### AdminSettings.js Changes
```javascript
instant: {
  // Timers (seconds, renamed/added)
  providerAcceptSec: { type: Number, default: 120, min: 10 },
  paymentSec: { type: Number, default: 300, min: 30 },
  customerDecisionSec: { type: Number, default: 180, min: 30 },
  maxAttemptMinutes: { type: Number, default: 900, min: 60 },
  
  // Scoring weights (new sub-doc)
  scoringWeights: {
    travelTime: { type: Number, default: 100 },
    rating: { type: Number, default: 50 },
    acceptanceRate: { type: Number, default: 30 },
    similarity: { type: Number, default: 20 }
  },
  
  // Streak/penalty
  timeoutStreakLimit: { type: Number, default: 3, min: 1 },
  
  // REMOVE: instantPayoutFeePercent (use standard Stripe transfer fees)
}
```

### Services.js Changes
```javascript
// Remove
howLateCanBook: { removed }
howLateCanCancel: { removed }
refundPercentage: { removed }
refundRules: { removed }

// Add
cancellationPolicy: {
  type: String,
  enum: ["non_refundable", "refundable_24h"],
  default: "non_refundable"
}
```

### BusinessProfile.js Changes
```javascript
// Remove
liveOffer: { removed }  // Moved to Booking.flow.currentOffer

// Keep
matchStats { ... }  // Unchanged
suspendedUntil: Date  // Unchanged
```

### Indexes to Create (scripts/createIndexes.js)
```javascript
// Booking indexes (for sweepers)
Booking: [
  { status: 1, offerExpiresAt: 1 },              // Sweep offer timeouts
  { status: 1, awaitingPaymentDeadline: 1 },     // Sweep payment timeouts
  { status: 1, awaitingDecisionDeadline: 1 },    // Sweep decision timeouts
  { status: 1, "flow.attemptStartedAt": 1 },     // Sweep attempt timeouts
]

// BookingOffer indexes (for sweepers)
BookingOffer: [
  { booking: 1, status: 1, expiresAt: 1 },       // Sweep offer expiry
  { business: 1, status: 1, sendCount: 1 }       // Track send-again-once
]
```

---

## Phase 1 Summary (What Changes)

### Files to Edit (6)
1. **Bookings.js** — status enum, fields, flow sub-doc, check-ins, payoutStatus, attempt.
2. **BookingOffer.js** — status enum, sendCount, remove unique index.
3. **AdminSettings.js** — timers, scoring weights, remove Instant Payout fee.
4. **Services.js** — replace refund fields with cancellationPolicy.
5. **BusinessProfile.js** — remove liveOffer.
6. **scripts/createIndexes.js** — add new indexes.

### Files That Don't Change (Reuse As-Is)
- Card.js, Dispute.js, ProviderPenalty.js, UserModel.js, Payment.js.

### No Migration Needed
- Dev DB only; drop old booking data on reinit.

---

## Known Integration Points to Revisit in Phase 2

### State Machine & CAS Transitions
- Booking status transitions use MongoDB CAS (findOneAndUpdate with conditions).
- Atomic: re-check slot capacity on confirm, release hold if slots taken.

### Stripe Features Required (Phase 2+)
1. **Off-session auto-auth** — PaymentMethod + manual-capture PaymentIntent.
2. **Manual capture** — authorize now, capture later (completion or timeout).
3. **Refunds** — full or partial per cancellation scenario.
4. **Transfers** — standard platform → provider (no destination, no application fee).
5. **No 5% application fee** (remove from current paymentService.js).

### Sweeper Logic (Phase 2)
- Every 5s: Check 4 expiry types (offer, payment, decision, attempt) using indexes.
- CAS transitions on expiry (status → canceled, reason → timeout, release hold).

### Distance Calculation Extend (Phase 2)
- routeDistanceHelper → include duration (30 min check for Available Now eligibility).

---

## Next Step
✅ **PHASE 1 READY FOR APPROVAL**

Confirm before proceeding:
1. Model changes look correct?
2. Send-again-once mechanism (per-BookingOffer sendCount + per-attempt exclusion)?
3. 2-minute window for all bookings (advance + Available Now)?
4. Include packages in instant flow (same state machine)?
