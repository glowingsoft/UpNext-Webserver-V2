const { generateJSON } = require("@services/ai");

// Turns a free-text client query ("soft glam highlights") into the same
// technique/style/color vocabulary tagPortfolioMedia uses, so search can
// match structured tags instead of relying on the query's exact wording.
async function expandPortfolioSearchQuery(query) {
  const prompt = `A client is searching for a beauty/grooming portfolio photo using natural language.

Query: ${JSON.stringify(query)}

Extract search terms as JSON exactly like:
{"technique": ["..."], "style": ["..."], "color": ["..."], "keywords": ["..."]}

- "technique"/"style"/"color" follow the same vocabulary a photo would be tagged with (e.g. "balayage", "coffin shape", "copper").
- "keywords" is a fallback: any other short terms from the query not captured above.
- Correct misspellings and normalize synonyms to the terms likely stored in photo tags. For example, "balyage" becomes "balayage", and "ombre highlights" should include both "ombre" and "balayage" when applicable.
Lowercase every term, 1-4 words each, no duplicates.`;

  try {
    const result = await generateJSON({
      prompt,
      system: "Extract structured beauty/grooming search terms from a client's query.",
      maxTokens: 200,
    });
    const clean = (arr) => (Array.isArray(arr) ? arr.map((v) => String(v).trim().toLowerCase()).filter(Boolean) : []);
    return {
      technique: clean(result?.technique),
      style: clean(result?.style),
      color: clean(result?.color),
      keywords: clean(result?.keywords),
    };
  } catch (error) {
    // AI enrichment must never block search — fall back to the raw query
    // as a single keyword so plain-text matching still works.
    console.error("expandPortfolioSearchQuery failed", error);
    return {
      technique: [],
      style: [],
      color: [],
      keywords: [
        String(query || "")
          .trim()
          .toLowerCase(),
      ].filter(Boolean),
    };
  }
}

module.exports = { expandPortfolioSearchQuery };
