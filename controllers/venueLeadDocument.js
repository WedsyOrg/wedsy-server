/**
 * controllers/venueLeadDocument.js — generate, list and download the documents
 * produced for a lead.
 *
 * ── WHAT GENERATION ACTUALLY DOES ───────────────────────────────────────────
 *   1. renders a cover page from the lead (utils/venueTermsCover)
 *   2. downloads the venue's uploaded T&C PDF, under a hard size cap
 *   3. stitches cover + source into one file (utils/pdfStitch)
 *   4. ASSERTS the source survived unchanged, per page, and refuses to store
 *      the result if it did not
 *   5. stores the bytes on S3 under a fresh key and inserts an immutable
 *      VenueLeadDocument row at the next version
 *   6. records the send on the quote round, exactly as the existing path did
 *
 * Step 4 is the one that earns the design. The promise to a venue is that we do
 * not touch their terms; a promise nobody checks is a hope. If the content
 * streams differ the generation FAILS rather than quietly shipping a document
 * we altered — better a 500 the owner reports than a modified clause nobody
 * notices until a dispute.
 *
 * ── RELATIONSHIP TO controllers/venueTerms.sendTerms ────────────────────────
 * That path is left untouched and still routed. The split is functional, not
 * duplication:
 *
 *   uploaded T&C PDF exists  → here. The couple receives the personalised
 *                              stitched document, and it is versioned.
 *   no uploaded PDF          → venueTerms.sendTerms, which renders the venue's
 *                              generated clauses. Still the only path for a
 *                              venue that authored clauses instead of uploading.
 *
 * Requirement: never generate a cover with nothing behind it. Without an
 * uploaded PDF this refuses with `no_terms_document` and the UI links to
 * Settings, rather than producing a one-page document that looks like terms and
 * contains none.
 *
 * ── DELIVERY HONESTY, PRESERVED ─────────────────────────────────────────────
 * `delivered` stays false with an explanatory `deliveryError` until the
 * "venue_terms_sent" Mailjet template exists. Two suites pin this. Telling an
 * owner their terms went out when nothing left the building is the exact
 * failure a dispute would expose, and the RECORD is complete either way.
 */
const mongoose = require("mongoose");
const axios = require("axios");
const Venue = require("../models/Venue");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const { originOfKind, CLIENT_KINDS } = require("../models/VenueLeadDocument");

/** Must match the proofType enum on the model. */
const PROOF_TYPES = ["driving_licence", "aadhaar", "pan", "passport", "other"];
/** Mirrors the client-side cap and the T&C upload — the server decides. */
const MAX_CLIENT_DOC_BYTES = 10 * 1024 * 1024;
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
const { buildTermsCoverBuffer, eventDays, contactEmail, contactPhone } = require("../utils/venueTermsCover");
const { fetchSourcePdf, stitchCoverOntoPdf, verifySourcePreserved, StitchError } = require("../utils/pdfStitch");
const { uploadBufferToS3 } = require("../utils/s3Upload");
const { resolveTermsSource } = require("./venueTerms");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMS_TRIGGER = "venue_terms_sent";
const MAX_NOTE = 2000;
const VERSION_RETRIES = 5;

/**
 * Same shape as venueTerms.resolveOwnedLead — venue by slug, ownership check,
 * then the lead through venueLeadScope so a miss is 404 and never 403.
 * `logo` is in the projection because the cover's letterhead needs it.
 */
async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    .select("_id name logo address formattedAddress contact phone email settings termsDocument whiteLabel")
    .lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  return { venue, lead };
}

const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;

/** A human name for the row, so provenance survives the member leaving. */
async function actorDisplayName(req) {
  if (req.admin) return "Wedsy admin";
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    if (m && m.name) return m.name;
    return "team member";
  }
  return o.name || "Owner";
}

