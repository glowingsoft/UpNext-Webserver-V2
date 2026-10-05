// Generic AI entry point used by the rest of the app. Every feature
// (auto-tagging, photo tagging, bio cleanup, search) calls generateText /
// generateJSON / analyzeImage here — never a provider SDK directly — so
// changing the provider or model later (config.js / env vars, or a new file
// under ./providers) never touches feature/controller code.
const crypto = require("crypto");
const config = require("./config");
const { cache } = require("@redisCache");

const providers = {
  anthropic: require("./providers/anthropicProvider"),
  openai: require("./providers/openaiProvider"),
};

function getProvider() {
  const provider = providers[config.provider];
  if (!provider) {
    throw new Error(`Unknown AI_PROVIDER "${config.provider}". Available: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}

function hashKey(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Free-form text generation (e.g. bio cleanup suggestions).
 */
async function generateText({ prompt, system, maxTokens, cacheable = true, ttl } = {}) {
  const run = async () => {
    const { text } = await getProvider().complete({ prompt, system, maxTokens });
    return text;
  };

  if (!cacheable) return run();

  return cache({
    namespace: "ai:text",
    params: { h: hashKey({ provider: config.provider, model: config.textModel, system, prompt }) },
    ttl: ttl ?? config.cacheTtlSeconds,
    fetchFn: run,
  });
}

/**
 * Structured output. `prompt` should already instruct the model on the
 * exact JSON shape wanted; this just enforces "JSON only" and parses safely.
 */
async function generateJSON({ prompt, system, maxTokens, cacheable = true, ttl } = {}) {
  const jsonSystem = `${system ? `${system}\n\n` : ""}Respond with ONLY valid JSON. No prose, no markdown code fences.`;

  const raw = await generateText({ prompt, system: jsonSystem, maxTokens, cacheable, ttl });
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Vision: analyze an image (portfolio photo tagging, visual search, etc).
 */
async function analyzeImage({ imageUrl, prompt, system, maxTokens, cacheable = true, ttl } = {}) {
  const run = async () => {
    const { text } = await getProvider().completeWithImage({ prompt, system, imageUrl, maxTokens });
    return text;
  };

  if (!cacheable) return run();

  return cache({
    namespace: "ai:image",
    params: { h: hashKey({ provider: config.provider, model: config.visionModel, system, prompt, imageUrl }) },
    ttl: ttl ?? config.cacheTtlSeconds,
    fetchFn: run,
  });
}

async function analyzeImageJSON(opts) {
  const raw = await analyzeImage({
    ...opts,
    system: `${opts.system ? `${opts.system}\n\n` : ""}Respond with ONLY valid JSON. No prose, no markdown code fences.`,
  });
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }
}

module.exports = { generateText, generateJSON, analyzeImage, analyzeImageJSON };
