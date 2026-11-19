# Booking Flow v2 — Code Reconciliation

## Existing Implementation Assessment

### Models ✅
- **BookingOffer** — Exists, minimal (booking, business, serviceId, servicePriceCents, status, attempt, score, sentAt, expiresAt, respondedAt). Needs new statuses and structure for new flow.
- **Bookings** — Exists but heavily mixed (old manual-approval + instant modes). Needs refactor.
  - Has `instant` sub-doc with `offer.current/expiresAt` (single live offer per booking).
  - Has `pricing` sub-doc (fee, deposit, total, held).
  - Has `capture` sub-doc (completion/cancellation, retries, status).
  - Has `payout` sub-doc (transfer status, amounts, deductions).
  - Has `statusHistory` array ✅.
  - Status enum outdated: ["searching", "no_match", "scheduled", "requested", "ongoing", "expired", "canceled", "completed"]. **Replace with new enum.**
  - Has old payment fields (`payment` ref, `paymentStatus` enum, `stripePaymentMethodId`, `stripeSetupIntentId`).
- **AdminSettings** — Exists with `instant` sub-doc: feeFloor/Rate/Cap (cents/%), minPrice, deposit%, offerWindowSec, maxProviders, maxSearchSec, radius, penalties. **Adapt for new timers** (providerAcceptSec=120, paymentSec=300, customerDecisionSec=180, maxAttemptMinutes=900).
- **ProviderPenalty** — Exists, tracks type (cancellation/no_show/dispute), weight, deduction, rolling 30d. Re-uses consumeDeductions on payout. ✅
- **Card** model — Check if exists for saved payment methods.

### Services
- **instantOfferService** — Sweeper (5s), ranking, reroute, offer lifecycle (sendOffer, transitionOffer, clearBookingOffer). **Heavily reuse** offer logic, adapt for new state transitions.
- **penaltyService** — recordPenalty, rollingWeights, refreshPenaltyState (1min), consumeDeductions, restoreDeductions. **Reuse as-is.**
- **paymentService** — createStripePayment (via stripePayment.js), setup intents, capture logic. **Refactor for new flow** (off-session auto-auth, manual-capture only, no destination charges, no application fee).
- **bookingService** — Huge file, mixed mode logic. Needs **partial reuse** (slotting, concurrency, eligibility, distance). Dead code removal.
- **bookingLifecycleService** — Likely has old crons (approval expiry, horizon charge, payment fix, status transitions). **Refactor for new flow.**
- **instantPaymentService** — Capture retries, payout retries. **Reuse capture retry logic**, adapt payout for new transfer model.

### Cron Jobs (config/cron/index.js)
- **Every 5s (withLock)** — `runOfferSweeper` (instantOfferService). **Adapt to handle new timeouts** (2 min provider accept, 5 min payment window, 3 min customer decision).
- **Every 1 min (withLock)** — `refreshPenaltyState` (penaltyService), `runInstantPaymentsCron` (instantPaymentService). ✅ Keep as-is.
- **Every 5 min (withLock)** — `runStatusTransitionCron` (bookingLifecycleService). Check what this does, likely old. **Refactor or remove.**
- **Hourly (withLock)** — `runApprovalExpiryCron`, `runHorizonChargeCron`, `runPaymentFixGraceCron` (all bookingLifecycleService). **Remove (no 4-day pre-auth in new flow).**

### Controllers & Routes
- **bookingController** — getSlots, createBooking, getUserBookings, etc. **Refactor** (new request flow, send-again, next-provider, accept/decline endpoints, capture flow).
- **Routes** — Check `/api/v1/app/bookings`. Will need **new endpoints** (send booking request, provider accept/decline, customer pay for awaiting_payment, customer cancel, fetch eligible providers for next-provider screen).

### Stripe Integration (backend/services/stripePayment.js)
- Check what's exposed: PaymentIntent creation, capture, refund, off-session handling.
- **Required for new flow:**
  - Off-session auto-auth (no 3DS on success, requires_action on 3DS).
  - Manual-capture PaymentIntent (automatic when saved card confirmed).
  - No destination charges, no application fee.
  - Refunds for cancellations.
  - Transfers (platform → provider, after capture).

### Missing/TODO
- **State machine** — Need CAS-style transition helpers for booking status changes (with concurrency guards).
- **Saved Card Management** — Card model exists; need to ensure "saved valid card required" gate.
- **Route Distance** — `routeDistanceHelper.js` exists; extend for 30 min driving duration check on Available Now.
- **AdminSettings new fields** — providerAcceptSec, paymentSec, customerDecisionSec, maxAttemptMinutes, scoring weights breakdown, timeoutStreakLimit, suspension duration.
- **Socket Emitters** — Offer closed, offer received, offer expired. Adapt for new flow. ✅ emitOfferReceived, emitOfferClosed exist.
- **Push Notifications** — Provider accept/decline reminders, customer payment fix prompts, no-show alerts.
- **Stripe Webhook Handlers** — No mention in codebase yet. Need for disputes (store only, no admin UI).

