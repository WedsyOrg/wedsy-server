const AWS = require("@aws-sdk/client-s3");
const sharp = require("sharp");

const CreateNew = async (req, res) => {
  const { path, id } = req.body;

  // Check if file exists in req.files
  if (!req.files || !req.files.file) {
    return res.status(400).send({ message: "No file uploaded" });
  }

  const file = req.files.file;
  let { data, name, mimetype } = file;

  if (!name || !path || !id) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  try {
    // Normalize any image format to JPEG so all uploads render consistently
    // across browsers (HEIC/HEIF/WebP/AVIF are not universally supported).
    if (mimetype && mimetype.startsWith("image/")) {
      data = await sharp(data).jpeg({ quality: 90 }).toBuffer();
      mimetype = "image/jpeg";
      name = name.replace(/\.[^.]+$/, ".jpg");
    }

    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const extension = name.split(".").pop();
    const s3Key = `${path}/${id}.${extension}`;

    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Body: data,
      ContentType: mimetype,
    };

    const result = await s3Client.putObject(params);

    let url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;

    res.send({
      message: "File Uploaded Successfully",
      url,
    });
  } catch (error) {
    res.status(400).send({
      message: "AWS Upload Error",
      error: {
        name: error.name,
        Code: error.Code,
        message: error.message,
        requestId: error.$metadata?.requestId,
      }
    });
  }
};

const VenueOwnerUpload = async (req, res) => {
  try {
    const { filename, mimeType, data, category } = req.body || {};

    if (!filename || !data) {
      return res.status(400).send({ message: "filename and data are required" });
    }

    let buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch (e) {
      return res.status(400).send({ message: "Invalid base64 data" });
    }
    if (buffer.length === 0) {
      return res.status(400).send({ message: "Decoded file is empty" });
    }

    let normalizedName = filename;
    let normalizedMime = mimeType || "application/octet-stream";

    if (normalizedMime.startsWith("image/")) {
      buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      normalizedMime = "image/jpeg";
      normalizedName = normalizedName.replace(/\.[^.]+$/, ".jpg");
    }

    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const safeCategory = String(category || "venue").toLowerCase().replace(/[^a-z0-9-]/g, "-") || "venue";
    const extension = normalizedName.includes(".") ? normalizedName.split(".").pop() : "jpg";
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const s3Key = `venues/${req.venueOwner.venueId}/${safeCategory}/${unique}.${extension}`;

    await s3Client.putObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: normalizedMime,
    });

    const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;

    res.send({ message: "File Uploaded Successfully", url });
  } catch (error) {
    res.status(400).send({
      message: "AWS Upload Error",
      error: {
        name: error.name,
        Code: error.Code,
        message: error.message,
        requestId: error.$metadata?.requestId,
      },
    });
  }
};

module.exports = { CreateNew, VenueOwnerUpload };
