const path = require("path");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const multer = require("multer");
const { sendResponse } = require("@utils/responseUtil");
const { v4: uuidv4 } = require("uuid");
const { values } = require("lodash");
require("dotenv").config();
const { uploads3Mw } = require("@middlewares/uploadFilesAWSMw");
const { createThumbnail } = require("@utils/thumbnailHelper");
const { s3 } = require("@config/s3Client");
const sharp = require("sharp");
const { send } = require("process");
let pLimit;
(async () => {
  pLimit = (await import("p-limit")).default;
})();

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB in bytes

// Function to handle file upload
const uploadFiles = (req, res) => {
  uploads3Mw(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_COUNT") {
        // Custom error message when file count exceeds the limit
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "limit_exceeding_max_files",
          error: "Too many files",
        });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "limit_exceeding_max_files",
          error: err.message,
        });
      }
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "file_upload",
        values: {
          errorMessage: err.message,
        },
        error: err,
      });
    } else if (err) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "file_upload",
        values: {
          errorMessage: err.message,
        },
        error: err,
      });
    } else if (!req.files || req.files.length === 0) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "no_files",
      });
    }

    try {
      // Upload all files to S3 in parallel
      const uploadedFiles = await uploadFilesToS3(req.files);

      // If only one file is uploaded, return it as an object; otherwise, return an array
      const response = uploadedFiles.length === 1 ? uploadedFiles[0] : uploadedFiles;

      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "files_uploaded",
        data: response,
      });
    } catch (error) {
      return sendResponse({
        res,
        statusCode: 500,
        translationKey: "s3_upload",
        values: {
          error: error.message,
        },
        error: error,
      });
    }
  });
};

// Function to upload multiple files to S3 in parallel with progress tracking
const uploadFilesToS3 = async (files) => {
  // Limit the number of concurrent uploads to 5 (you can adjust the limit as needed)
  const limit = pLimit(5);

  // Create a list of upload promises with concurrency control
  const uploadPromises = files.map((file, index) =>
    limit(async () => {
      // console.log(`Starting upload for file ${index + 1}: ${file.originalname}`);

      // Compress the file buffer only if the size is greater than MAX_FILE_SIZE
      let fileBuffer = file.buffer;
      // if (fileBuffer.length > MAX_FILE_SIZE) {
      //   fileBuffer = await compressImage(file.buffer);
      // }

      // Create upload parameters
      const params = createUploadParams({ ...file, buffer: fileBuffer });
      const parallelUploads3 = new Upload({
        client: s3,
        params: params,
      });

      // Register a progress listener
      parallelUploads3.on("httpUploadProgress", (progress) => {
        // console.log(
        //   `Progress for ${params.Key}: ${Math.round(
        //     (progress.loaded / progress.total) * 100
        //   )}%`
        // );
      });

      await parallelUploads3.done(); // Perform the upload

      // console.log(`Completed upload for file ${index + 1}: ${file.originalname}`);
      //also log remaining files
      console.log(`Remaining files: ${files.length - (index + 1)}`);

      // Generated here while the bytes are still in memory, so anything storing
      // this key later (portfolio media) finds the thumbnail already in the
      // bucket instead of downloading the original back to encode it.
      const thumbnail = await createThumbnail({ buffer: fileBuffer, key: params.Key });

      return {
        file: params.Key,
        fileUrl: `${process.env.S3_BASE_URL}${params.Key}`,
        fileExtension: path.extname(params.Key),
        thumbnail,
        thumbnailUrl: thumbnail ? `${process.env.S3_BASE_URL}${thumbnail}` : null,
        // fileSize: (compressedBuffer.length / 1024).toFixed(2) + ' KB', // Uncomment if needed
      };
    }),
  );

  // Wait for all the uploads to complete
  return Promise.all(uploadPromises);
};

// Helper function to generate the S3 upload parameters for each file
const createUploadParams = (file) => {
  const fileExtension = path.extname(file.originalname); // Get the file extension (e.g., .png)
  const filename = `${uuidv4()}${fileExtension}`; // Generate unique filename with uuid

  if (!file.buffer) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "file_buffer",
      error: "File buffer is missing",
    });
  }

  return {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: filename,
    Body: file.buffer, // File buffer from multer
    ContentType: file.mimetype,
    // ACL: "public-read-write", // Make the file publicly readable
  };
};

// Compress image until the desired size is achieved
const compressImage = async (buffer) => {
  let quality = 80; // Start with high quality
  let compressedBuffer = buffer;

  do {
    compressedBuffer = await sharp(buffer)
      .jpeg({ quality }) // Adjust quality
      .toBuffer();

    // Reduce quality further if the size is still above the limit
    if (compressedBuffer.length <= MAX_FILE_SIZE) {
      break;
    }
    console.log(`Compressed image size: ${compressedBuffer.length} bytes`);

    quality -= 10;

    if (quality < 10) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "image_size_compress",
        error: "Unable to compress image below 3 MB",
      });
    }
  } while (compressedBuffer.length > MAX_FILE_SIZE);

  return compressedBuffer;
};

// Function to delete file from S3
const deleteFileFromS3 = async (fileKey) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileKey, // The file name (key) you want to delete
  };

  try {
    const data = await s3.send(new DeleteObjectCommand(params));
    return data; // This will contain info like request ID
  } catch (error) {
    throw new Error(`Failed to delete file: ${error.message}`);
  }
};

// Function to handle deleting multiple files in parallel
const deleteMultipleFilesFromS3 = async (fileKeys) => {
  const deletePromises = fileKeys.map((fileKey) => deleteFileFromS3(fileKey));
  try {
    await Promise.all(deletePromises);
  } catch (error) {
    throw new Error(`Failed to delete some files: ${error.message}`);
  }
};

/* Request body format:
For a single file: { "fileKey": "some-file.png" }
For multiple files: { "fileKey": ["file1.png", "file2.jpg", "file3.pdf"] } */
// API to handle delete request for single or multiple files
const deleteFiles = async (req, res) => {
  const { fileKey } = req.body; // Expecting the file key(s) to be sent in the request body

  if (!fileKey) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: "file_key",
      error: "File key is missing.",
    });
  }

  try {
    if (Array.isArray(fileKey)) {
      // If fileKey is an array, delete multiple files
      await deleteMultipleFilesFromS3(fileKey);
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "files_deleted",
        data: { fileKeys: fileKey },
      });
    } else {
      // If fileKey is a single string, delete one file
      await deleteFileFromS3(fileKey);
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "file_deleted",
        data: { fileKey },
      });
    }
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "file_deletion",
      error: error,
    });
  }
};
module.exports = {
  uploadFiles,
  deleteFiles,
};
