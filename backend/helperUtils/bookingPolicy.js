const AGREEMENT_TEXT = "Once a provider accepts, your deposit and booking fee are non-refundable.";
const AGREEMENT_VERSION = "instant-v1";

const cancellationPolicyText = (policy) => {
  if (policy === "non_refundable") {
    return "After confirmation, the booking fee and deposit are non-refundable if you cancel.";
  }
  if (policy === "refundable_24h") {
    return "After confirmation, the booking fee is non-refundable. For advance bookings, the deposit is refundable if you cancel at least 24 hours before the appointment; otherwise it is non-refundable. For Available Now bookings, the deposit is non-refundable.";
  }
  throw new TypeError(`Invalid cancellation policy: ${policy}`);
};

const clientCancellationCaptureCents = ({ pricing, cancellationPolicySnapshot, flow }, now = new Date()) => {
  const { depositCents, chargeFeeCents, totalCents } = pricing || {};
  if (![depositCents, chargeFeeCents, totalCents].every(Number.isSafeInteger) ||
      depositCents < 0 || chargeFeeCents < 0 || totalCents <= 0 ||
      depositCents + chargeFeeCents > totalCents ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(flow?.appointmentStart instanceof Date) || !Number.isFinite(flow.appointmentStart.getTime()) ||
      typeof flow.isAvailableNow !== "boolean" ||
      !["non_refundable", "refundable_24h"].includes(cancellationPolicySnapshot?.policy)) {
    throw new TypeError("Invalid booking cancellation snapshot");
  }
  const refundDeposit = !flow.isAvailableNow && cancellationPolicySnapshot.policy === "refundable_24h" &&
    flow.appointmentStart.getTime() - now.getTime() >= 24 * 60 * 60 * 1000;
  return chargeFeeCents + (refundDeposit ? 0 : depositCents);
};

module.exports = { AGREEMENT_TEXT, AGREEMENT_VERSION, cancellationPolicyText, clientCancellationCaptureCents };