---

## Plan: Changes Only (No Implementation Yet)

### 1. **Models** (backend/models/)
- **Bookings.js**
  - Replace status enum with: `requested`, `awaiting_customer_decision`, `accepted_awaiting_payment`, `confirmed`, `ongoing`, `completed`, `canceled`.
  - Add `cancelReason` enum: `no_match`, `customer_timeout`, `payment_timeout`, `slot_taken`, `client`, `provider`, `no_show`, `system`.
  - Flatten or refactor old fields (remove `searchStartedAt`, `searchDeadline`, `instant.excluded`, `instant.matchSimilar`).
  - Rename `instant.offer.expiresAt` → `offerExpiresAt` (clearer at booking level).
  - Add `statusHistory` details (already there, reuse).
  - Add `attempt` (1-based attempt number for ranking).
  - Simplify `pricing` — keep servicePriceCents, depositCents, feeCents, chargeFeeCents, totalCents, heldCents.
  - Simplify `payout` — keep status (pending/paid/failed), attempts, grossCents, netCents, transferId, stripeFee.
  - Add `agreement` snapshot (text, version, agreedAt).
  - Add `providerTimeoutCount` (for streak penalty).
  
- **BookingOffer.js**
  - Replace status enum: `pending`, `accepted`, `declined`, `expired`, `closed`.
  - Add `respondedAt` (already there).
  - Remove unique index on (booking, business); allow resend after timeout/decline.

- **AdminSettings.js** (`instant` sub-doc)
  - Add: `providerAcceptSec` (120), `paymentSec` (300), `customerDecisionSec` (180), `maxAttemptMinutes` (900).
  - Add: scoring weights (travelTime, rating, acceptanceRate, similarity) as sub-doc.
  - Add: `timeoutStreakLimit` (3).
  - Rename `offerWindowSec` → `providerAcceptSec` (clearer).

### 2. **Services** (backend/app/services/)
- **instantOfferService.js**
  - Adapt `findRerouteCandidates()` for "next provider" eligibility (reachable in 30 min for Available Now, free seat).
  - Adapt `sendOffer()` for new status flow.
  - Adapt `transitionOffer()` to emit socket events per new flow.
  - **Remove:** automatic reroute loop, "match similar" logic.

- **paymentService.js**
  - **Remove:** old setup-intent logic, 4-day horizon vaulting.
  - Add `authorizeBookingPaymentOffSession()` — Stripe off-session auto-auth, manual-capture, no destination, no fee.
  - Add `captureBookingPayment()` — manual capture after confirmed or on completion.
  - Keep `refundBookingPayment()` (use for cancellations).

- **New: instantBookingFlowService.js**
  - `sendBookingRequest()` — slot + service → ONE provider, validate card, compute pricing, emit offer.
  - `acceptBookingOffer()` — provider accept, auto-auth, confirm or awaiting_payment.
  - `declineBookingOffer()` — provider decline, update matchStats, exclude from next attempt.
  - `providerTimeoutHandler()` — sweeper-driven, mark timeout, update streak.
  - `fetchEligibleProviders()` — filter + rank for next-provider screen.
  - `customerPaymentFix()` — retry auth after payment_timeout grace.
  - `cancelBooking()` — all scenarios, compute refund, release hold.

- **bookingLifecycleService.js** (refactor)
  - **Remove:** old crons (approval expiry, horizon charge, payment fix).
  - Add `sweepOfferTimeouts()` — every 5s, mark expired offers as expired, decline booking.
  - Add `sweepPaymentWindowTimeouts()` — every 5s, mark expired awaiting_payment as payment_timeout.
  - Add `sweepCustomerDecisionTimeouts()` — every 5s, mark expired awaiting_customer_decision as customer_timeout.
  - Add `sweepAttemptTimeouts()` — every 5s, mark booking as no_match if > 15 min or 3 providers tried.

- **instantPaymentService.js**
  - Adapt for new completion capture (not vaulted auth).
  - Keep retry logic.
  - Add transfer logic (no destination charges).

- **bookingService.js**
  - Reuse: `slotCapacity()`, `countAcceptedInSlot()`, `slotStartDate()`, `slotEndDate()`, slot validation.
  - **Remove:** old "manual approval" + "instant" branching; single flow.
  - **Remove:** `matchSimilar`, reroute repricing, automatic reroute.

