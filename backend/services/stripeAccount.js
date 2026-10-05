// services/stripeAccount.service.js
const stripe = require("../config/stripe");
const { User } = require("@models/UserModel");
const { userCache } = require("@config/nodeCache");

// Strip any trailing slash so concatenation below never produces a double slash
const WEB_BASE_URL = (process.env.WEB_BASE_URL || "").replace(/\/+$/, ""); // e.g. https://yourapp.com

/**
 * Create a Stripe Connect Express account for a user.
 * Returns the created account object.
 */
async function createConnectAccount(user) {
  try {
    const account = await stripe.accounts.create({
      type: "express",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "individual", // or 'company'
      metadata: { userId: String(user._id) },
      // Manual payouts — the business triggers withdrawals from the app
      // instead of Stripe's default rolling automatic payout schedule.
      settings: { payouts: { schedule: { interval: "manual" } } },
    });

    return account;
  } catch (err) {
    console.error("createConnectAccount error:", err.message);
    throw new Error(`Failed to create Stripe account: ${err.message}`);
  }
}

/**
 * Accounts created before the manual-payout setting existed still have
 * Stripe's default automatic schedule — flip them to manual on demand,
 * right before the first app-triggered withdrawal.
 */
async function ensureManualPayoutSchedule(accountId) {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    if (account.settings?.payouts?.schedule?.interval === "manual") return;
    await stripe.accounts.update(accountId, {
      settings: { payouts: { schedule: { interval: "manual" } } },
    });
  } catch (err) {
    console.error("ensureManualPayoutSchedule error:", err.message);
    throw new Error(`Failed to set manual payout schedule: ${err.message}`);
  }
}

/**
 * Reusable: generate an onboarding (account) link for a given accountId.
 * Used both for first-time onboarding and for resuming incomplete onboarding.
 */