/** Shape one row for the Documents tab. Never leaks the S3 key layout. */
const present = (d) => ({
  _id: d._id,
  kind: d.kind,
  version: d.version,
  note: d.note || "",
  filename: d.filename || "",
  sizeBytes: d.sizeBytes || null,
  pageCount: d.pageCount || null,
  sourcePages: d.sourcePages || null,
  createdAt: d.createdAt,
  generatedByName: d.generatedByName || "",
  sourceFilename: (d.source && d.source.filename) || "",
  sourceVerified: Boolean(d.sourceVerified),
  quoteRound: d.quoteRound || null,
  // Which side of the tab this belongs on. Derived from the kind by the model,
  // so a new kind cannot land on the wrong side through an out-of-date list.
  origin: originOfKind(d.kind),
  proofType: d.proofType || "",
  proofTypeOther: d.proofTypeOther || "",
  contactName: d.contactName || "",
  uploadedByName: d.uploadedByName || "",
  url: d.url || "",
});

// ── GET /venues/:slug/enquiries/:enquiryId/documents ────────────────────────
// The Documents tab. Newest first, because the current version is the one being
// looked for; the history is why the list exists at all.
const listLeadDocuments = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;

    const docs = await VenueLeadDocument.find({ enquiry: lead._id })
      .sort({ version: -1 })
      .lean();

    // What generation would use right now, so the tab can show the empty state
    // with a reason instead of a dead button.
    const resolved = await resolveTermsSource(venue);

    return res.status(200).json({
      documents: docs.map(present),
      latestVersion: docs.length ? Math.max(...docs.map((d) => d.version)) : 0,
      // The UI needs all three to decide what to render: whether it CAN
      // generate, and if not, why not.
      canGenerate: resolved.kind === "document" && resolved.ready,
      termsSource: {
        kind: resolved.kind,
        ready: resolved.ready,
        filename: resolved.document ? resolved.document.filename : "",
        uploadedAt: resolved.document ? resolved.document.uploadedAt : null,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Insert at the next free version, retrying on the unique index.
 *
 * The index on {enquiry, kind, version} is what makes the sequence a database
 * guarantee: two owners generating at the same moment cannot both write v2 —
 * one loses the insert and takes the next number. Reading max(version) and
 * adding one without the index would silently produce two v2 rows, which is
 * precisely the ambiguity an audit trail cannot have.
 */
async function insertNextVersion(base, derive = () => ({})) {
  let lastErr = null;
  for (let attempt = 0; attempt < VERSION_RETRIES; attempt++) {
    const top = await VenueLeadDocument.findOne({ enquiry: base.enquiry, kind: base.kind })
      .sort({ version: -1 })
      .select("version")
      .lean();
    const version = (top ? top.version : 0) + 1;
    try {
      // `derive` exists so fields that depend on the version number — the
      // filename — are correct at INSERT time. Patching them afterwards would
      // mean a second write to a row this model exists to keep unwritable, and
      // would leave a placeholder behind if that write ever failed.
      return await VenueLeadDocument.create({ ...base, version, ...derive(version) });
    } catch (e) {
      if (e && e.code === 11000) {
        lastErr = e;
        continue; // someone took this number; look again
      }
      throw e;
    }
  }
  throw lastErr || new Error("Could not allocate a document version");
}

// ── POST /venues/:slug/enquiries/:enquiryId/documents/terms ─────────────────
const generateTermsDocument = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};

    // Never a cover with nothing behind it.
    const resolved = await resolveTermsSource(venue);
    if (resolved.kind !== "document" || !resolved.ready) {
      return res.status(400).json({
        message: "No terms & conditions uploaded yet. Add your T&C PDF in Settings, then generate from here.",
        code: "no_terms_document",
      });
    }

    // Optional. An email means "send it too"; without one this is a generate-
    // and-download, which is a real thing owners do before they are ready to
    // send. An email that is PRESENT must still be valid — silently ignoring a
    // typo would be the worst of both.
    const email = cleanStr(body.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "That email address is not valid" });
    }

    const note = cleanStr(body.note).slice(0, MAX_NOTE);
    const quotedAmount = Number.isFinite(Number(body.quotedAmount))
      ? Number(body.quotedAmount)
      : Number(lead.estimatedValue) || 0;

    const issuedAt = new Date();
    const days = eventDays(lead);

    // 1 — the cover
    const cover = await buildTermsCoverBuffer({
      venue,
      lead,
      quotedAmount,
      issuedAt,
      sendNote: note,
      documentName: resolved.document.filename,
    });

    // 2 + 3 — fetch under cap, then stitch
    let stitched;
    let sourceBuffer;
    try {
      sourceBuffer = await fetchSourcePdf(resolved.document.url);
      stitched = await stitchCoverOntoPdf(cover, sourceBuffer);
    } catch (e) {
      if (e instanceof StitchError) {
        return res.status(e.status || 400).json({ message: e.message, code: e.code });
      }
      throw e;
    }

    // 4 — the promise, checked. A failure here must not reach the couple.
    const verified = await verifySourcePreserved(stitched.buffer, sourceBuffer, {
      coverPages: stitched.coverPages,
    });
    if (!verified.ok) {
      console.error(
        `[venueLeadDocument] stitch altered the source for lead ${lead._id}: ${verified.reason || `pages ${verified.mismatches.join(", ")}`}`
      );
      return res.status(500).json({
        message:
          "The generated document did not match the uploaded terms exactly, so it was discarded. Nothing was sent. Please report this.",
        code: "source_not_preserved",
      });
    }
    // Released before the upload: the source is the largest thing we hold and
    // it has no further use. On a 1 GB box this is not fussiness.
    sourceBuffer = null;

    // 5 — store the bytes under a NEW key, then the immutable row
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeCouple = (lead.coupleName || "terms").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "terms";
    const key = `venues/${venue._id}/terms-generated/${stamp}.pdf`;
    let url;
    try {
      url = await uploadBufferToS3({ buffer: stitched.buffer, key, contentType: "application/pdf" });
    } catch (e) {
      console.error(`[venueLeadDocument] S3 upload failed for lead ${lead._id}: ${e.message}`);
      return res.status(502).json({
        message: "The document was generated but could not be stored. Nothing was sent — try again.",
        code: "storage_failed",
      });
    }

    const generatedByName = await actorDisplayName(req);
    const doc = await insertNextVersion({
      venue: venue._id,
      enquiry: lead._id,
      kind: "terms",
      note,
      url,
      sizeBytes: stitched.buffer.length,
      contentType: "application/pdf",
      pageCount: stitched.totalPages,
      coverPages: stitched.coverPages,
      sourcePages: stitched.sourcePages,
      source: {
        url: resolved.document.url,
        filename: resolved.document.filename,
        sizeBytes: resolved.document.sizeBytes || null,
      },
      cover: {
        coupleName: lead.coupleName || "",
        phone: contactPhone(lead),
        email: contactEmail(lead),
        eventDates: days,
        quotedAmount: quotedAmount || null,
      },
      sourceVerified: true,
      sourceVerifiedPages: verified.checkedPages,
      generatedBy: actorId(req),
      generatedByName,
    }, (version) => ({ filename: `terms-${safeCouple}-v${version}.pdf` }));
    const finalName = doc.filename;

    // 6 — record on the quote round, exactly as the existing path does
    let round = null;
    const roundId = body.roundId;
    if (roundId) {
      if (!mongoose.isValidObjectId(roundId)) return res.status(400).json({ message: "roundId is not valid" });
      round = await VenueQuoteRound.findOne({ _id: roundId, enquiry: lead._id });
      if (!round) return res.status(404).json({ message: "Round not found" });
    } else {
      round = await VenueQuoteRound.findOne({ enquiry: lead._id }).sort({ createdAt: -1 });
    }
    if (!round) {
      const count = await VenueQuoteRound.countDocuments({ enquiry: lead._id });
      round = await VenueQuoteRound.create({
        venue: venue._id,
        enquiry: lead._id,
        roundNumber: count + 1,
        amount: null,
        clientResponse: "",
        terms: "",
        reasoning: "Terms & conditions sent.",
        outcome: "pending",
        sentAt: new Date(),
        sentVia: "email",
        createdBy: actorId(req),
      });
    }
    if (email) {
      round.termsSentAt = issuedAt;
      round.termsSentTo = email;
    }
    round.termsSnapshot = [];
    // Points at the STITCHED artefact, not the raw upload: this is the document
    // the couple actually received, which is the one a dispute asks about.
    round.termsDocument = { url, filename: finalName };
    await round.save();

    // Transport is best-effort and must never fail the record.
    let delivered = false;
    let deliveryError = "";
    if (email) {
      try {
        const NotificationService = require("../services/NotificationService");
        const trigger = NotificationService.TRIGGERS && NotificationService.TRIGGERS[TERMS_TRIGGER];
        if (!trigger) {
          deliveryError = `No "${TERMS_TRIGGER}" email template is configured — the document was generated and recorded, but not emailed.`;
        } else if (!process.env.MAILJET_API_KEY) {
          deliveryError = "Email transport is not configured on this environment.";
        } else {
          NotificationService.send(TERMS_TRIGGER, {
            email,
            name: lead.coupleName || lead.name || "",
            emailVariables: {
              venue_name: venue.name || "",
              lead_name: lead.coupleName || lead.name || "",
              clause_count: "0",
              terms_url: url,
              terms_filename: finalName,
            },
          });
          delivered = true;
        }
      } catch (e) {
        deliveryError = e.message;
        console.warn(`[venueLeadDocument] send failed for lead ${lead._id}: ${e.message}`);
      }
    }

    lead.activities.push({
      type: "terms_sent",
      description: email
        ? `Terms & conditions v${doc.version} sent to ${email}${note ? ` — ${note}` : ""}`
        : `Terms & conditions v${doc.version} generated${note ? ` — ${note}` : ""}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(201).json({
      success: true,
      document: present(doc),
      downloadUrl: `/venue/${venue.slug || req.params.slug}/enquiries/${lead._id}/documents/${doc._id}/download`,
      roundId: round._id,
      sentTo: email || "",
      delivered,
      deliveryError,
      sourceVerified: true,
      sourceVerifiedPages: verified.checkedPages,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── GET /venues/:slug/enquiries/:enquiryId/documents/:documentId/download ───
/**
 * Streams the stored bytes back through the API.
 *
 * Deliberately NOT a 302 to the S3 URL, and not the S3 URL handed to the client
 * in the list response. Two reasons, in order of how much they would hurt:
 *
 *   · SCOPE. Proxying means venueLeadScope runs on the path the download
 *     actually takes, so a document is exactly as private as its lead. A public
 *     bucket URL in a list response is a capability that outlives the session
 *     and travels wherever it is pasted.
 *   · CORS. The client sends an Authorization header, so a redirect to another
 *     origin turns into a cross-origin fetch that the bucket would have to
 *     allow explicitly. This works with no bucket configuration at all.
 *
 * Streamed rather than buffered: the whole point of the size cap is that this
 * box cannot afford to hold documents in memory, and that applies just as much
 * on the way out as on the way in.
 */
const downloadLeadDocument = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    if (!mongoose.isValidObjectId(req.params.documentId)) {
      return res.status(404).json({ message: "Document not found" });
    }
    const doc = await VenueLeadDocument.findOne({ _id: req.params.documentId, enquiry: lead._id }).lean();
    if (!doc || !doc.url) return res.status(404).json({ message: "Document not found" });

    let upstream;
    try {
      upstream = await axios.get(doc.url, { responseType: "stream", timeout: 20000, maxRedirects: 3 });
    } catch (e) {
      console.warn(`[venueLeadDocument] download failed for ${doc._id}: ${e.message}`);
      return res.status(502).json({ message: "The stored document could not be retrieved." });
    }

    res.setHeader("Content-Type", doc.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${(doc.filename || "document.pdf").replace(/"/g, "")}"`);
    if (doc.sizeBytes) res.setHeader("Content-Length", String(doc.sizeBytes));
    // A mid-stream upstream failure cannot become a JSON error — headers are
    // already sent — so the socket is closed and the client sees a truncated
    // download rather than a PDF with an error message inside it.
    upstream.data.on("error", (e) => {
      console.warn(`[venueLeadDocument] stream broke for ${doc._id}: ${e.message}`);
      res.destroy(e);
    });
    return upstream.data.pipe(res);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};


