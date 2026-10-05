const ServiceCategory = require("@models/ServiceCategory");
const { generateJSON } = require("@services/ai");

const shortCategoryName = (name) =>
  typeof name === "string" ? name.trim().split(/\s+/).slice(0, 4).join(" ") || null : null;

const suggestedDescription = (description) => (typeof description === "string" ? description : null);

async function suggestServiceClassification({ businessId, name, description, selectedCategoryId }) {
  const categories = await ServiceCategory.find({
    business: businessId,
    status: "active",
  })
    .select("_id name description")
    .lean();

  const selectedCategory = selectedCategoryId
    ? categories.find((c) => String(c._id) === String(selectedCategoryId))
    : null;

  const result = await generateJSON({
    prompt: `Classify this service into the most suitable category.

Service:
Name: ${JSON.stringify(name || "")}
Description: ${JSON.stringify(description || "")}

${
  selectedCategory
    ? `User Selected Category:
Name: ${JSON.stringify(selectedCategory.name || "")}
Description: ${JSON.stringify(selectedCategory.description || "")}

IMPORTANT:
- First check whether the selected category matches the service.
- If it matches, return its categoryId.
- If it does NOT match, find another suitable existing category.
- Do not force the selected category if it does not match.`
    : "No category was selected. Find the best existing category."
}

Existing Categories:
${categories.map((c) => `- ${c._id}: ${c.name} - ${c.description || ""}`).join("\n")}

If an existing category clearly matches, return its categoryId.

If no existing category matches, return categoryId null and suggest a new category.

Return JSON:
{
  "categoryId": null,
  "confidence": 0.0,
  "gap": false,
  "suggestedCategoryName": null,
  "suggestedCategoryDescription": null
}

Rules:
- Never invent category IDs.
- Use semantic meaning, not exact keyword matching.
- For a new category, name must be no more than four words.
- Provide a useful description for a new category.`,

    system:
      "Classify the service using the provided categories. Prefer an existing suitable category. Never invent category IDs.",
    maxTokens: 150,
  });

  const validCategory = categories.find((c) => String(c._id) === String(result?.categoryId));

  const categoryMismatch =
    Boolean(selectedCategoryId) && (!validCategory || String(validCategory._id) !== String(selectedCategoryId));

  return {
    matched: Boolean(validCategory),
    categoryId: validCategory?._id || null,
    categoryName: validCategory?.name || null,
    categoryMismatch,
    confidence: result?.confidence ?? null,
    gap: !validCategory,

    suggestedCategoryName: validCategory ? validCategory.name : shortCategoryName(result?.suggestedCategoryName),

    suggestedCategoryDescription: validCategory
      ? suggestedDescription(validCategory.description)
      : suggestedDescription(result?.suggestedCategoryDescription),
  };
}

module.exports = {
  suggestServiceClassification,
};
