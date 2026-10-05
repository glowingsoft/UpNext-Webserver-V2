// Adapter for Anthropic's Messages API. Every provider adapter exposes the
// same shape (see @services/ai/index.js) so swapping AI_PROVIDER never
// touches calling code.
const config = require("../config");

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status}): ${imageUrl}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mediaType: contentType.split(";")[0], data: buf.toString("base64") };
}

async function callMessages({ model, system, content, maxTokens }) {
  if (!config.apiKey) throw new Error("AI_API_KEY / ANTHROPIC_API_KEY is not set");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || config.maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error (${res.status}): ${body}`);
  }

  const json = await res.json();
  return (json.content || []).map((block) => block.text || "").join("");
}

async function complete({ prompt, system, maxTokens }) {
  const text = await callMessages({
    model: config.textModel,
    system,
    content: [{ type: "text", text: prompt }],
    maxTokens,
  });
  return { text };
}

async function completeWithImage({ prompt, system, imageUrl, maxTokens }) {
  const { mediaType, data } = await fetchImageAsBase64(imageUrl);
  const text = await callMessages({
    model: config.visionModel,
    system,
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data } },
      { type: "text", text: prompt },
    ],
    maxTokens,
  });
  return { text };
}

module.exports = { complete, completeWithImage };
