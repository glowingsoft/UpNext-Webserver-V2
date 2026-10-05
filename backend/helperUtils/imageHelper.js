const mime = require("mime-types");

// An empty/missing image is "no image", not an image at the base URL — with no
// key to append, concatenating produced a link to the bucket root (or to a
// noimage.png placeholder that isn't there). Those rows now return null so the
// client can render its own fallback instead of a broken <img>.
function getFullImageUrl(imagePath, baseUrl = process.env.S3_BASE_URL || "") {
  if (typeof imagePath !== "string" || imagePath.trim() === "") return null;

  const path = imagePath.trim();
  return path.startsWith("http") ? path : baseUrl + path;
}

// Media is stored as a bare S3 key (or a full URL) with no mime type alongside
// it, so the type is derived from the extension — the same image/video/document
// buckets the upload endpoints report. Any query string/fragment is stripped
// first so a signed URL still classifies.
function getMediaType(mediaPath) {
  if (typeof mediaPath !== "string" || mediaPath.trim() === "") return null;

  const mimeType = mime.lookup(mediaPath.trim().split(/[?#]/)[0]);
  if (!mimeType) return "document"; // unknown extension — same bucket as non-image/video
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

module.exports = { getFullImageUrl, getMediaType };
