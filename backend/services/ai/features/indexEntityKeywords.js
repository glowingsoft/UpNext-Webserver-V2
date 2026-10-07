const { tagPortfolioImage } = require("./tagPortfolioMedia");
const { getFullImageUrl } = require("@utils/imageHelper");

const MAX_PHOTOS = 5;
const PLACEHOLDER = /noimg\.png$/i;

const tokenize = (texts) => [
  ...new Set(
    texts
      .filter(Boolean)
      .flatMap((text) => String(text).toLowerCase().split(/[^a-z0-9]+/))
      .filter((word) => word.length > 1),
  ),
];

// Rebuilds a service/package's `search_keywords` from its text and the vision
// tags of its photos. Vision results are cached per image URL by @services/ai,
// so re-indexing after an edit only pays for photos that are actually new.
// Run it detached (fireAndForget): an AI outage just leaves the photos untagged.
async function indexEntityKeywords(Model, doc) {
  const images = [doc.coverImage, ...(doc.photos || [])].filter((img) => img && !PLACEHOLDER.test(img));
  const tags = await Promise.all(
    [...new Set(images)].slice(0, MAX_PHOTOS).map((img) => tagPortfolioImage(getFullImageUrl(img))),
  );
  const search_keywords = tokenize([
    doc.name,
    doc.description,
    ...tags.flatMap((t) => [t.description, ...t.technique, ...t.style, ...t.color]),
  ]);
  await Model.updateOne({ _id: doc._id }, { $set: { search_keywords } }, { timestamps: false });
}

module.exports = { indexEntityKeywords };
