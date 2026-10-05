const { generateText } = require("@services/ai");

async function suggestBusinessDescription({ tags, businessName, categories, skills }) {
  const categoryNames = (Array.isArray(categories) ? categories : [])
    .map((category) => (typeof category === "string" ? category : category?.name))
    .filter(Boolean);
  const skillNames = Array.isArray(skills) ? skills.filter(Boolean) : [];
  const tagNames = Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string" && tag.trim()) : [];

  const prompt = `Write a polished, trustworthy listing description for the provider using the supplied tags and details.

Business name: ${JSON.stringify(businessName || "")}
Categories: ${JSON.stringify(categoryNames)}
Skills: ${JSON.stringify(skillNames)}
Tags: ${JSON.stringify(tagNames)}

Keep only facts supported by the supplied information. Use a warm, professional, consistent tone. Do not add credentials, prices, guarantees, locations, or claims that were not provided. Write one concise paragraph (maximum 120 words). Return only the revised bio, with no label, quotation marks, or markdown.`;

  return (
    await generateText({
      prompt,
      system: "You edit beauty and grooming provider listings accurately and professionally.",
      maxTokens: 220,
    })
  ).trim();
}

module.exports = { suggestBusinessDescription };
