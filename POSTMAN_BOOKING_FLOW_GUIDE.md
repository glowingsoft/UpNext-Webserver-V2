# Postman Collection Guide — Booking Flow v2

## Overview

The **UpNext.postman_collection.json** contains the Booking Flow v2 requests under **Up Next (Instant)**, alongside the existing API requests. The v2 requests include sample bodies and automated test scripts.

**Implementation status:** Request creation, provider acceptance, payment recovery and completion are enabled only in non-production with a Stripe test secret key. They return HTTP 503 otherwise. MongoDB transactions require a replica set or sharded deployment.

The flow is not production-ready: confirmed cancellation and no-show reporting are not integrated with the new statuses, and payout recovery needs further work. Promotions at booking creation and appointments more than seven days away are also not supported yet. A pending 3DS challenge must be completed before changing cards.

An existing database may still have the obsolete unique `booking_1_business_1` index on `bookingoffers`, which prevents sending a second offer to the same provider. Ensure the unique partial `one_pending_offer_per_booking` index exists, then have the database administrator remove only the obsolete index. `npm run db:indexes` creates the current indexes but does not remove old ones.

---

## Quick Start

### 1. Import Collection
- Open Postman
- Click **Import** → Select `postman_collection/UpNext.postman_collection.json`
- Set the collection's `url` variable to your API base URL, including `/api/v1/` (default: `http://127.0.0.1:5001/api/v1/`)

### 2. Set Collection Variables
All variables are pre-configured but you'll need to populate these:

| Variable | Source | Example |
|----------|--------|---------|
| `url` | Collection variable (set once) | `http://127.0.0.1:5001/api/v1/` |
| `userToken` | Customer login | JWT token |
| `businessToken` | Provider login | JWT token |
| `adminToken` | Login as admin (auto-set) | JWT token |
| `instantServiceId` | Search/list services | ObjectId |
| `instantProviderId` | Search/list providers | ObjectId |
| `instantBookingId` | Send request endpoint (auto-set) | ObjectId |
| `instantOfferId` | Send request endpoint (auto-set) | ObjectId |

---

## Endpoint Details & Examples

### Read Bookings
Customers can list their instant bookings with `GET /api/v1/app/instant/bookings`
using optional `page`, `limit`, `status`, `scope`, `date`, and `keyword` filters.
Customers and assigned providers can read one booking with
`GET /api/v1/app/instant/bookings/{{bookingId}}`.
The single-booking response includes `userInfo` (`_id`, `name`, `email`,
`profileIcon`) and `businessInfo` (`_id`, `user`, `businessName`, `image`,
`email`, and `location`), plus enriched target details, `canMessage`, and
`conversationId`. It includes the booking's review for the customer, and for
the provider only after admin approval. The legacy `customer` and `provider`
identity objects remain available for existing clients.
Customer responses omit payout data and
provider cancellation penalties, and hide `capture.stripeFeeCents` and
`capture.chargeId`; providers retain those fields. Customer phone numbers are
not included.

### Quote Booking
**Endpoint:** `GET /api/v1/app/instant/quote?scope=service&targetId={{instantServiceId}}`

Use this before creating the booking to show the customer the USD service price, deposit, booking fee, total amount due and cancellation policy. Set `scope=package` for a package quote. An optional `promotionId` applies an active, unexpired promotion for that provider and target to the booking fee only; exhausted or invalid promotions return an error. Amounts are integer cents and are shown before tax. A quote does not create an authorization.

**Example response data:**
```json
{
  "currency": "USD",
  "taxIncluded": false,
  "amountDueCents": 5700,
  "entity": {
    "id": "507f1f77bcf86cd799439011",
    "name": "Sample Service",
    "scope": "service"
  },
  "pricing": {
    "servicePriceCents": 5000,
    "depositCents": 750,
    "feeCents": 700,
    "promoDiscountCents": 0,
    "chargeFeeCents": 700,
    "totalCents": 5700
  },
  "cancellationPolicy": {
    "type": "non_refundable",
    "text": "After confirmation, the booking fee and deposit are non-refundable if you cancel."
  }
}
```

The deposit is part of the total authorization, not an additional amount on top of `amountDueCents`.

### Phase 1: Send Booking Request
**Endpoint:** `POST /api/v1/app/instant/bookings` (test mode only)

**What it does:** Customer sends booking to ONE provider. Card is required but not charged yet.

