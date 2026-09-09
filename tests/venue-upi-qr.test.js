// THE UPI QR — decoded off the generated pixels, because an image encoding
// the wrong VPA looks identical to one encoding the right one, and this is
// money. Run: DATABASE_URL=... node tests/venue-upi-qr.test.js
require("dotenv").config();
const mongoose = require("mongoose");
const { PNG } = require("pngjs");
const jsQR = require("jsqr");

const Venue = require("../models/Venue");
const { generateUpiQr, upiPayload, validateQrImageDataUrl, QR_WIDTH } = require("../utils/venueUpiQr");
const venueCtrl = require("../controllers/venue");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const TAG = `upiqr-${Date.now()}`;

function pngOfDataUrl(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  return PNG.sync.read(Buffer.from(b64, "base64"));
}
function decode(png) {
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return r ? r.data : null;
}
const call = (fn, req) => new Promise((resolve) => {
  const res = {
    status(c) { this.code = c; return this; },
    json(b) { resolve({ code: this.code || 200, body: b }); },
  };
  fn(req, res);
});

(async () => {
  try {
    // ══ 1. THE DECODED CONTENTS, EXACTLY ════════════════════════════════════
    console.log("[1. the generated QR decodes to the founder-proven shape]");
    {
      const { dataUrl, upiString } = await generateUpiQr("testpalace@icici", "Crown Estate & Co");
      ok(upiString === "upi://pay?pa=testpalace@icici&pn=Crown%20Estate%20%26%20Co&cu=INR",
        "🔴 the payload is upi://pay?pa=…&pn=<url-encoded>&cu=INR, name spaces and & encoded");
      const png = pngOfDataUrl(dataUrl);
      const decoded = decode(png);
      ok(decoded === upiString, `🔴 the PIXELS decode to that exact string (${decoded && decoded.slice(0, 40)}…)`);
      ok(decoded === upiPayload("testpalace@icici", "Crown Estate & Co"), "…and match upiPayload — one encoder, no drift");

      // ══ 2. WHAT MAKES IT SCAN ON PAPER ════════════════════════════════════
      console.log("\n[2. print survival: resolution, quiet zone, black on white]");
      ok(png.width >= QR_WIDTH && png.height >= QR_WIDTH, `stored at ${png.width}px — ≈610dpi at the 25mm print size`);
      const px = (x, y) => { const i = (png.width * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]; };
      const corners = [[2, 2], [png.width - 3, 2], [2, png.height - 3], [png.width - 3, png.height - 3]];
      ok(corners.every(([x, y]) => { const [r, g, b] = px(x, y); return r === 255 && g === 255 && b === 255; }),
        "the quiet zone is white at every corner");
      let impure = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const v = png.data[i];
        if (!((v === 0 || v === 255) && png.data[i + 1] === v && png.data[i + 2] === v && png.data[i + 3] === 255)) impure++;
      }
      ok(impure === 0, "🔴 every pixel is pure opaque #000 or #FFF — no palette can have tinted it");

      // ══ 3. ERROR-CORRECTION HEADROOM ══════════════════════════════════════
      console.log("\n[3. EC Q: a damaged patch still decodes]");
      const dmg = pngOfDataUrl(dataUrl);
      const patch = Math.floor(dmg.width * 0.18); // ~3.2% of area, inside one quadrant
      for (let y = Math.floor(dmg.height * 0.55); y < Math.floor(dmg.height * 0.55) + patch; y++) {
        for (let x = Math.floor(dmg.width * 0.55); x < Math.floor(dmg.width * 0.55) + patch; x++) {
          const i = (dmg.width * y + x) << 2;
          dmg.data[i] = 0; dmg.data[i + 1] = 0; dmg.data[i + 2] = 0;
        }
      }
      ok(decode(dmg) === upiString, "a blacked-out patch (a fold, a toner void) does not kill the scan");
    }

    // ══ 4. UPLOAD VALIDATION ════════════════════════════════════════════════
    console.log("\n[4. the uploaded route's boundary]");
    {
      const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      ok(validateQrImageDataUrl(tinyPng).ok, "a small PNG data URL is accepted");
      ok(!validateQrImageDataUrl("data:text/html;base64,PGI+").ok, "a non-image is refused");
      ok(!validateQrImageDataUrl("https://example.com/qr.png").ok, "a bare URL is refused — bytes or nothing");
      const big = `data:image/png;base64,${"A".repeat(1_500_000)}`;
      ok(!validateQrImageDataUrl(big).ok, "an over-1MB image is refused");
    }

    // ══ 5. THE STORED QR FOLLOWS THE FACTS (DB flow through the controller) ══
    console.log("\n[5. save id → QR; change id → QR follows; rename → regenerates; clear → gone]");
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v` });
    const req = (body) => ({ params: { slug: venue.slug }, venueOwner: { venueId: venue._id }, body });
    const put = (body) => call(venueCtrl.updateVenue, req(body));

    await put({ bankDetails: { upiId: "one@icici" } });
    let v = await Venue.findById(venue._id).select("upiQr name").lean();
    ok(v.upiQr.source === "generated" && v.upiQr.upiString === `upi://pay?pa=one@icici&pn=${encodeURIComponent(v.name)}&cu=INR`,
      "saving a UPI ID generates and stores the QR");
    ok(decode(pngOfDataUrl(v.upiQr.dataUrl)) === v.upiQr.upiString, "🔴 the STORED image decodes to the stored upiString");

    await put({ bankDetails: { upiId: "two@okhdfcbank" } });
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(v.upiQr.upiString.includes("pa=two@okhdfcbank"), "changing the ID → the stored QR follows");
    ok(decode(pngOfDataUrl(v.upiQr.dataUrl)).includes("pa=two@okhdfcbank"), "…proven on the pixels, not the label");

    await put({ name: `${TAG} Renamed Palace` });
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(decode(pngOfDataUrl(v.upiQr.dataUrl)).includes(encodeURIComponent(`${TAG} Renamed Palace`)),
      "renaming the venue regenerates — the payload names the payee");

    // upload while an ID is set → refused (the provable QR wins)
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const up1 = await call(venueCtrl.uploadUpiQr, req({ image: tinyPng }));
    ok(up1.code === 400 && up1.body.code === "upi_id_generates", "upload while a UPI ID is set is refused, with the door named");

    await put({ bankDetails: { upiId: "" } });
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(v.upiQr.dataUrl === "" && v.upiQr.source === "" && v.upiQr.upiString === "",
      "🔴 clearing the ID clears a generated QR — nothing left behind");

    const up2 = await call(venueCtrl.uploadUpiQr, req({ image: tinyPng }));
    ok(up2.code === 200 && up2.body.upiQr.source === "uploaded", "with no ID, an upload stores");
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(v.upiQr.dataUrl === tinyPng && v.upiQr.upiString === "", "…same store, upiString honestly empty (we cannot know its contents)");

    // an uploaded QR survives an unrelated bankDetails save (no ID sent)
    await put({ bankDetails: { bankName: "HDFC Bank" } });
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(v.upiQr.source === "uploaded", "an unrelated billing save never clobbers an uploaded QR");

    const del = await call(venueCtrl.deleteUpiQr, req({}));
    v = await Venue.findById(venue._id).select("upiQr").lean();
    ok(del.code === 200 && v.upiQr.dataUrl === "" && v.upiQr.source === "", "delete clears the uploaded QR — nothing left behind");

    // delete against a GENERATED QR names the real door
    await put({ bankDetails: { upiId: "three@ybl" } });
    const del2 = await call(venueCtrl.deleteUpiQr, req({}));
    ok(del2.code === 400 && del2.body.code === "clear_upi_id_instead", "deleting a generated QR is refused — clear the ID instead");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try { await Venue.deleteMany({ slug: new RegExp(`^${TAG}`) }); } catch (_) { /* disposable */ }
    await mongoose.disconnect();
  }
})();
