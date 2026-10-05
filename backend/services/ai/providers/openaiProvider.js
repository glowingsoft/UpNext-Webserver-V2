// Adapter for OpenAI's Responses API.
// Every provider adapter exposes the same shape
// (see @services/ai/index.js) so swapping AI_PROVIDER
// never touches calling code.

const config = require("../config");

const API_URL = "https://api.openai.com/v1/responses";

async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);

  if (!res.ok) {
    throw new Error(`Failed to fetch image (${res.status}): ${imageUrl}`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());

  return {
    mediaType: contentType.split(";")[0],
    data: buf.toString("base64"),
  };
}

async function callResponses({ model, system, content, maxTokens }) {
  if (!config.apiKey) {
    throw new Error("AI_API_KEY / OPENAI_API_KEY is not set");
  }

  const input = [];

  if (system) {
    input.push({
      role: "system",
      content: [
        {
          type: "input_text",
          text: system,
        },
      ],
    });
  }

  input.push({
    role: "user",
    content,
  });

  // Reasoning models (gpt-5*) spend part of max_output_tokens on hidden
  // reasoning tokens before emitting visible text, so a small budget can be
  // fully consumed by reasoning and return no text at all (status:
  // "incomplete"). Give reasoning models a floor and ask for minimal
  // reasoning effort so the budget goes to the actual answer.
  const isReasoningModel = /^(o[0-9]|gpt-5)/.test(model);
  const requestedTokens = maxTokens || config.maxTokens;
  const body = {
    model,
    input,
    max_output_tokens: isReasoningModel ? Math.max(requestedTokens, 512) : requestedTokens,
  };
  if (isReasoningModel) {
    body.reasoning = { effort: config.reasoningEffort };
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const respBody = await res.text().catch(() => "");

    throw new Error(`OpenAI API error (${res.status}): ${respBody}`);
  }

  const json = await res.json();

  if (json.status === "incomplete") {
    const reason = json.incomplete_details?.reason || "unknown";
    throw new Error(`OpenAI response incomplete (reason: ${reason}) — increase max_output_tokens`);
  }

  return extractOutputText(json);
}

// `output_text` is a convenience getter the official OpenAI SDK computes
// client-side — it does not exist on the raw REST response, which only has
// `output: [...]` (a reasoning block, then a message block whose `content`
// holds the actual `output_text` part).
function extractOutputText(json) {
  const message = (json.output || []).find((item) => item.type === "message");
  const textPart = message?.content?.find((part) => part.type === "output_text");
  return textPart?.text || "";
}

async function complete({ prompt, system, maxTokens }) {
  const text = await callResponses({
    model: config.textModel,
    system,
    content: [
      {
        type: "input_text",
        text: prompt,
      },
    ],
    maxTokens,
  });

  return { text };
}

async function completeWithImage({ prompt, system, imageUrl, maxTokens }) {
  const { mediaType, data } = await fetchImageAsBase64(imageUrl);

  const text = await callResponses({
    model: config.visionModel,
    system,
    content: [
      {
        type: "input_image",
        image_url: `data:${mediaType};base64,${data}`,
      },
      {
        type: "input_text",
        text: prompt,
      },
    ],
    maxTokens,
  });
  console.log(text, "completeWithImage response");
  return { text };
}

module.exports = {
  complete,
  completeWithImage,
  callResponses,
};
