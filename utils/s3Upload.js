const AWS = require('@aws-sdk/client-s3');

// Reusable S3 store, factored out of controllers/file.js (which only had the
// logic inlined inside Express route handlers). Same env vars, same public-URL
// shape — no new bucket, no new credentials. Throws on failure so the caller's
// try/catch owns the failure policy.
const uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  if (!buffer || !buffer.length) throw new Error('uploadBufferToS3: empty buffer');
  if (!key) throw new Error('uploadBufferToS3: missing key');

  // ── AN ENDPOINT OVERRIDE, FOR EVERYWHERE THAT IS NOT PRODUCTION ───────────
  // Unset — which is production — this behaves exactly as it always has: real
  // AWS, real bucket, the same public URL shape.
  //
  // Set, it points the client at an S3-compatible endpoint instead. Without it
  // the only way to exercise an upload locally is to blank the credentials and
  // watch it fail, which means the last step of every document flow — the file
  // actually arriving where the owner looks for it — could never be seen
  // working without writing test objects into the production bucket.
  //
  // forcePathStyle because local stubs and MinIO serve bucket/key as a path
  // rather than as a subdomain.
  const endpoint = process.env.AWS_S3_ENDPOINT || '';
  const s3Client = new AWS.S3({
    region: process.env.AWS_S3_REGION,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
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

  // The URL has to match where the object actually went, or the document row
  // would point at a file that is not there.
  return endpoint
    ? `${endpoint.replace(/\/$/, '')}/${process.env.AWS_BUCKET_NAME}/${key}`
    : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`;
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
