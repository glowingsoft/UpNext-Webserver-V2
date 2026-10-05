// const path = require("path");
// const { sendResponse } = require("../helperUtils/responseUtil");
// const { uploads3Mw } = require("../middlewares/uploadFilesAWSMw");
// const { v4: uuidv4 } = require("uuid");
// require("dotenv").config();
// const multer = require("multer");
// const sharp = require("sharp");
// const {
//   BlobServiceClient,
//   StorageSharedKeyCredential,
// } = require("@azure/storage-blob");

// const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// // Initialize Azure Blob Service
// const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
// const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
// const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

// const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
// const blobServiceClient = new BlobServiceClient(
//   `https://${accountName}.blob.core.windows.net`,
//   sharedKeyCredential
// );

// // Upload files to Azure
// const uploadFiles = (req, res) => {
//   uploads3Mw(req, res, async (err) => {
//     if (err instanceof multer.MulterError) {
//       return sendResponse({ res, statusCode: 400, error: err.message });
//     } else if (err) {
//       return sendResponse({ res, statusCode: 400, error: err.message });
//     } else if (!req.files || req.files.length === 0) {
//       return sendResponse({ res, statusCode: 400, translationKey: "no_files" });
//     }

//     try {
//       const uploadedFiles = await uploadFilesToAzure(req.files);
//       const response = uploadedFiles.length === 1 ? uploadedFiles[0] : uploadedFiles;

//       return sendResponse({
//         res,
//         statusCode: 200,
//         translationKey: "files_uploaded",
//         data: response,
//       });
//     } catch (error) {
//       return sendResponse({
//         res,
//         statusCode: 500,
//         translationKey: "azure_upload",
//         error: error,
//       });
//     }
//   });
// };

// // Upload multiple files
// const uploadFilesToAzure = async (files) => {
//   const containerClient = blobServiceClient.getContainerClient(containerName);

//   const uploadPromises = files.map(async (file) => {
//     let fileBuffer = file.buffer;
//     //enable to compress
//     // if (fileBuffer.length > MAX_FILE_SIZE) {
//     //   fileBuffer = await compressImage(file.buffer);
//     // }

//     const fileExtension = path.extname(file.originalname);
//     const filename = `${uuidv4()}${fileExtension}`;

//     const blockBlobClient = containerClient.getBlockBlobClient(filename);

//     await blockBlobClient.uploadData(fileBuffer, {
//       blobHTTPHeaders: { blobContentType: file.mimetype },
//     });

//     return {
//       file: filename,
//       fileUrl: `${process.env.AZURE_STORAGE_BASE_URL}${filename}`,
//       fileExtension: fileExtension,
//     };
//   });

//   return Promise.all(uploadPromises);
// };

// // Compress image
// const compressImage = async (buffer) => {
//   let quality = 80;
//   let compressedBuffer = buffer;

//   do {
//     compressedBuffer = await sharp(buffer)
//       .jpeg({ quality })
//       .toBuffer();

//     if (compressedBuffer.length <= MAX_FILE_SIZE) break;
//     quality -= 10;

//     if (quality < 10) throw new Error("Unable to compress below 3 MB");
//   } while (compressedBuffer.length > MAX_FILE_SIZE);

//   return compressedBuffer;
// };

// // Delete file from Azure
// const deleteFiles = async (req, res) => {
//   const { fileKey } = req.body;
//   if (!fileKey) {
//     return sendResponse({ res, statusCode: 400, error: "File key is missing" });
//   }

//   try {
//     const containerClient = blobServiceClient.getContainerClient(containerName);

//     if (Array.isArray(fileKey)) {
//       await Promise.all(fileKey.map((key) => containerClient.deleteBlob(key)));
//     } else {
//       await containerClient.deleteBlob(fileKey);
//     }

//     return sendResponse({ res, statusCode: 200, translationKey: "file_deleted" });
//   } catch (error) {
//     return sendResponse({
//       res,
//       statusCode: 500,
//       translationKey: "file_deletion",
//       error,
//     });
//   }
// };

// module.exports = { uploadFiles, deleteFiles, uploadFilesToAzure };
