const express = require("express");
const {
  uploadFiles,
  deleteFiles,
} = require("../controllers/uploadAWSController");

const router = express.Router();

// Route to upload a file
router.post("/", uploadFiles);
router.delete("/", deleteFiles);


module.exports = router;