**Request Body:**
```json
{
  "scope": "service",
  "targetId": "507f1f77bcf86cd799439011",
  "date": "2026-11-15T10:00:00Z",
  "slot": {
    "open": "10:00",
    "close": "11:00",
    "isOvernight": false
  },
  "providerId": "507f1f77bcf86cd799439012",
  "stripePaymentMethodId": "pm_1234567890abcdef",
  "lat": 40.7128,
  "lng": -74.0060,
  "agreedNonRefundable": true,
  "agreementVersion": "instant-v1"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "offerId": "507f1f77bcf86cd799439014",
    "status": "requested",
    "expiresAt": "2026-11-10T16:47:43Z",
    "pricing": {
      "servicePriceCents": 5000,
      "feeCents": 700,
      "depositCents": 750,
      "totalCents": 5700
    }
  }
}
```

**Automatic:** `bookingId` and `offerId` saved to collection variables for next request.

---

### Provider offers

**Endpoint:** `GET /api/v1/app/instant/offers` (provider token)

Lists the authenticated provider's live offers by default. Use `page` and `limit` for pagination, `status=all` or `status=pending|accepted|declined|expired|closed` for filtering, and `keyword` to search the booking reference or original service/package name. `meta.statusCounts` contains counts for all statuses matching the keyword, regardless of the selected status; pending counts include only live offers. `GET /api/v1/app/instant/offers/current` still returns the earliest live offer or `null`.

Each offer includes `service: { _id, name, image }` for its original service or package and `business: { _id, businessName, image }` for the provider. Images are URLs; a package uses its cover image, and a service uses its first photo. Missing deleted-listing details can be `null`; historical offers never expose a later provider's listing.

The `/chat` socket events `offerReceived` and `offerClosed` include the offer `status`: `pending`, `accepted`, `declined`, `expired`, or `closed`, and the booking's `paymentStatus` at the time of the offer signal (or `null` if unavailable). A `closed` event can include `reason: "customer_canceled"` or `"attempt_expired"`. These events remain signals to refetch; `accepted` means the provider accepted the offer, not that payment is confirmed. For the customer's decline/expiry signal, `expiresAt` remains the customer decision deadline rather than the offer deadline.

Listen for `bookingPaymentUpdated` on `/chat` for the authorization result: `{ bookingId, offerId, bookingStatus, paymentStatus, serverNow }`. It is sent to the customer and provider when payment needs fixing (`requires_payment_fix`) or the booking is confirmed with an authorization (`authorized`). These are best-effort signals; refetch the booking after reconnecting.

### Phase 2: Provider Accept
**Endpoint:** `PATCH /api/v1/app/instant/offers/{{offerId}}/accept`

This route is available in test mode only. It authorizes after acceptance and confirms only if a seat remains. Stripe transport errors may return 500 while the background recovery continues.

**Request Body:** Empty `{}`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "status": "confirmed",
    "paymentStatus": "authorized",
    "expiresAt": null
  }
}
```

**OR if auth fails (200):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "status": "accepted_awaiting_payment",
    "paymentStatus": "requires_payment_fix",
    "awaitingPaymentDeadline": "2026-11-10T16:55:43Z"
  }
}
```

**Auto test:** Confirms status is either "confirmed" or "accepted_awaiting_payment".

---

### Phase 3: Provider Decline (Optional)
**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/decline`

**What it does:** Provider declines. Booking moves to awaiting_customer_decision (3 min window).
Alternatively, `PATCH /api/v1/app/instant/offers/{{instantOfferId}}/decline` declines that specific current offer.

The decline and offer-expiry paths require MongoDB transactions (a replica set or sharded deployment).

**Request Body:** Empty `{}`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "status": "awaiting_customer_decision",
    "awaitingDecisionDeadline": "2026-11-10T16:58:43Z"
  }
}
```

The customer may choose another provider or send again until the booking attempt expires.
There is no separate customer decision timeout. `customerDecisionSec` is retained for
settings compatibility but does not limit this choice. Advance-provider response time
continues to pause the attempt timer.

---

### Phase 4: Get Eligible Next Providers
**Endpoint:** `GET /api/v1/app/instant/bookings/{{bookingId}}/next-providers`

This endpoint returns eligible providers and their service/package alternatives; it currently does not support pagination. Listings match either the original service category and subcategory, or a provider sharing a profile category, tag, or skill with the first provider. Related providers may therefore offer listings in different categories; review the target before sending. All listings and providers must still pass availability, schedule, capacity and travel checks. New providers with no rating or offer history remain eligible. The endpoint requires `GOOGLE_MAPS_API_KEY` for travel durations and reports a server error if routing is unavailable.

