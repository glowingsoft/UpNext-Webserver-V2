const multer = require("multer");

// Memory storage for multer
const storage = multer.memoryStorage(); // Store files in memory as a buffer

// Multer middleware for file upload
const uploads3Mw = multer({
  storage: storage,
  // limits: { fileSize: 10 * 1024 * 1024 }, // Initial limit to handle larger uncompressed files
  fileFilter: (req, file, cb) => {
    checkFileType(file, cb);
  },
}).array("files", 20);

// Function to check file type
function checkFileType(file, cb) {
  const filetypes = /\.(jpeg|jpg|jfif|png|gif|bmp|tiff|webp|svg|avif|heic|heif)$/i;
  const extname = filetypes.test(file.originalname.toLowerCase());
  const mimetype = file.mimetype?.toLowerCase().startsWith("image/");

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only images and PDFs are allowed!"));
  }
}

module.exports = {
  uploads3Mw,
};
