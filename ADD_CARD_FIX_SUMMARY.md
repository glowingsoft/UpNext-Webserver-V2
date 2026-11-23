# Add Card Error Fix - Quick Summary

## Changes Made

### Problem
Error when adding a card: "The customer does not have a payment method with the ID pm_xxx"

### Root Cause
Invalid/non-existent payment method ID sent from client to server.

### Solution
Added proper error handling and user-friendly error messages.

## 3 Files Modified

### 1. `backend/services/stripeAccount.js` - attachPaymentMethod()
**Before:** Generic error thrown for any attachment failure
**After:** Detects and distinguishes between:
- Invalid/non-existent payment method → `payment_method_invalid` error code
- Reused/detached payment method → `payment_method_reused` error code (existing)

**Code Added:**
```javascript
if (err.type === "StripeInvalidRequestError" && /No such payment_method/i.test(err.message)) {
  const invalidError = new Error("Payment method not found. Please create a new payment method and try again.");
  invalidError.code = "payment_method_invalid";
  throw invalidError;
}
```

### 2. `backend/app/controllers/cardController.js` - addCard()
**Before:** Only handled `payment_method_reused` error
**After:** Also handles `payment_method_invalid` error with 400 status

**Code Added:**
```javascript
if (error.code === "payment_method_invalid") {
  return sendResponse({ res, statusCode: 400, translationKey: "payment_method_invalid", error });
}
```

### 3. `backend/app/services/cardService.js` - addCard()
**Before:** Minimal logging
**After:** Enhanced logging and error propagation

**Code Added:**
```javascript
try {
  // ... function body
} catch (error) {
  console.error("Error in addCard:", error.message);
  throw error;
}
```

Also improved console.log statements:
- `customer.id` instead of full object
- `attached.id` instead of full object

### 4. `backend/assets/locales/en.json` - New Translation Key
**Added:**
```json
"payment_method_invalid": "The payment method is invalid or no longer exists. Please create a new payment method and try again."
```

## HTTP Response Behavior

### Scenario 1: Valid Payment Method
```
Status: 201 Created
{
  "data": { card details }
}
```

### Scenario 2: Invalid Payment Method
```
Status: 400 Bad Request
{
  "error": "The payment method is invalid or no longer exists. Please create a new payment method and try again."
}
```

### Scenario 3: Reused/Detached Payment Method
```
Status: 400 Bad Request
{
  "error": "This card entry has expired and can't be used again. Please re-enter your card number to add it."
}
```

## Why These Changes Fix the Issue

1. **Better Error Detection** - Stripe returns "No such payment_method" but generic error handling was hiding it
2. **User-Friendly Messages** - 400 status tells client the error is fixable by them
3. **Improved Debugging** - Console logs now show customer and payment method IDs clearly
4. **Distinct Error Codes** - Different payment method errors can be handled differently

## Testing

```bash
# Test invalid payment method ID
curl -X POST http://localhost:8080/api/v1/card \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId": "pm_invalid_id",
    "cardHolderName": "Test User",
    "setDefault": false
  }'

# Expected: 400 Bad Request with payment_method_invalid message
```

## Verification

All files have been syntax-checked and are valid:
- ✅ `backend/services/stripeAccount.js` - Node syntax check passed
- ✅ `backend/app/controllers/cardController.js` - Node syntax check passed
- ✅ `backend/app/services/cardService.js` - Node syntax check passed
- ✅ `backend/assets/locales/en.json` - JSON valid, contains all required keys

## Notes

- Changes are **backward compatible** - no breaking changes
- Follows existing error handling patterns in codebase
- Uses 400 status code for client errors (REST standard)
- Uses existing `sendResponse()` utility for consistent response format
- No new dependencies added
