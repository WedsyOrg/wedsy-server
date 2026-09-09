/**
 * utils/venueUpiQr.js — the venue's UPI QR: generated from the UPI ID, or
 * accepted as an upload, ONE stored image either way.
 *
 * ── THE ENCODING (founder-proven against his own VPA in GPay) ───────────────
 *   upi://pay?pa=<upiId>&pn=<venue name, URL-encoded>&cu=INR
 * The pa rides raw (a VPA's alphabet — alnum, dot, hyphen, underscore, @ —
 * needs no escaping and GPay resolved it as-is); only pn is URL-encoded.
 *
 * ── WHAT MAKES IT SCAN ON PAPER (not cosmetic) ──────────────────────────────
 * Printed at roughly 25mm on A4. Stored at 600×600px, which is ~610dpi at
 * that size — far above the ~300dpi a laser printer resolves, so the module
 * edges stay square instead of smearing. Quiet zone: 4 modules of white
 * margin baked into the image. Error correction Q (25% recovery) — a level
 * above the brief's minimum M, so a fold or a weak toner patch does not kill
 * it; H was rejected because it nearly doubles module density at this
 * payload length, which SHRINKS each module at a fixed print size and costs
 * more scanability than the extra correction buys.
 * BLACK ON WHITE ALWAYS (#000000 / #FFFFFF, opaque): a QR tinted by a
 * language palette is a broken QR, so the colours are fixed here and no
 * caller can pass others.
 *
 * Documents do NOT print this yet — placement is ruled per document later.
 */
const QRCode = require("qrcode");

const QR_WIDTH = 600;   // px — ≈610dpi at the 25mm print size
const QR_MARGIN = 4;    // modules of white quiet zone
const QR_EC = "Q";      // 25% recovery

function upiPayload(upiId, venueName, { amount, note } = {}) {
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(venueName || "")}`
    + (amount ? `&am=${Math.round(Number(amount))}` : "")
    + (note ? `&tn=${encodeURIComponent(note)}` : "")
    + "&cu=INR";
}

/**
 * @param {object} [extra] {amount?, note?} — the INVOICE's amount-carrying QR
 * (founder ruling): &am= locks the figure so a couple scans and confirms
 * instead of typing. Everything else (size, EC, colours) is identical.
 * @returns {Promise<{dataUrl: string, upiString: string}>}
 */
async function generateUpiQr(upiId, venueName, extra = {}) {
  const upiString = upiPayload(upiId, venueName, extra);
  const dataUrl = await QRCode.toDataURL(upiString, {
    errorCorrectionLevel: QR_EC,
    width: QR_WIDTH,
    margin: QR_MARGIN,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return { dataUrl, upiString };
}

// ── the uploaded route ──────────────────────────────────────────────────────
// A venue with no UPI ID can upload the QR their bank app made. Same store,
// same shape, so nothing downstream cares which route produced it.
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024; // a QR image is small; 1MB is generous
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

/** @returns {{ok:true, value:string} | {ok:false, message:string}} */
function validateQrImageDataUrl(input) {
  const s = typeof input === "string" ? input.trim() : "";
  const m = DATA_URL_RE.exec(s);
  if (!m) return { ok: false, message: "The QR must be a PNG or JPEG image." };
  let bytes;
  try {
    bytes = Buffer.from(m[2], "base64");
  } catch {
    return { ok: false, message: "That image could not be read." };
  }
  if (!bytes.length) return { ok: false, message: "That image is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "That image is too large — a QR code is under 1 MB." };
  }
  return { ok: true, value: s };
}

const EMPTY_QR = { dataUrl: "", source: "", upiString: "", updatedAt: null };

module.exports = { upiPayload, generateUpiQr, validateQrImageDataUrl, EMPTY_QR, QR_WIDTH, QR_MARGIN, QR_EC, MAX_UPLOAD_BYTES };
