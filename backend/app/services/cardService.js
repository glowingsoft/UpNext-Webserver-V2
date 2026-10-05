const stripe = require("@config/stripe");
const { User } = require("@models/UserModel");
const Card = require("@models/Card");
const { userCache } = require("@config/nodeCache");
const { safeKeyword } = require("@helperUtils/regexUtil");
const {
  getOrCreateCustomer,
  attachPaymentMethod,
  detachPaymentMethod,
  setDefaultPaymentMethod,
} = require("../../services/stripeAccount");

const mapCard = (card) => ({
  _id: card._id,
  // Real Stripe PaymentMethod id — this is what the client sends back as
  // stripePaymentMethodId when creating a booking or fixing a booking's payment.
  stripePaymentMethodId: card.paymentMethodId,
  brand: card.brand,
  last4: card.last4,
  expMonth: card.expMonth,
  expYear: card.expYear,
  cardHolderName: card.cardHolderName,
  isDefault: card.isDefault,
});

// paymentMethodId is a Stripe PaymentMethod id (pm_xxx) created client-side via
// Stripe.js/the mobile SDK (createPaymentMethod) — raw card number/CVC never
// reach this endpoint. Creates the Stripe customer on first card if needed.
// Ownership + cardHolderName are persisted locally (Card collection) rather
// than trusted from Stripe's live PaymentMethod, so listing/updating never
// depends on the Stripe Customer id staying in sync with our own user doc.
const addCard = async ({ user, paymentMethodId, cardHolderName, setDefault }) => {
  const customer = await getOrCreateCustomer(user);
  if (customer.id !== user?.stripe?.customerId) {
    await User.findByIdAndUpdate(user._id, { "stripe.customerId": customer.id });
    userCache.del(String(user._id));
  }

  const attached = await attachPaymentMethod(customer.id, paymentMethodId, !!setDefault);

  if (cardHolderName) {
    await stripe.paymentMethods.update(paymentMethodId, { billing_details: { name: cardHolderName } });
  }

  if (setDefault) {
    await Card.updateMany({ user: user._id }, { isDefault: false });
  }

  const card = await Card.findOneAndUpdate(
    { paymentMethodId },
    {
      user: user._id,
      paymentMethodId,
      cardHolderName: cardHolderName || null,
      brand: attached.card?.brand || null,
      last4: attached.card?.last4 || null,
      expMonth: attached.card?.exp_month || null,
      expYear: attached.card?.exp_year || null,
      isDefault: !!setDefault,
    },
    { upsert: true, new: true },
  );

  return { data: mapCard(card) };
};

const listCards = async ({ user, keyword }) => {
  const filter = { user: user._id };
  if (keyword) {
    const regex = { $regex: safeKeyword(keyword), $options: "i" };
    filter.$or = [{ cardHolderName: regex }, { brand: regex }, { last4: regex }];
  }

  const cards = await Card.find(filter).sort({ createdAt: -1 }).lean();
  return { data: cards.map(mapCard) };
};

// id here is our own Card document _id, not the Stripe PaymentMethod id —
// callers needing the Stripe id must read it off the returned doc's paymentMethodId.
const getOwnedCard = (id, userId) => Card.findOne({ _id: id, user: userId });

// Stripe never allows changing a card's number/CVC on an existing PaymentMethod
// (PCI scope) — only billing_details.name and the expiry are updatable.
const updateCard = async ({ user, id, cardHolderName, expMonth, expYear, isDefault }) => {
  const existing = await getOwnedCard(id, user._id);
  if (!existing) return { error: "card_not_found", status: 404 };

  const updatePayload = {};
  if (cardHolderName) updatePayload.billing_details = { name: cardHolderName };
  if (expMonth || expYear) {
    updatePayload.card = {
      exp_month: expMonth || existing.expMonth,
      exp_year: expYear || existing.expYear,
    };
  }
  if (Object.keys(updatePayload).length) {
    await stripe.paymentMethods.update(existing.paymentMethodId, updatePayload);
  }

  if (isDefault) {
    const customerId = user?.stripe?.customerId;
    if (customerId) await setDefaultPaymentMethod(customerId, existing.paymentMethodId);
    await Card.updateMany({ user: user._id }, { isDefault: false });
  }

  if (cardHolderName) existing.cardHolderName = cardHolderName;
  if (expMonth) existing.expMonth = expMonth;
  if (expYear) existing.expYear = expYear;
  if (isDefault) existing.isDefault = true;
  await existing.save();

  return { data: mapCard(existing) };
};

const deleteCard = async ({ user, id }) => {
  const existing = await getOwnedCard(id, user._id);
  if (!existing) return { error: "card_not_found", status: 404 };

  await detachPaymentMethod(existing.paymentMethodId);
  await Card.deleteOne({ _id: existing._id });
  return { data: { _id: existing._id } };
};

module.exports = { addCard, listCards, updateCard, deleteCard };
