# Add Card Error Fix - Documentation

## Problem

When attempting to add a card to a user's account, the system was throwing an error:

```
attachPaymentMethod error: The customer does not have a payment method with the ID pm_1Ucl1GC2ztAziqAhNEtUcVcQ. 
The payment method must be attached to the customer.
Error: Failed to attach payment method: T
```

## Root Cause

The error "The customer does not have a payment method with the ID pm_xxx" indicates that the payment method ID passed to the `attachPaymentMethod` function does not exist in Stripe, or is invalid. This can happen due to:

1. **Invalid Payment Method ID**: The client-side Stripe.js library failed to properly create a payment method
2. **Non-existent ID**: A payment method ID that doesn't exist in the Stripe account
3. **Mode Mismatch**: Test mode ID being used in a live Stripe key (or vice versa)
4. **Expired/Stale ID**: A payment method ID that is no longer valid

## Solution Implemented

### 1. Enhanced Error Handling in `stripeAccount.js`

Added specific error handling in the `attachPaymentMethod` function to detect when a payment method doesn't exist:

```javascript
// Handle invalid/non-existent payment method IDs
if (err.type === "StripeInvalidRequestError" && /No such payment_method/i.test(err.message)) {
  const invalidError = new Error("Payment method not found. Please create a new payment method and try again.");
  invalidError.code = "payment_method_invalid";
  throw invalidError;
}
```

### 2. Updated Controller Error Handling in `cardController.js`

Added handling for the new error code in the `addCard` controller:

```javascript
if (error.code === "payment_method_invalid") {
  return sendResponse({ res, statusCode: 400, translationKey: "payment_method_invalid", error });
}
```

This returns a **400 Bad Request** status (client error) instead of a **500 Internal Server Error**, indicating that the client needs to fix the request.

### 3. Improved Logging in `cardService.js`

Enhanced the logging in the `addCard` service to provide better debugging information:

- Logs the customer ID when retrieved
- Logs the payment method ID and customer ID before attachment attempt
- Logs the payment method ID after successful attachment
- Wrapped entire function in try-catch with error logging

### 4. Added Translation Key

Added a new user-friendly error message to `en.json`:

```json
"payment_method_invalid": "The payment method is invalid or no longer exists. Please create a new payment method and try again."
```

## Files Modified

1. **backend/services/stripeAccount.js** - Enhanced error handling in `attachPaymentMethod` function
2. **backend/app/controllers/cardController.js** - Added handling for new `payment_method_invalid` error code
3. **backend/app/services/cardService.js** - Improved logging and error handling in `addCard` function
4. **backend/assets/locales/en.json** - Added `payment_method_invalid` translation key

## How It Works Now

### Success Flow
1. Client creates a payment method using Stripe.js (createPaymentMethod)
2. Client sends valid `paymentMethodId` to `/api/v1/card` endpoint
3. Server retrieves or creates Stripe customer
4. Server attaches payment method to customer ✓
5. Server stores card details locally
6. Response: `201 Created` with card data

### Error Flow (Invalid Payment Method)
1. Client sends invalid/non-existent `paymentMethodId`
2. Server tries to attach payment method
3. Stripe returns: "No such payment_method" error
4. Server catches error and sets `error.code = "payment_method_invalid"`
5. Controller returns `400 Bad Request` with user-friendly message
6. Client receives: "The payment method is invalid or no longer exists. Please create a new payment method and try again."

## Testing Recommendations

### Test Case 1: Valid Payment Method
```bash
POST /api/v1/card
{
  "paymentMethodId": "pm_valid_id_from_stripe",
  "cardHolderName": "John Doe",
  "setDefault": true
}
```

Expected Response: `201 Created` ✓

### Test Case 2: Invalid Payment Method ID
```bash
POST /api/v1/card
{
  "paymentMethodId": "pm_invalid_or_nonexistent",
  "cardHolderName": "John Doe",
  "setDefault": false
}
```

Expected Response: `400 Bad Request`
```json
{
  "error": "The payment method is invalid or no longer exists. Please create a new payment method and try again.",
  "message": "payment_method_invalid"
}
```

### Test Case 3: Reused/Detached Payment Method
```bash
POST /api/v1/card
{
  "paymentMethodId": "pm_previously_detached",
  "cardHolderName": "Jane Doe",
  "setDefault": false
}
```

Expected Response: `400 Bad Request`
```json
{
  "error": "This card entry has expired and can't be used again. Please re-enter your card number to add it.",
  "message": "payment_method_reused"
}
```

## Debugging Tips

If users still encounter issues with adding cards:

1. **Check Stripe Dashboard**: Verify the payment method exists in your Stripe account
2. **Verify API Keys**: Ensure test/live mode matches between client and server
3. **Check Logs**: Look for `Customer retrieved:`, `Attaching payment method:`, and `Payment method attached:` logs
4. **Verify Client-Side**: Ensure Stripe.js properly creates payment methods before sending IDs
5. **Clear Cache**: The user cache may have stale data - logs show when cache is cleared

## Related Error Codes

| Error Code | HTTP Status | Message | Action |
|---|---|---|---|
| `payment_method_invalid` | 400 | Invalid/non-existent payment method | Create new payment method |
| `payment_method_reused` | 400 | Payment method was previously used/detached | Create new payment method |
| `card_add_error` | 500 | Unknown error adding card | Check server logs |
| `card_not_found` | 404 | Card doesn't exist in database | Use valid card ID |

## Notes

- This fix maintains backward compatibility with existing error handling
- The 400 status code for `payment_method_invalid` follows REST conventions for client errors
- Error messages are user-friendly and actionable
- Logging has been improved for debugging production issues
- All existing functionality remains unchanged
