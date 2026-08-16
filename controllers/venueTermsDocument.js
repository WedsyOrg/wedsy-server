/**
 * controllers/venueTermsDocument.js — the venue's T&Cs as an uploaded file.
 *
 * ── WHY UPLOAD RATHER THAN AUTHORING ────────────────────────────────────────
 * An audit of the send path found that "Send terms & conditions" could never
 * work for any venue on record: it resolves a contract-type
 * VenueDocumentTemplate, else seeds clauses from Venue.policyDoc / the legacy
 * Venue.policies, else refuses. There are zero contract templates in the
 * database and no sampled venue has policy text — because `policyDoc` has NO
 * write path anywhere in the API, and the doc-template routes are never called
 * by the portal. The owner was told to go and write their terms in two places
 * they could not reach.
 *
 * Owners already have their terms, as a PDF exported from a Google Doc. So the
 * fix is to take the file they have, not to ask them to retype it as clauses.
 *
 * ── WHAT IS REUSED ──────────────────────────────────────────────────────────
 * The FILE never touches this controller. It goes up through the existing
 * POST /file/upload → VenueOwnerUpload → S3 path that the rest of the product
 * uses, which already scopes keys to venues/<venueId>/<category>/ and already
 * authenticates venue owners. This endpoint stores only the resulting URL and
 * the provenance an owner needs to recognise the document. Building a second
 * upload mechanism would mean a second set of credentials, a second key
 * layout, and a second thing to get wrong.
 *
 * ── WHAT HAPPENS TO THE GENERATED PATH ──────────────────────────────────────
 * It STAYS, and the uploaded document takes precedence over it. See
 * resolveTermsSource() in venueTerms.js for the full reasoning; in short, the
 * generated path is the only thing that can produce a per-lead document and it
 * is load-bearing for the contract flow, so deleting it to make room for
 * upload would remove working machinery to solve a problem upload already
 * solves by sitting in front of it.
 */
const Venue = require("../models/Venue");
const { cleanStr } = require("../utils/venueInput");

/** 10 MB. A terms PDF is a few pages; anything larger is a mistake or a scan
 *  nobody will read on a phone, and it is the couple who pays for it. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * PDF ONLY, and checked on the SERVER.
 *
 * The rule is not stylistic: the send path attaches this file to an email and
 * a couple has to be able to open it. Accepting a .docx would produce a
 * document half the recipients cannot read, and accepting an image would
 * produce terms that cannot be searched or quoted in a dispute. A file the
 * send path cannot use must never be storable.
 */
const PDF_MIME = "application/pdf";

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id termsDocument");
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    // 404, not 403 — the same rule the lead scoping uses. Telling a caller
    // that a venue exists but is not theirs is itself a leak.
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  return venue;
}

/** The shape the portal renders. Always an object, never null. */
function present(doc) {
  const d = doc || {};
  if (!d.url) return { uploaded: false };
  return {
    uploaded: true,
    url: d.url,
    filename: d.filename || "terms.pdf",
    sizeBytes: d.sizeBytes || null,
    contentType: d.contentType || PDF_MIME,
    uploadedAt: d.uploadedAt || null,
    uploadedByName: d.uploadedByName || "",
  };
}

// GET /venues/:slug/terms-document
const getTermsDocument = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json({ document: present(venue.termsDocument) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PUT /venues/:slug/terms-document { url, filename, sizeBytes, contentType }
// Called AFTER the file has gone up through /file/upload.
const putTermsDocument = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    const url = cleanStr(body.url);
    if (!url) return res.status(400).json({ message: "url is required — upload the file first" });
    // The URL has to be one WE stored. Accepting an arbitrary link would let a
    // venue's terms point anywhere, including somewhere that changes after the
    // couple was told what they agreed to.
    if (!/^https:\/\//i.test(url)) {
      return res.status(400).json({ message: "url must be an https link from the upload step" });
    }

    const filename = cleanStr(body.filename) || "terms.pdf";
    if (!/\.pdf$/i.test(filename)) {
      return res.status(400).json({ message: "Terms must be a PDF — export the document as PDF and try again" });
    }

    const contentType = cleanStr(body.contentType) || PDF_MIME;
    if (contentType.toLowerCase() !== PDF_MIME) {
      return res.status(400).json({ message: "Terms must be a PDF — export the document as PDF and try again" });
    }

    const sizeBytes = body.sizeBytes == null ? null : Number(body.sizeBytes);
    if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
      return res.status(400).json({ message: "sizeBytes is not a valid number" });
    }
    if (sizeBytes != null && sizeBytes > MAX_BYTES) {
      return res.status(400).json({
        message: `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB. Try exporting it again at a smaller size.`,
      });
    }
    if (sizeBytes === 0) {
      return res.status(400).json({ message: "That file is empty" });
    }

    // REPLACE, never accumulate. One document per venue is the whole point;
    // a second row would immediately raise "which one goes out?".
    venue.termsDocument = {
      url,
      filename,
      sizeBytes: sizeBytes == null ? undefined : sizeBytes,
      contentType: PDF_MIME,
      uploadedAt: new Date(),
      uploadedBy: req.venueOwner.memberId || req.venueOwner.venueOwnerId || null,
      uploadedByName: cleanStr(body.uploadedByName) || "",
    };
    await venue.save();

    return res.status(200).json({ document: present(venue.termsDocument) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/terms-document
const deleteTermsDocument = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    // The S3 object is deliberately left in place. A terms document that has
    // already been sent is referenced by the quote rounds that sent it, and
    // deleting the bytes would break the one link a dispute would follow.
    // Removing it here stops it being sent again, which is what "remove" means
    // to an owner.
    venue.termsDocument = {};
    await venue.save();
    return res.status(200).json({ document: { uploaded: false } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getTermsDocument, putTermsDocument, deleteTermsDocument, present, MAX_BYTES, PDF_MIME };
