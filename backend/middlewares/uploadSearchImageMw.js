const multer = require("multer");
const { sendResponse } = require("@utils/responseUtil");

const MAX_BYTES = 5 * 1024 * 1024;
// Held in memory only — a search image is analyzed and discarded, never stored.
const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const mimeType = file.mimetype.toLowerCase();
    const allowed = mimeType.startsWith("image/") && mimeType !== "image/gif";
    cb(allowed ? null : new Error("image_invalid"), allowed);
  },
}).single("image");

const uploadSearchImage = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  parseImage(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === "LIMIT_FILE_SIZE";
    return sendResponse({
      res,
      statusCode: tooLarge ? 413 : 400,
      translationKey: tooLarge ? "image_too_large" : "image_invalid",
    });
  });
};

module.exports = uploadSearchImage;
