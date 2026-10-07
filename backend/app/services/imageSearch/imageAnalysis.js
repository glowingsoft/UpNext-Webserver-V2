const { tagPortfolioImage } = require("@services/ai/features/tagPortfolioMedia");
const { keyToUrl } = require("./imageInput");

// Keeps the regex $in lists in the downstream queries small.
const MAX_TERMS = 10;

// Results are cached by the AI layer, keyed on the image content/URL, so
// repeating a search with the same image costs no extra vision call.
// Never throws: an AI failure just means no tags.
async function analyzeImage(source) {
  const { description, technique, style, color } = await tagPortfolioImage(source);
  const terms = [...new Set([...technique, ...style, ...color])].slice(0, MAX_TERMS);
  return { description, technique, style, color, terms };
}

// Lets text search accept an image without knowing how it is analyzed.
// Unusable input is treated as "no image" so the text query still runs.
async function imageTermsFromUrl(imageUrl) {
  try {
    return (await analyzeImage(keyToUrl(imageUrl))).terms;
  } catch {
    return [];
  }
}

module.exports = { analyzeImage, imageTermsFromUrl };
