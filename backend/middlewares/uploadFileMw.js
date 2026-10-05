const multer = require("multer");
const path = require("path");

// Set storage engine
const storage = multer.diskStorage({
  destination: "./uploads/", // Specify the destination folder
  filename: (req, file, cb) => {
    cb(null, file.fieldname + "-" + Date.now() + path.extname(file.originalname));
  },
});

// Initialize upload
const upload = multer({
  storage: storage,
  limits: { fileSize: 3000000 }, // Limit file size to 3MB
  fileFilter: (req, file, cb) => {
    checkFileType(file, cb);
  },
}).single("file");

// Check file type
function checkFileType(file, cb) {
  const allowedExtensions = /\.(jpeg|jpg|jfif|png|gif|bmp|tiff|webp|svg|avif|heic|heif)$/i;

  const extname = allowedExtensions.test(file.originalname);
  const mimetype = file.mimetype?.toLowerCase().startsWith("image/");
  if (mimetype && extname) {
    return cb(null, true);
  }

  cb(new Error("Error: Images Only!"));
}
module.exports = upload;
