const express = require("express");
const {
  uploadFile,
  getFileByName,
  getFileDetails,
  getAllFiles,
} = require("../controllers/uploadController");
const createRateLimiter = require("../../helperUtils/rateLimiter");

const router = express.Router();

const apiRateLimiter = createRateLimiter("upload", 10, 20);
// Route to upload a file
router.post("/", apiRateLimiter, uploadFile);

// Route to get a file by name
router.get("/:filename", getFileByName);

// Route to get file details by name
router.get("/details/:filename", getFileDetails);

// Route to get all files
router.get("/", getAllFiles);

module.exports = router;
