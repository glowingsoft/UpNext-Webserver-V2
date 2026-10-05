// Central AI config. Switching provider/model is an env change only —
// callers go through @services/ai's generic functions and never see this.
module.exports = {
  provider: process.env.AI_PROVIDER || "anthropic",
  textModel: process.env.AI_TEXT_MODEL || "claude-sonnet-5",
  visionModel: process.env.AI_VISION_MODEL || "claude-sonnet-5",
  apiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY,
  maxTokens: Number(process.env.AI_MAX_TOKENS) || 1024,
  // Only used by reasoning models (gpt-5*, o*). "minimal" spends the least
  // on hidden reasoning tokens before answering — fastest for short,
  // low-ambiguity tasks like classification. Bump to "low"/"medium" via env
  // if a task needs more actual reasoning.
  reasoningEffort: process.env.AI_REASONING_EFFORT || "minimal",
  cacheTtlSeconds: Number(process.env.AI_CACHE_TTL_SECONDS) || 60 * 60 * 24 * 30, // 30 days
};
