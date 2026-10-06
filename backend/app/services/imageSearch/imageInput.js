const sharp = require("sharp");
const { getFullImageUrl } = require("@utils/imageHelper");
const { cleanfiles } = require("@utils/responseUtil");

// The vision model gains nothing from more pixels, and a smaller payload is
// cheaper and faster to send.
const MAX_EDGE = 1024;
const NO_IMAGE_KEY = "noImg.png";

// `code` doubles as the locale key the controller responds with.
class ImageInputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// sharp refuses anything that isn't a decodable image, so this also validates
// the bytes rather than trusting the client-declared mime type.
async function bufferToDataUrl(buffer) {
  try {
    const jpeg = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    throw new ImageInputError("image_invalid");
  }
}

// cleanfiles keeps only the last path segment, so a foreign URL becomes a key
// under our own bucket — nothing arbitrary is ever fetched (no SSRF).
function keyToUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") throw new ImageInputError("image_invalid");
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) return imageUrl;
  const key = cleanfiles(String(imageUrl));
  if (key === NO_IMAGE_KEY) throw new ImageInputError("image_invalid");
  return getFullImageUrl(key);
}

// An uploaded file wins over a URL when both are sent.
async function resolveImageSource({ file, imageUrl }) {
  if (file?.buffer) return bufferToDataUrl(file.buffer);
  if (imageUrl) return keyToUrl(imageUrl);
  throw new ImageInputError("image_required");
}

module.exports = { ImageInputError, resolveImageSource, keyToUrl };
