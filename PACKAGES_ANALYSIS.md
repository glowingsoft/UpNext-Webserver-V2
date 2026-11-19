# Packages vs Services Analysis — Include or Defer?

## Differences Between Services & Packages

| Aspect | Services | Packages |
|--------|----------|----------|
| **Model** | Service.js | Packages.js |
| **Services field** | N/A (is a service) | Includes array of Service IDs (composite) |
| **Slots** | daySlotsSchema (bookable intervals) | daySlotsSchema (same) |
| **concurrentClients** | Yes, per service | Yes, per package |
| **Price** | Single price | Single price (not sum of services) |
| **Cancellation policy** | cancellationPolicy enum | howLateCanCancel + refundPercentage (to be removed) |
| **Min price check** | $25 minInstantPriceCents | Same check applies |
| **Booking entity** | Booking.scope = "service" | Booking.scope = "package" |
| **Eligibility** | isAvailable, status, category, price | isAvailable, status, category, price |
| **Next-provider logic** | Service-to-service comparison | Package-to-package comparison |
| **Session duration** | sessionSlotMins | sessionSlotMins (derived or explicit) |

## Changes Required for Packages (in this instant flow)

1. **Remove refund fields** from Packages.js (same as Services.js):
   - howLateCanBook, howLateCanCancel, refundPercentage, refundRules

2. **Add cancellationPolicy** to Packages.js:
   - enum: ["non_refundable", "refundable_24h"]
   - default: "non_refundable"

3. **Services included in package** — No changes needed:
   - Package.services[] just identifies which services are bundled
   - Booking only references the Package ID, not individual services
   - Cancellation policy applies to the package, not per-service

4. **Eligibility & ranking**:
   - Filter packages same as services (isAvailable, status, price, category, free slot)
   - Rank packages by same weights (distance, rating, acceptance rate, similarity)
   - No additional complexity

## Scope of Work

### Minimal additions (2 files):
1. **Packages.js** — Remove refund fields, add cancellationPolicy
2. **scripts/createIndexes.js** — No changes (indexes are booking-level only)

### No changes needed:
- Pricing logic (applies to package price as-is)
- Hold/capture/payout logic (same as services)
- Sweeper logic (booking status agnostic)
- Eligibility filters (same predicates)
- Ranking (same weights)

## Decision: INCLUDE PACKAGES ✅

**Rationale**: Only 1 file change (2 lines in Packages.js), zero risk, same state machine entirely.

**Files touched**:
- Services.js (remove refund fields, add cancellationPolicy)
- Packages.js (remove refund fields, add cancellationPolicy)
- Bookings.js (status/flow/timeouts)
- BookingOffer.js (status/sendCount)
- AdminSettings.js (timers/weights)
- BusinessProfile.js (remove liveOffer)
- scripts/createIndexes.js (add indexes)

**Total Phase 1 edits: 7 files**
