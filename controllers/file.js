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

    // Same env-gated endpoint override utils/s3Upload already carries: set
    // AWS_S3_ENDPOINT to point a local drive at a scratch bucket or an
    // S3-compatible stub, and every upload path behaves the same. Inert when
    // unset, so production is untouched — this path was the only one that could
    // not be redirected, which made proof-of-payment untestable locally.
    // forcePathStyle because stubs and MinIO serve bucket/key as a path.
    const endpoint = process.env.AWS_S3_ENDPOINT || "";
    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
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

    let url = endpoint
      ? `${endpoint.replace(/\/$/, "")}/${process.env.AWS_BUCKET_NAME}/${s3Key}`
      : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;

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

    // Same env-gated override as CreateNew above. Declared in THIS function's
    // scope on purpose: the URL built below reads it, and an `endpoint` that
    // only existed in the other function would have thrown a ReferenceError the
    // first time an upload actually succeeded.
    const endpoint = process.env.AWS_S3_ENDPOINT || "";
    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const safeCategory = String(category || "venue").toLowerCase().replace(/[^a-z0-9-]/g, "-") || "venue";
    const extension = normalizedName.includes(".") ? normalizedName.split(".").pop() : "jpg";
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Bug 50 — the route's auth admits admin JWTs (req.admin) as well as venue
    // owners (req.venueOwner), but the key builder only knew the venue shape:
    // req.venueOwner.venueId threw for every admin call → 400 "AWS Upload
    // Error" on all OS Build & Bill uploads. Admin uploads land under os/.
    const s3Key = req.venueOwner
      ? `venues/${req.venueOwner.venueId}/${safeCategory}/${unique}.${extension}`
      : `os/${safeCategory}/${unique}.${extension}`;

    await s3Client.putObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: normalizedMime,
    });

    // The URL has to match where the object actually went: with an endpoint
    // override the object is at endpoint/bucket/key, and returning the AWS URL
    // would store a link that 404s for the whole life of the record.
    const url = endpoint
      ? `${endpoint.replace(/\/$/, "")}/${process.env.AWS_BUCKET_NAME}/${s3Key}`
      : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;

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