**What it does:** Fetch ranked eligible providers (excluding current/declined ones) for the same attempt. The customer can choose until the attempt deadline; an expired offer is closed on demand if the expiry worker has not processed it yet.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "providers": [
      {
        "businessId": "507f1f77bcf86cd799439020",
        "businessName": "John's Salon",
        "targetId": "507f1f77bcf86cd799439022",
        "targetName": "Haircut",
        "scope": "service",
        "priceCents": 5000,
        "travelSeconds": 720,
        "rating": 4.8,
        "matchStats": { "offersReceived": 10, "offersAccepted": 8 },
        "penaltyWeight": 0,
        "similarity": 1,
        "score": 83.5,
        "alternatives": []
      }
    ],
    "deadline": "2026-11-10T16:58:43Z",
    "serverNow": "2026-11-10T16:56:00Z"
  }
}
```

**Auto:** `nextProviderId` saved from first provider.

---

### Phase 5: Customer Send Again (Same Provider)
**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/send-again`

Resends to the most recently declined or timed-out provider, once per attempt. Quote the current target first, then confirm the current total and agreement:

**Request Body:**
```json
{
  "expectedTotalCents": 5700,
  "agreedNonRefundable": true,
  "agreementVersion": "instant-v1"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "offerId": "507f1f77bcf86cd799439025",
    "expiresAt": "2026-11-10T16:49:43Z",
    "status": "requested"
  }
}
```

An exhausted resend returns HTTP 409.

---

### Phase 6: Customer Send to Next Provider
**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/send-next`

Select a provider and target from the ranked list, quote that target and confirm its total and agreement. This sends a new offer within the existing attempt; it does not reset the attempt deadline.
The current request-validation groundwork rejects promotions; promotional checkout is not yet available for these routes.

**Request Body:**
```json
{
  "providerId": "507f1f77bcf86cd799439020",
  "scope": "service",
  "targetId": "507f1f77bcf86cd799439022",
  "expectedTotalCents": 5700,
  "agreedNonRefundable": true,
  "agreementVersion": "instant-v1"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "offerId": "507f1f77bcf86cd799439026",
    "expiresAt": "2026-11-10T16:49:43Z",
    "status": "requested"
  }
}
```

---

### Phase 7: Customer Fix Card (Payment Failed)
**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/fix-payment` (test mode only)

**When:** Only during "accepted_awaiting_payment" status, before deadline.

**Request Body (optional - omit to retrieve the current 3DS client secret or recheck payment):**
```json
{
  "stripePaymentMethodId": "pm_9876543210fedcba"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "status": "confirmed",
    "paymentStatus": "authorized"
  }
}
```

If the response remains `accepted_awaiting_payment` and contains `clientSecret`, complete the Stripe authentication in the client and call this endpoint again without a payment method. A new card cannot replace an active authentication challenge yet.

**Error (409 - expired or unavailable window):**
```json
{
  "success": false,
  "message": "This booking is no longer available."
}
```

---

### Phase 8: Customer Check-In and Manual Start

The customer or assigned provider calls `POST /api/v1/app/instant/bookings/{{bookingId}}/customer-arrived` for a confirmed or ongoing booking. The body can be `{}` or contain numeric `lat` and `lng` together; coordinates are recorded but proximity is not verified. The response includes `customerArrived` with `at`, `by` (`user` or `business`), and any coordinates. Check-in can only be recorded once.

After the customer checks in, the assigned provider calls `PATCH /api/v1/app/instant/bookings/{{bookingId}}/start` with an empty body. This changes `confirmed` to `ongoing` and records the provider in status history. There is no automatic start or appointment-time restriction. A missing check-in, another provider, or a booking that is not confirmed returns 409. An ongoing booking continues to occupy its slot.

---

### Phase 9: Complete Booking (Provider)
After customer arrival and provider start, the assigned provider calls `PATCH /api/v1/app/instant/bookings/{{bookingId}}/complete`. The body can be `{}`, or contain both `lat` and `lng`. Only an `ongoing` booking with recorded customer arrival and an authorized payment can complete.

Completion schedules capture atomically with the status change. The response includes the booking's `paymentStatus`: `captured`, `capture_retrying`, or `payment_due`. Failed or interrupted captures are retried against the original authorization; no replacement charge is made automatically. While recovery is pending, the separate debt-settlement endpoint returns 409 to prevent a duplicate charge. Contact support if the original authorization cannot be captured. Provider payout is attempted after capture, but payout recovery after an interrupted transfer is not yet fully automated; this flow is for test mode only.

---

### Phase 10: Cancel Booking
**Quote:** `GET /api/v1/app/instant/bookings/{{bookingId}}/quote/cancel`