### 3. **Controllers** (backend/app/controllers/)
- **bookingController.js**
  - `POST /api/v1/app/bookings/send-request` — send booking to ONE provider.
  - `POST /api/v1/app/bookings/:id/accept` — provider accept.
  - `POST /api/v1/app/bookings/:id/decline` — provider decline.
  - `POST /api/v1/app/bookings/:id/pay-for-authorization` — customer retry payment (awaiting_payment → confirmed).
  - `DELETE /api/v1/app/bookings/:id` — cancel (all statuses).
  - `GET /api/v1/app/bookings/next-providers` — fetch eligible for next-provider screen.
  - `POST /api/v1/app/bookings/:id/complete` — existing endpoint, adapt for new pricing/capture.
  - `POST /api/v1/app/bookings/:id/check-in` — existing, reuse.
  - Adapt `getSlots()` to take serviceId + date, return available (respecting concurrentClients).

### 4. **Cron Jobs** (backend/config/cron/)
- **index.js**
  - Every 5s (withLock) → `sweepOfferTimeouts` + `sweepPaymentWindowTimeouts` + `sweepCustomerDecisionTimeouts` + `sweepAttemptTimeouts`.
  - Keep penalty and instant-payments crons.
  - **Remove:** old approval/horizon/payment-fix crons.

### 5. **Socket Emitters** (backend/config/sockets/)
- Adapt emit signatures: bookingId, offerId, expiresAt, serverNow, status signal.
- Check existing `instantOfferSocketEmitter.js`.

### 6. **New Utility** (backend/helperUtils/)
- **bookingStateHelper.js** — CAS transition helper (atomically validate + update booking status + history).
- **bookingFeeHelper.js** — fee calc (min, max, floor, cap, deposit, promo).
- **cancellationRefundHelper.js** — refund logic per scenario.

### 7. **Tests**
- Create `backend/app/services/__tests__/instantBookingFlowService.test.js` — all scenarios.
- Stripe mock via jest.mock('stripe').
- Cover: fee calc, each timer, send-again-once, attempt caps, saved-card requirement, auto-auth success/failure/3DS, payment-window expiry, race (last seat), hold release, each cancel, penalty counting, completion capture, transfer.

### 8. **Env / Config**
- Add to `.env.example`: `ROUTE_WALKING_MAX_KM` (if not present).
- Check `STRIPE_*` vars (secret key, test mode).

### 9. **Indexes** (scripts/createIndexes.js)
- Add: `Booking: { status: 1, expiresAt: 1 }` (sweeper).
- Add: `BookingOffer: { booking: 1, status: 1, expiresAt: 1 }` (sweeper).

### 10. **Migrations**
- **Dev DB only, no migration script:** Drop old booking data, re-init schema.

---

## What to Reuse (No Changes)
- ProviderPenalty model + penaltyService (recordPenalty, consumeDeductions, restoreDeductions).
- Existing slot logic (capacity, day segments, concurrency).
- Distance calculation (haversineKm, routeDistanceHelper).
- User cache (authMiddleware already caches).
- Notification flow (sendUserNotifications).
- Review model (for completion check-in).
- BusinessProfile.matchStats (offers accepted/declined/expired).

---

## What to Remove
- Automatic reroute loop (instantOfferService).
- "Match similar pro" toggle + logic.
- Hold-at-request (only Confirmed hold slots).
- Reroute repricing.
- Slot-lock logic (not needed; concurrentClients alone suffices).
- Instant Payout (standard Stripe transfers only).
- Old "manual approval" booking type (single instant flow).
- Application fee (5%) and destination charges.
- Old crons: approval expiry, 4-day horizon charge, payment-fix grace.
- `offerWindowSec` (rename to `providerAcceptSec`).
- `searchStartedAt`, `searchDeadline`, `instant.matchSimilar`, `instant.excluded`.

---

## Known Integration Points (Stripe)
1. **Off-session auto-auth** — SavedPaymentMethod + manual-capture PI, no 3DS on success.
2. **Refunds** — Full refunds for cancellations (before capture), partial refunds post-completion.
3. **Transfers** — transfer_group + source_transaction, no destination, standard fee model.
4. **No application fee** — Remove 5% fee calculation.
5. **Webhooks** — Disputes (store only, no admin UI).
6. **Test mode** — Mocked in tests; real calls only in sandbox/prod.

---

## Open Questions (Before Implementation)
1. **Packages:** Feasible with instant flow? (Client says "tell me if feasible" — skipping for now, single-service only.)
2. **Socket auth gap:** Push notification channels for provider accept/decline reminders, payment-fix prompts — separate issue.
3. **Native app work:** Full-screen offer countdown, push sound — separate issue.
