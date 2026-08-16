/**
 * controllers/venueTerms.js — terms & conditions, generated per lead.
 *
 * ── WHAT THE DOCUMENT-ENGINE AUDIT FOUND, AND WHAT IS REUSED ────────────────
 * The MB-V1 (D8) engine already had almost all of this:
 *
 *   models/VenueDocumentTemplate   an owner-authored preset with `sections`
 *                                  (heading + clauses) and a reusable `terms`
 *                                  block. REUSED as the source of truth for
 *                                  what a venue's T&Cs actually say.
 *   controllers/venueContract.js   effectivePolicyDoc() + seedSections() —
 *                                  clause seeding from Venue.policyDoc with the
 *                                  legacy venue.policies fallback and its
 *                                  read-time migration rules. REUSED verbatim
 *                                  (exported from there rather than copied, so
 *                                  the two can never drift).
 *   utils/venuePdf.js              startDoc / venueHeader / poweredByFooter and
 *                                  the numbered-clause rendering used by
 *                                  streamContractPdf. REUSED via a new
 *                                  streamTermsPdf built from the same parts.
 *   services/NotificationService   Mailjet transport. REUSED for the send.
 *
 * ── WHAT COULD NOT BE REUSED, AND WHY ───────────────────────────────────────
 * models/VenueContract is BOOKING-scoped — `booking` is required. T&Cs go out
 * during a negotiation, before any booking exists, so a contract row cannot
 * represent this send. Rather than loosening a model that other code trusts to
 * always have a booking, the send is recorded on the QUOTE ROUND, which is the
 * thing it actually belongs to: the thread is what shows they were informed,
 * which is the point if a dispute follows.
 *
 * ── WHY THE SNAPSHOT IS FROZEN ──────────────────────────────────────────────
 * The round stores the clause text as sent. "Which terms did they get?" cannot
 * be answered by re-reading a template that has been edited since — and that
 * question is exactly the one a dispute asks.
 *
 * WhatsApp is deliberately NOT wired here. The brief allows it only via the
 * Meta Cloud API, and a T&C document is an email artefact; adding a second
 * channel for it now would be scope nobody asked to maintain.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueDocumentTemplate = require("../models/VenueDocumentTemplate");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { seedSections } = require("./venueContract");
const { cleanStr } = require("../utils/venueInput");
const { streamTermsPdf } = require("../utils/venuePdf");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The NotificationService trigger this send would use. It does not exist in
// TRIGGERS yet — a Mailjet template has to be created for it — so the code
// reports honestly rather than pretending the email went.
const TERMS_TRIGGER = "venue_terms_sent";

async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    // termsDocument is what resolveTermsSource() checks FIRST — leaving it out
    // of the projection made every venue look like it had no uploaded terms.
    .select("_id name policies policyDoc settings termsDocument")
    .lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) { res.status(404).json({ message: "Lead not found" }); return null; }
  return { venue, lead };
}

/**
 * The clauses this venue would send today.
 *
 * PRECEDENCE: an explicit "contract"-type document template wins, because that
 * is the thing an owner deliberately authored. Otherwise the policyDoc seeding
 * the contract flow already uses. Never a static uploaded file — the whole
 * point is that this is generated per lead from the venue's own current text.
 */
async function resolveTermsSections(venue) {
  const template = await VenueDocumentTemplate.findOne({ venue: venue._id, type: "contract" })
    .sort({ updatedAt: -1 })
    .select("name sections terms")
    .lean();

  if (template && (template.sections || []).some((s) => (s.clauses || []).length)) {
    const sections = (template.sections || []).filter((s) => (s.clauses || []).length);
    if ((template.terms || []).length) {
      sections.push({ heading: "Terms & Conditions", clauses: template.terms });
    }
    return { sections, source: "template", templateName: template.name || "" };
  }
  // seedSections is imported from the contract controller rather than copied,
  // so the two can never disagree about what a venue's policies say.
  const seeded = seedSections(venue);
  return { sections: seeded, source: seeded.length ? "policy_doc" : "empty", templateName: "" };
}