Either booking party can preview cancellation. Before acceptance, the customer quote is zero and a provider can decline the pending offer without a fee. After acceptance, customer quotes capture only the 15% deposit when it is non-refundable; with the `refundable_24h` policy, the deposit is refundable when canceled at least 24 hours before the appointment. Otherwise the deposit is captured and the rest of the authorization is released. The booking fee is never included in a cancellation charge. Provider quotes include the next cancellation number, any $7 next-payout deduction, the ranking reduction, and whether a temporary suspension applies. Quotes are read-only and cancellation rechecks the booking state. A booking belonging to another account returns 404.

**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/cancel`

**Customer endpoint:** Both `POST` and `PATCH` cancel a `requested`, `awaiting_customer_decision`, `accepted_awaiting_payment`, `confirmed`, or `ongoing` booking.

**Provider endpoint:** `PATCH /api/v1/app/instant/bookings/{{bookingId}}/provider-cancel` cancels an accepted, confirmed, or ongoing booking. Before acceptance, providers decline using `POST /api/v1/app/instant/bookings/{{bookingId}}/decline`.

Provider cancellation #1 records and sends a warning. Cancellation #2 and each subsequent cancellation record a $7 deduction against a future payout and apply the ranking reduction; cancellation #3 and later also temporarily suspend provider availability. Customer cancellations retain only the deposit outside the refundable window for the platform; it is not paid to the provider. Capture retries plus authorization-release retries are persisted for recovery. No booking fee or Stripe fee is added to the customer's cancellation charge.

**Request Body:** Empty.
```json
{}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "status": "canceled",
    "cancelReason": "client",
    "chargeCents": 1500,
    "refundableDepositCents": 0
  }
}
```

---

### Phase 11: Report No-Show
**Planned endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/no-show`

**When:** Customer within 1 hour of slot start.

**Request Body:**
```json
{
  "reportedBy": "client"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "noShow": {
      "status": "reported",
      "reportedAt": "2026-11-15T10:15:00Z",
      "reportedBy": "client"
    }
  }
}
```

---

### Phase 12: Contest No-Show
**Endpoint:** `POST /api/v1/app/instant/bookings/{{bookingId}}/no-show/contest`

The provider can contest a recorded report within the configured contest window (24 hours by default). The response includes the stored Arrived check-in when present; client-supplied check-in times are not accepted as evidence. Reporting itself is not yet implemented for the new flow.

**Request Body:**
```json
{
  "note": "I did arrive at the specified location and waited for 15 minutes"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439013",
    "noShow": {
      "status": "contested",
      "contestedAt": "2026-11-15T10:20:00Z",
      "contestNote": "I did arrive..."
    }
  }
}
```

---

## Admin Settings Endpoints

### Get Instant Booking Config
**Endpoint:** `GET /api/v1/admin/instant/settings`

**Response:**
```json
{
  "success": true,
  "data": {
    "providerAcceptSec": 120,
    "providerAcceptSecAdvance": 1800,
    "paymentSec": 300,
    "customerDecisionSec": 180,
    "maxAttemptMinutes": 15,
    "maxAdvanceDays": 7,
    "feeFloorCents": 700,
    "feeRatePercent": 8,
    "feeCapCents": 2000,
    "minInstantPriceCents": 2500,
    "depositPercent": 15,
    "maxProviders": 3,
    "radiusKm": 25,
    "scoringWeights": {
      "travelTime": 100,
      "rating": 50,
      "acceptanceRate": 30,
      "similarity": 20
    },
    "penaltyDeductionCents": 700,
    "penaltyWindowDays": 30,
    "timeoutStreakLimit": 3,
    "suspensionHours": 24,
    "noShowReportWindowMin": 60,
    "noShowContestWindowHours": 24
  }
}
```

### Update Settings
**Endpoint:** `PUT /api/v1/admin/instant/settings`

**Request:** Full settings object (see above). Only changed fields need to be provided.

---

## Pricing Calculation Reference

**Formula:** `fee = min(cap, max(floor, rate x price))`

**Defaults:**
- Floor: $7 (700 cents)
- Rate: 8%
- Cap: $20 (2000 cents)
- Min price: $25 (2500 cents)
- Deposit: 15% of service price

### Examples

| Service Price | Fee | Deposit | Total Charge | Held |
|---|---|---|---|---|
| $25 | $7 | $3.75 | $32 | $32.00 |
| $50 | $7 | $7.50 | $57 | $57.00 |
| $100 | $8 | $15 | $108 | $108.00 |
| $250 | $20 | $37.50 | $270 | $270.00 |
| $500 | $20 | $75 | $520 | $520.00 |

