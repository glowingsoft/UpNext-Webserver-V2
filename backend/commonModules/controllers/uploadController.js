const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const upload = require("../../middlewares/uploadFileMw");
const { sendResponse } = require("@utils/responseUtil");

// Helper function to determine file type
const getFileType = (mimeType) => {
    if (mimeType.startsWith("image/")) {
        return "image";
    } else if (mimeType.startsWith("video/")) {
        return "video";
    } else {
        return "document";
    }
};

// Function to handle file upload
const uploadFile = (req, res) => {
    upload(req, res, (err) => {
        if (err) {
            sendResponse({
                res,
                statusCode: 400,
                translationKey: "file_upload_1",
                error: err,
            });
        } else {
            if (req.file == undefined) {
                sendResponse({
                    res,
                    statusCode: 400,
                    translationKey: "no_file",
                });
            } else {
                const baseUrl = `${process.env.S3_BASE_URL}/`;

                sendResponse({
                    res,
                    statusCode: 200,
                    translationKey: "file_uploaded",
                    data: {
                        message: "File uploaded successfully!",
                        file: `${req.file.filename}`,
                        fileUrl: `${baseUrl}${req.file.filename}`,
                    },
                });
            }
        }
    });
};

// Function to get a file by filename
const getFileByName = (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, "../uploads", filename);

    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            sendResponse({
                res,
                statusCode: 404,
                translationKey: "file_not",
                error: "File not found",
            });
        } else {
            res.sendFile(filePath);
        }
    });
};

// Function to get file details by filename
const getFileDetails = (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, "../uploads", filename);

    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            sendResponse({
                res,
                statusCode: 404,
                translationKey: "file_not",
                error: "File not found",
            });
        } else {
            const mimeType = mime.lookup(filePath);
            const fileType = getFileType(mimeType);

            // Construct URL path
            const urlPath = `${req.protocol}://${req.get("host")}/api/upload/${filename}`;

            const fileDetails = {
                filename,
                path: urlPath,
                mimeType,
                fileType,
            };

            sendResponse({
                res,
                statusCode: 200,
                translationKey: "file_details",
                data: fileDetails,
            });
        }
    });
};

// Function to get all files
const getAllFiles = (req, res) => {
    const directoryPath = path.join(__dirname, "../uploads");

    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            sendResponse({
                res,
                statusCode: 500,
                translationKey: "unable_to",
                error: "Unable to scan files",
            });
        } else {
            const fileDetails = files.map((file) => {
                const filePath = path.join(directoryPath, file);
                const mimeType = mime.lookup(filePath);
                const fileType = getFileType(mimeType);

                // Construct URL path
                const urlPath = `${req.protocol}://${req.get("host")}/api/upload/${file}`;

                return {
                    filename: file,
                    path: urlPath,
                    mimeType,
                    fileType,
                };
            });

            sendResponse({
                res,
                statusCode: 200,
                translationKey: "all_files",
                data: { files: fileDetails },
            });
        }
    });
};

module.exports = {
    uploadFile,
    getFileByName,
    getFileDetails,
    getAllFiles,
};