/**
 * WHAT THIS VENUE WOULD ACTUALLY SEND — the uploaded PDF, or generated clauses.
 *
 * THE UPLOADED DOCUMENT WINS, and the generated path STAYS. Both halves of
 * that are deliberate:
 *
 * Upload wins because it is the venue's real terms. An owner who has uploaded
 * their signed-off PDF has said, unambiguously, "this is what we send" — and
 * silently mailing our generated approximation instead would be the worst kind
 * of wrong: confidently, invisibly, and only discovered in a dispute.
 *
 * The generated path stays because deleting it would remove working machinery
 * to solve a problem upload already solves by sitting in front of it. It is
 * the ONLY thing that can produce a per-lead document — clauses seeded from
 * the venue's policies and frozen against a specific negotiation — and it is
 * load-bearing elsewhere: controllers/venueContract.js generates booking
 * contracts from the same seedSections(), so the clause machinery cannot be
 * removed without taking the contract flow with it. A venue that later wants
 * per-lead clauses simply removes its uploaded PDF and the old behaviour is
 * back, unchanged.
 */
async function resolveTermsSource(venue) {
  const doc = venue.termsDocument || {};
  if (doc.url) {
    return {
      kind: "document",
      document: {
        url: doc.url,
        filename: doc.filename || "terms.pdf",
        sizeBytes: doc.sizeBytes || null,
        uploadedAt: doc.uploadedAt || null,
      },
      sections: [],
      clauseCount: 0,
      source: "uploaded",
      templateName: "",
      ready: true,
    };
  }
  const { sections, source, templateName } = await resolveTermsSections(venue);
  const clauseCount = sections.reduce((n, s) => n + (s.clauses || []).length, 0);
  return { kind: "generated", document: null, sections, clauseCount, source, templateName, ready: clauseCount > 0 };
}