---

## Booking Status Flow

```
REQUEST SENT
↓
1. REQUESTED (2-30 min provider accept window)
   ├─ Provider ACCEPTS → Auto-auth triggered
   │  ├─ Success → CONFIRMED (ready for service)
   │  └─ Fails (3DS/decline) → ACCEPTED_AWAITING_PAYMENT (5 min to fix card)
   │     ├─ Customer fixes card → CONFIRMED
   │     └─ Deadline passes → CANCELED (payment_timeout)
   └─ Provider DECLINES/TIMES OUT → AWAITING_CUSTOMER_DECISION (3 min to choose)
      ├─ Customer sends to next provider → REQUESTED (reset timer, same attempt)
      ├─ Customer resends to same provider (max 2×) → REQUESTED (reset timer)
      ├─ All 3 providers tried/timed out → CANCELED (no_match)
      └─ Deadline passes (no choice) → CANCELED (customer_timeout)

2. CONFIRMED
   ├─ Service starts → ONGOING
   │  └─ Service complete → COMPLETED
   │     ├─ Capture succeeds → Transfer initiated (provider paid after capture)
   │     └─ Capture fails → COMPLETED (paymentStatus: payment_due, retry pending)
   └─ Customer cancels (advance) → CANCELED (client) [refund per policy]
   └─ Provider cancels → CANCELED (provider) [full refund]

3. COMPLETED
   └─ No-show report (within 1h) → noShow.status: reported
      ├─ Provider contests (within 24h, with Arrived check-in) → noShow.status: contested
      └─ Admin resolves → noShow.status: upheld | overturned

TERMINAL STATES: CANCELED, COMPLETED
```

---

## Test Execution Order

**Happy Path (Full Flow):**
1. Send Booking Request (status: requested)
2. Provider Accept → Auto-auth succeeds (status: confirmed)
3. Customer Check-In (customer or provider)
4. Provider Start (status: ongoing)
5. Get Booking Details (verify status; completion is not yet supported)

**Payment Failure Path:**
1. Send Booking Request
2. Provider Accept → Auto-auth fails (status: accepted_awaiting_payment)
3. Customer Fix Card → Retry auth (status: confirmed)
4. Complete Booking (status: completed)

**Decline & Reroute Path:**
1. Send Booking Request → Provider A
2. Provider A Decline (status: awaiting_customer_decision)
3. Get Next Providers (fetch eligible list)
4. Send to Next Provider (Provider B)
5. Provider B Accept → Confirmed

---

## Common Errors

| Error | Status | Cause | Fix |
|-------|--------|-------|-----|
| `no_saved_card` | 400 | Card required | Add valid payment method first |
| `invalid_slot` | 422 | Slot not available | Check available slots |
| `max_resend_attempts` | 422 | Sent 2× already | Use next provider instead |
| `payment_window_expired` | 422 | >5 min since auth failed | Booking auto-canceled |
| `booking_offer_unavailable` | 409 | Attempt expired or booking is no longer in the decision state | Booking cannot be rerouted |
| `slot_taken` | 422 | Race condition | Another booking took last seat |
| `provider_suspended` | 422 | Too many timeouts/penalties | Provider temporarily unavailable |

---

## Debugging Tips

1. **Check timestamps:** All expiresAt/deadline fields show when status expires. Use `serverNow` from responses to track client/server drift.

2. **Enable test scripts:** Click "Tests" tab on each endpoint. Postman auto-runs them and sets variables.

3. **Trace offer lifecycle:** BookingOffer.status progresses: pending → accepted/declined/expired → closed.

4. **Monitor Stripe:** Every booking.paymentStatus transition reflects Stripe PaymentIntent state (authorized → captured → etc.).

5. **Verify indexes:** If sweeper queries slow, run `npm run db:indexes` to ensure all booking indexes exist.

---

## Environment Variables Setup

Create a Postman **Environment** with these values:

```json
{
  "name": "Up Next Dev",
  "values": [
    {
      "key": "url",
      "value": "http://localhost:8080/",
      "enabled": true
    },
    {
      "key": "userEmail",
      "value": "customer@example.com",
      "enabled": true
    },
    {
      "key": "userPassword",
      "value": "TestPass123!",
      "enabled": true
    },
    {
      "key": "providerEmail",
      "value": "provider@example.com",
      "enabled": true
    },
    {
      "key": "providerPassword",
      "value": "TestPass123!",
      "enabled": true
    }
  ]
}
```

Then login first to populate token variables automatically.