async function generateOnboardingLink(accountId, deviceType) {
  try {
    // Same convention as login's deviceType (android/ios/web) — carried through
    // so the return/refresh routes know whether to redirect into the app or
    // to the web dashboard. Falls back to "web" for anything unrecognized,
    // since that's the redirect target that always works.
    const platform = ["android", "ios", "web"].includes(deviceType) ? deviceType : "web";
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${WEB_BASE_URL}/api/v1/stripe/onboarding/refresh?accountId=${accountId}&deviceType=${platform}`,
      return_url: `${WEB_BASE_URL}/api/v1/stripe/onboarding/return?accountId=${accountId}&deviceType=${platform}`,
      type: "account_onboarding",
    });

    return accountLink.url;
  } catch (err) {
    console.error("generateOnboardingLink error:", err.message);
    throw new Error(`Failed to create onboarding link: ${err.message}`);
  }
}

/**
 * Retrieve a Stripe account and return a normalized status object.
 */
async function getAccountStatus(accountId) {
  try {
    // Opt-in bypass for quick local testing (skips the real onboarding flow)
    if (process.env.STRIPE_ONBOARDING_BYPASS === "true") {
      return {
        accountId,
        chargesEnabled: true,
        payoutsEnabled: true,
        onboardingComplete: true,
        isReady: true,
        raw: { id: accountId },
      };
    }
    const stripeAccount = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = stripeAccount.charges_enabled === true;
    const payoutsEnabled = stripeAccount.payouts_enabled === true;
    const onboardingComplete = stripeAccount.details_submitted === true;

    return {
      accountId,
      chargesEnabled,
      payoutsEnabled,
      onboardingComplete,
      // fully usable only when all three are true
      isReady: chargesEnabled && payoutsEnabled && onboardingComplete,
      raw: stripeAccount,
    };
  } catch (err) {
    console.error("getAccountStatus error:", err.message);
    throw new Error(`Failed to retrieve account status: ${err.message}`);
  }
}

/**
 * High-level helper: check a user's onboarding status.
 * If they have no account, creates one. If incomplete, returns a fresh link.
 */
async function checkOnboardingStatus(user, deviceType) {
  try {
    let accountId = user?.stripe?.accountId;

    // No account yet -> create one
    if (!accountId) {
      const account = await createConnectAccount(user);
      accountId = account.id;
      await User.findByIdAndUpdate(user._id, { "stripe.accountId": accountId });
    }

    let status;
    try {
      status = await getAccountStatus(accountId);
    } catch (err) {
      // Stale account id (e.g. a test-mode acct_ left in the DB after switching
      // to live keys) — start over with a fresh account instead of erroring
      if (!String(err.message).includes("does not have access to account")) throw err;
      const account = await createConnectAccount(user);
      accountId = account.id;
      await User.findByIdAndUpdate(user._id, { "stripe.accountId": accountId });
      status = await getAccountStatus(accountId);
    }

    // Sync flags both ways so an account that loses capabilities also loses
    // access, and bust the auth cache so the change is visible immediately
    const flagsChanged =
      user?.stripe?.chargesEnabled !== status.chargesEnabled ||
      user?.stripe?.payoutsEnabled !== status.payoutsEnabled ||
      user?.stripe?.onboardingComplete !== status.isReady ||
      user?.stripe?.accountId !== accountId;
    if (flagsChanged) {
      await User.findByIdAndUpdate(user._id, {
        "stripe.chargesEnabled": status.chargesEnabled,
        "stripe.payoutsEnabled": status.payoutsEnabled,
        "stripe.onboardingComplete": status.isReady,
      });
      userCache.del(String(user._id));
    }

    return {
      accountId,
      onboardingComplete: status.isReady,
      chargesEnabled: status.chargesEnabled,
      payoutsEnabled: status.payoutsEnabled,
      onboardingUrl: status.isReady ? null : await generateOnboardingLink(accountId, deviceType),
    };
  } catch (err) {
    console.error("checkOnboardingStatus error:", err.message);
    throw new Error(`Failed to check onboarding status: ${err.message}`);
  }
}

/**
 * Re-check and persist onboarding status keyed by accountId rather than a
 * loaded user doc — used by the onboarding return redirect, which only has
 * the accountId Stripe echoed back on the query string.
 */
async function syncOnboardingStatusByAccountId(accountId) {
  const status = await getAccountStatus(accountId);
  const user = await User.findOne({ "stripe.accountId": accountId });
  if (user) {
    const flagsChanged =
      user.stripe?.chargesEnabled !== status.chargesEnabled ||
      user.stripe?.payoutsEnabled !== status.payoutsEnabled ||
      user.stripe?.onboardingComplete !== status.isReady;
    if (flagsChanged) {
      await User.findByIdAndUpdate(user._id, {
        "stripe.chargesEnabled": status.chargesEnabled,
        "stripe.payoutsEnabled": status.payoutsEnabled,
        "stripe.onboardingComplete": status.isReady,
      });
      userCache.del(String(user._id));
    }
  }
  return status;
}

/**
 * Live balance of a connected account, in major units (dollars).
 * available = releasable to the business's bank now; pending = captured funds
 * still inside Stripe's rolling payout window (e.g. the ~7-day first-payout hold).
 */
async function getConnectBalance(accountId) {
  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: accountId });
    const sum = (buckets) => (buckets || []).reduce((total, b) => total + b.amount, 0) / 100;
    return {
      available: sum(balance.available),
      pending: sum(balance.pending),
      currency: balance.available?.[0]?.currency || balance.pending?.[0]?.currency || "usd",
    };
  } catch (err) {
    console.error("getConnectBalance error:", err.message);
    throw new Error(`Failed to retrieve connected account balance: ${err.message}`);
  }
}

async function getOrCreateCustomer(user) {
  try {
    // 1. Already have an id on record -> trust but verify
    if (user?.stripe?.customerId) {
      try {
        const existing = await stripe.customers.retrieve(user.stripe.customerId);
        // retrieve returns a deleted stub if the customer was removed
        if (existing && !existing.deleted) {
          return existing;
        }
      } catch (err) {
        // id is stale/invalid -> fall through and recreate
        console.warn(`Stored stripeCustomerId ${user?.stripe?.customerId} invalid, recreating: ${err.message}`);
      }
    }

    // 2. No valid id -> search Stripe by email
    if (user?.email) {
      const search = await stripe.customers.list({
        email: user.email,
        limit: 1,
      });
      if (search.data.length > 0) {
        return search.data[0];
      }
    }

    // 3. Nothing found -> create a new customer
    const customer = await stripe.customers.create({
      email: user?.email,
      name: user?.name || undefined,
      metadata: { userId: String(user?.id) },
    });

    return customer;
  } catch (err) {
    console.error("getOrCreateCustomer error:", err.message);
    throw new Error(`Failed to get or create customer: ${err.message}`);
  }
}

async function attachPaymentMethod(customerId, paymentMethodId, setAsDefault = false) {
  try {
    const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    if (setAsDefault) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    return paymentMethod;
  } catch (err) {
    console.error("attachPaymentMethod error:", err.message);
    // Stripe permanently locks a PaymentMethod once it's been used unattached
    // or detached from a Customer — re-attaching it is never possible, so
    // surface this as a distinct, client-fixable error rather than a 500.
    if (err.type === "StripeInvalidRequestError" && /previously used|detached from a Customer/i.test(err.message)) {
      const reuseError = new Error(err.message);
      reuseError.code = "payment_method_reused";
      throw reuseError;
    }
    throw new Error(`Failed to attach payment method: ${err.message}`);
  }
}

/**
 * Detach a payment method from whatever customer it's attached to.
 */
async function detachPaymentMethod(paymentMethodId) {
  try {
    const paymentMethod = await stripe.paymentMethods.detach(paymentMethodId);
    return paymentMethod;
  } catch (err) {
    console.error("detachPaymentMethod error:", err.message);
    throw new Error(`Failed to detach payment method: ${err.message}`);
  }
}

/**
 * List a customer's payment methods (cards by default).
 */
async function listPaymentMethods(customerId, type = "card") {
  try {
    const result = await stripe.paymentMethods.list({
      customer: customerId,
      type,
    });
    return result.data;
  } catch (err) {
    console.error("listPaymentMethods error:", err.message);
    throw new Error(`Failed to list payment methods: ${err.message}`);
  }
}

/**
 * Set an already-attached payment method as the customer's default.
 */
async function setDefaultPaymentMethod(customerId, paymentMethodId) {
  try {
    const customer = await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    return customer;
  } catch (err) {
    console.error("setDefaultPaymentMethod error:", err.message);
    throw new Error(`Failed to set default payment method: ${err.message}`);
  }
}

/**
 * List a connected account's payout destinations — bank accounts and debit
 * cards (Stripe keeps these as two separate "external account" object types).
 */
async function listExternalAccounts(accountId) {
  try {
    const [banks, cards] = await Promise.all([
      stripe.accounts.listExternalAccounts(accountId, { object: "bank_account", limit: 100 }),
      stripe.accounts.listExternalAccounts(accountId, { object: "card", limit: 100 }),
    ]);
    return [...banks.data, ...cards.data];
  } catch (err) {
    console.error("listExternalAccounts error:", err.message);
    throw new Error(`Failed to list payout methods: ${err.message}`);
  }
}

/**
 * Attach a new payout destination to a connected account. `token` is a
 * Stripe token/bank-account-token id (tok_xxx / btok_xxx) created client-side
 * via Stripe.js or the mobile SDK — raw card/bank numbers never reach us.
 */
async function addExternalAccount(accountId, token, { setDefault = false } = {}) {
  try {
    const externalAccount = await stripe.accounts.createExternalAccount(accountId, {
      external_account: token,
      ...(setDefault ? { default_for_currency: true } : {}),
    });
    return externalAccount;
  } catch (err) {
    console.error("addExternalAccount error:", err.message);
    throw new Error(`Failed to add payout method: ${err.message}`);
  }
}

/**
 * Remove a payout destination from a connected account.
 */
async function removeExternalAccount(accountId, externalAccountId) {
  try {
    await stripe.accounts.deleteExternalAccount(accountId, externalAccountId);
  } catch (err) {
    console.error("removeExternalAccount error:", err.message);
    throw new Error(`Failed to remove payout method: ${err.message}`);
  }
}

/**
 * Trigger a manual withdrawal from a connected account's available balance
 * to one of its payout destinations. Requires the account's payout schedule
 * to be "manual" (see ensureManualPayoutSchedule) so Stripe's automatic
 * schedule doesn't also pay out the same balance.
 */
async function createPayout({ accountId, amountMinor, currency, destination }) {
  try {
    await ensureManualPayoutSchedule(accountId);
    const payout = await stripe.payouts.create(
      { amount: amountMinor, currency, destination },
      { stripeAccount: accountId },
    );
    return payout;
  } catch (err) {
    console.error("createPayout error:", err.message);
    throw new Error(`Failed to create payout: ${err.message}`);
  }
}

module.exports = {
  WEB_BASE_URL,
  createConnectAccount,
  generateOnboardingLink,
  getAccountStatus,
  checkOnboardingStatus,
  syncOnboardingStatusByAccountId,
  getConnectBalance,
  getOrCreateCustomer,
  attachPaymentMethod,
  detachPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
  ensureManualPayoutSchedule,
  listExternalAccounts,
  addExternalAccount,
  removeExternalAccount,
  createPayout,
};