// GET /venues/:slug/enquiries/:enquiryId/terms/preview
// What would be sent, so nobody emails a document they have not read.
const previewTerms = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const resolved = await resolveTermsSource(owned.venue);
    const { sections, source, templateName, clauseCount } = resolved;

    // Contacts with an email are who this can go to — contacts carry email as
    // of BUILD A, so the picker has real options rather than a free-text box.
    const recipients = (owned.lead.contacts || [])
      .filter((c) => c.email && EMAIL_RE.test(c.email))
      .map((c) => ({ name: c.name || "", email: c.email, relation: c.relation || "other", isPrimary: Boolean(c.isPrimary) }));

    return res.status(200).json({
      sections,
      clauseCount,
      source,
      templateName,
      recipients,
      // What the couple would actually receive, so the portal can name it
      // rather than describing clauses that are not being sent.
      kind: resolved.kind,
      document: resolved.document,
      // An honest empty state beats an empty PDF: a venue with neither an
      // uploaded document nor written policies has nothing to send.
      ready: resolved.ready,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/enquiries/:enquiryId/terms/send { email, roundId? }
const sendTerms = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const email = cleanStr((req.body || {}).email).toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "A valid email address is required" });
    }

    const resolved = await resolveTermsSource(venue);
    const { sections, source, clauseCount } = resolved;
    if (!resolved.ready) {
      // Says the ONE thing an owner can act on, and names where. The old
      // message pointed at document templates and venue policies — neither of
      // which the portal can reach — so it read as a dead end.
      return res.status(400).json({
        message: "No terms & conditions uploaded yet. Add your T&C PDF in Settings, then send it from here.",
        code: "no_terms_document",
      });
    }

    // Attach to a round: the one named, else the latest, else a new round that
    // records the send on its own. A T&C send is a move in the negotiation and
    // the thread is where moves live.
    let round = null;
    const roundId = (req.body || {}).roundId;
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
        // A send-only round still needs to satisfy the "amount or response"
        // rule at the model level, so it carries its own explanation.
        reasoning: "Terms & conditions sent.",
        outcome: "pending",
        sentAt: new Date(),
        sentVia: "email",
        createdBy: req.venueOwner.memberId || req.venueOwner.venueOwnerId || null,
      });
    }

    round.termsSentAt = new Date();
    round.termsSentTo = email;
    // FROZEN. See the header. For an uploaded PDF the snapshot is the pointer
    // and the filename as sent — the bytes on S3 are never rewritten, and the
    // document is deliberately not deleted from storage when an owner removes
    // it, so this link keeps resolving for exactly the dispute it exists for.
    round.termsSnapshot = sections;
    if (resolved.kind === "document") {
      round.termsDocument = {
        url: resolved.document.url,
        filename: resolved.document.filename,
      };
    }
    await round.save();

    // Transport is best-effort and must never fail the record: the fact that
    // terms were sent is the thing that matters in a dispute, and losing that
    // because Mailjet was down would be the worst possible trade.
    let delivered = false;
    let deliveryError = "";
    try {
      const NotificationService = require("../services/NotificationService");
      const trigger = NotificationService.TRIGGERS && NotificationService.TRIGGERS[TERMS_TRIGGER];
      if (!trigger) {
        // Said out loud rather than reported as a successful send. The
        // NotificationService no-ops on an unknown trigger, so claiming
        // delivery here would tell an owner their terms went out when nothing
        // left the building — the exact failure a dispute would expose.
        // The Mailjet template for this trigger has to be created in the
        // Mailjet account before the email can go; the RECORD is complete
        // either way, which is what the thread and any dispute rely on.
        deliveryError = `No "${TERMS_TRIGGER}" email template is configured — the send was recorded but not emailed.`;
      } else if (!process.env.MAILJET_API_KEY) {
        deliveryError = "Email transport is not configured on this environment.";
      } else {
        NotificationService.send(TERMS_TRIGGER, {
          email,
          name: lead.coupleName || lead.name || "",
          emailVariables: {
            venue_name: venue.name || "",
            lead_name: lead.coupleName || lead.name || "",
            clause_count: String(clauseCount),
            // The attachment the couple actually opens. Empty for the
            // generated path, which renders its clauses in the body.
            terms_url: resolved.kind === "document" ? resolved.document.url : "",
            terms_filename: resolved.kind === "document" ? resolved.document.filename : "",
          },
        });
        delivered = true;
      }
    } catch (e) {
      deliveryError = e.message;
      console.warn(`[venueTerms] send failed for lead ${lead._id}: ${e.message}`);
    }

    lead.activities.push({
      type: "terms_sent",
      description:
        resolved.kind === "document"
          ? `Terms & conditions (${resolved.document.filename}) sent to ${email}`
          : `Terms & conditions sent to ${email}`,
      actor: req.venueOwner.memberId || req.venueOwner.venueOwnerId || null,
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(200).json({
      success: true,
      roundId: round._id,
      sentTo: email,
      clauseCount,
      source,
      kind: resolved.kind,
      document: resolved.document,
      // Said plainly rather than implied — "recorded but not emailed" is a
      // different state from "emailed", and the owner needs to know which.
      delivered,
      deliveryError,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/enquiries/:enquiryId/terms/pdf
// What was (or would be) sent, on paper. Renders the FROZEN snapshot when a
// send has happened, so downloading it later shows what they actually got
// rather than what the template says today.
const termsPdf = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;

    let sections = null;
    let sentAt = null;
    const sent = await VenueQuoteRound.findOne({ enquiry: lead._id, termsSentAt: { $ne: null } })
      .sort({ termsSentAt: -1 })
      .select("termsSnapshot termsSentAt")
      .lean();
    if (sent && (sent.termsSnapshot || []).length) {
      sections = sent.termsSnapshot;
      sentAt = sent.termsSentAt;
    } else {
      sections = (await resolveTermsSections(venue)).sections;
    }
    if (!sections.length) {
      return res.status(400).json({ message: "This venue has no terms written yet." });
    }
    // Needs the logo, which resolveOwnedLead does not select.
    const full = await Venue.findById(venue._id).select("name logo").lean();
    return streamTermsPdf(res, { venue: { ...venue, ...full }, lead, sections, sentAt });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { previewTerms, sendTerms, termsPdf, resolveTermsSections, resolveTermsSource };
