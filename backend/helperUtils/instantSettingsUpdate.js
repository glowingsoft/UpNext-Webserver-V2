const AdminSettings = require("@models/AdminSettings");

const INTEGER_FIELDS = new Set([
  "providerAcceptSec", "providerAcceptSecAdvance", "paymentSec", "customerDecisionSec",
  "maxAttemptMinutes", "maxAdvanceDays", "feeFloorCents", "feeCapCents", "minInstantPriceCents",
  "maxProviders", "penaltyDeductionCents", "penaltyWindowDays", "timeoutStreakLimit",
  "suspensionHours", "noShowReportWindowMin", "noShowContestWindowHours",
]);
const WEIGHTS = ["travelTime", "rating", "acceptanceRate", "similarity"];

const invalid = (field) => ({ error: "invalid_setting", field });

const buildInstantSettingsUpdate = (body, current) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body");
  const nested = Object.prototype.hasOwnProperty.call(body, "instant");
  if (nested && Object.keys(body).length !== 1) return invalid("instant");
  const input = nested ? body.instant : body;
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length) {
    return invalid(nested ? "instant" : "body");
  }

  const candidate = {
    ...current,
    scoringWeights: { ...current.scoringWeights },
  };
  const set = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "scoringWeights") {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
        return invalid(key);
      }
      for (const [weight, amount] of Object.entries(value)) {
        if (!WEIGHTS.includes(weight) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
          return invalid(`scoringWeights.${weight}`);
        }
        candidate.scoringWeights[weight] = amount;
        set[`instant.scoringWeights.${weight}`] = amount;
      }
      continue;
    }

    const schemaPath = AdminSettings.schema.path(`instant.${key}`);
    if (!schemaPath || schemaPath.instance !== "Number" || typeof value !== "number" || !Number.isFinite(value)) {
      return invalid(key);
    }
    if (INTEGER_FIELDS.has(key) && !Number.isSafeInteger(value)) return invalid(key);
    candidate[key] = value;
    set[`instant.${key}`] = value;
  }

  const error = new AdminSettings({ instant: candidate }).validateSync();
  if (error) {
    const path = Object.keys(error.errors)[0].replace(/^instant\./, "");
    return invalid(path);
  }
  if (candidate.feeFloorCents > candidate.feeCapCents) return invalid("feeFloorCents");
  if (WEIGHTS.every((weight) => candidate.scoringWeights[weight] === 0)) return invalid("scoringWeights");
  return { set };
};

module.exports = { buildInstantSettingsUpdate };
