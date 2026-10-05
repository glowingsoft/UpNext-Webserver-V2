const { S3Client } = require("@aws-sdk/client-s3");
require("dotenv").config();

// One client for every module that touches the bucket — the upload controller
// and the thumbnail helper were otherwise each standing up their own connection
// pool against the same region and credentials.
const s3 = new S3Client({
  region: process.env.AWS_S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
  },
});

module.exports = { s3 };
