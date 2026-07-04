const { uploadBufferToS3, extensionFor } = require('../utils/s3Upload');

// Storage strategy A — INBOUND ONLY: download the couple's media from Meta and
// store it on our own S3 so the CRM keeps a permanent, renderable URL (Meta's
// media URLs expire in minutes). This never sends anything outbound.
//
// Graph base + tokens are reused from the existing send path:
//   META_GRAPH_BASE_URL (test seam; defaults to the real Graph endpoint)
//   META_WA_AGENT_ACCESS_TOKEN  (Kiara agent number — same token the agent
//                                inbound/send path uses), falling back to
//   META_WA_ACCESS_TOKEN.
const GRAPH_BASE_URL = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com/v19.0';
const accessToken = () => process.env.META_WA_AGENT_ACCESS_TOKEN || process.env.META_WA_ACCESS_TOKEN;

// Given a Meta media id, fetch the short-lived download URL, download the bytes
// with the WA token, and store to our S3. Returns the stored media descriptor,
// or null if anything fails (caller persists the row with mediaUrl=null).
const storeWhatsAppMedia = async (mediaId, { mimeType, filename } = {}) => {
  if (!mediaId) return null;
  try {
    // 1) Resolve the media id to a short-lived, auth'd download URL + metadata.
    const metaRes = await fetch(`${GRAPH_BASE_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (!metaRes.ok) throw new Error(`Meta media lookup failed: ${metaRes.status}`);
    const meta = await metaRes.json();
    if (!meta || !meta.url) throw new Error('Meta media lookup returned no url');

    const resolvedMime = meta.mime_type || mimeType || 'application/octet-stream';

    // 2) Download the actual bytes (this URL also requires the WA bearer token).
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (!fileRes.ok) throw new Error(`Meta media download failed: ${fileRes.status}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // 3) Store to our S3 (keyed by media id so a Meta redelivery is idempotent).
    const key = `wa-agent-media/${mediaId}.${extensionFor(resolvedMime, filename)}`;
    const url = await uploadBufferToS3({ buffer, key, contentType: resolvedMime });

    return {
      mediaUrl: url,
      mediaMimeType: resolvedMime,
      mediaSize: meta.file_size || buffer.length || null,
    };
  } catch (error) {
    console.error('[WhatsAppMedia] store failed for media', mediaId, '-', error.message);
    return null;
  }
};

module.exports = { storeWhatsAppMedia };
