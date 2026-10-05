const { analyzeImageJSON } = require("@services/ai");

const VISION_SYSTEM =
  "You are tagging beauty/grooming portfolio photos (hair, nails, skin, makeup, etc). " +
  "Describe only what is visibly in the photo — never guess a provider or client identity.";

const VISION_PROMPT = `Analyze this portfolio photo and return JSON exactly like:
{"description": "<one short sentence>", "technique": ["..."], "style": ["..."], "color": ["..."]}

- "technique": how it was done, e.g. "balayage", "French tips", "ombre", "microblading" (0-5 items)
- "style": the overall look/shape, e.g. "coffin shape", "soft glam", "pixie cut" (0-5 items)
- "color": named colors/tones visible, e.g. "copper", "chrome", "rose gold" (0-5 items)

Lowercase every tag, keep each to 1-4 words, no duplicates. If the photo isn't a beauty/grooming result (or nothing is identifiable), return empty arrays.`;

// Best-effort: a bad/unreachable image or an AI outage must never block the
// portfolio save, so a failure here just means the photo goes untagged
// rather than the whole request failing (same contract as thumbnail generation).
async function tagPortfolioImage(imageUrl) {
  try {
    const result = await analyzeImageJSON({ imageUrl, prompt: VISION_PROMPT, system: VISION_SYSTEM, maxTokens: 300 });
    const clean = (arr) => (Array.isArray(arr) ? arr.map((v) => String(v).trim().toLowerCase()).filter(Boolean) : []);
    return {
      description: typeof result?.description === "string" ? result.description.trim() : "",
      technique: clean(result?.technique),
      style: clean(result?.style),
      color: clean(result?.color),
    };
  } catch (error) {
    console.error("tagPortfolioImage failed", error);
    return { description: "", technique: [], style: [], color: [] };
  }
}

module.exports = { tagPortfolioImage };
