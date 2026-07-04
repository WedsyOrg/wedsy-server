const AWS = require('@aws-sdk/client-s3');

// Reusable S3 store, factored out of controllers/file.js (which only had the
// logic inlined inside Express route handlers). Same env vars, same public-URL
// shape — no new bucket, no new credentials. Throws on failure so the caller's
// try/catch owns the failure policy.
const uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  if (!buffer || !buffer.length) throw new Error('uploadBufferToS3: empty buffer');
  if (!key) throw new Error('uploadBufferToS3: missing key');

  const s3Client = new AWS.S3({
    region: process.env.AWS_S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  await s3Client.putObject({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  });

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`;
};

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

// Pick a file extension: prefer the document filename, else map the mime type,
// else the mime subtype, else a safe fallback.
const extensionFor = (mimeType, filename) => {
  if (filename && filename.includes('.')) return filename.split('.').pop().toLowerCase();
  if (mimeType) {
    if (MIME_EXT[mimeType]) return MIME_EXT[mimeType];
    const subtype = mimeType.split('/')[1];
    if (subtype) return subtype.split(';')[0].toLowerCase();
  }
  return 'bin';
};

module.exports = { uploadBufferToS3, extensionFor };