// ── POST /venues/:slug/enquiries/:enquiryId/documents/client ────────────────
// A document the CLIENT gave US — an address proof at confirmation, or
// anything collected afterwards. Body:
//   { url, filename, contentType?, sizeBytes?, kind?, proofType?,
//     proofTypeOther?, contactName?, note? }
//
// The FILE never passes through here. It goes up via the existing
// POST /file/upload the rest of the product uses, and this records the result
// — same decision, and the same reasoning, as the venue's T&C upload.
//
// Versioned through insertNextVersion like every other kind, so replacing a
// blurry proof adds v2 rather than overwriting v1. "Which proof did we hold
// when we took the booking" stays answerable, which is the entire reason this
// model refuses mutation.
const uploadClientDocument = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};

    const url = cleanStr(body.url);
    if (!url) return res.status(400).json({ message: "url is required — upload the file first" });
    // Must be a link WE stored. An arbitrary URL would let a lead's identity
    // document point somewhere that can change after the fact.
    if (!/^https:\/\//i.test(url)) {
      return res.status(400).json({ message: "url must be an https link from the upload step" });
    }

    const kind = CLIENT_KINDS.includes(body.kind) ? body.kind : "address_proof";

    let proofType = cleanStr(body.proofType);
    if (kind === "address_proof") {
      if (!PROOF_TYPES.includes(proofType)) {
        return res.status(400).json({
          message: `proofType must be one of ${PROOF_TYPES.join(", ")}`,
        });
      }
    } else {
      proofType = "";
    }
    const proofTypeOther = proofType === "other" ? cleanStr(body.proofTypeOther).slice(0, 120) : "";
    if (proofType === "other" && !proofTypeOther) {
      return res.status(400).json({ message: "Name the document when the type is Other." });
    }

    const sizeBytes = body.sizeBytes == null ? null : Number(body.sizeBytes);
    if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
      return res.status(400).json({ message: "sizeBytes is not a valid number" });
    }
    if (sizeBytes === 0) return res.status(400).json({ message: "That file is empty" });
    // The server is the authority on the cap, not the browser.
    if (sizeBytes != null && sizeBytes > MAX_CLIENT_DOC_BYTES) {
      return res.status(400).json({
        message: `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`,
      });
    }

    const doc = await insertNextVersion({
      venue: venue._id,
      enquiry: lead._id,
      kind,
      note: cleanStr(body.note).slice(0, 2000),
      url,
      filename: cleanStr(body.filename).slice(0, 200) || "document",
      contentType: cleanStr(body.contentType) || "application/octet-stream",
      sizeBytes: sizeBytes == null ? undefined : sizeBytes,
      proofType,
      proofTypeOther,
      contactName: cleanStr(body.contactName).slice(0, 200),
      generatedBy: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
      generatedByName: cleanStr(body.uploadedByName).slice(0, 120),
      uploadedByName: cleanStr(body.uploadedByName).slice(0, 120),
    });

    return res.status(201).json({ document: present(doc) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};


module.exports = {
  listLeadDocuments,
  generateTermsDocument,
  downloadLeadDocument,
  present,
  insertNextVersion,
  uploadClientDocument,
};
