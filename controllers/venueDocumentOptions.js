/**
 * controllers/venueDocumentOptions.js — what the generate box can make, and
 * what each kind asks for. ONE endpoint, so the box renders the server's
 * truth rather than six client-side guesses.
 *
 * THE RULING (Rohaan): unavailable kinds are PICKABLE AND REFUSE WITH AN
 * EXPLANATION. Nothing is hidden and nothing is greyed out — you cannot
 * invoice before a booking exists, receipt a payment that is not there, or
 * statement a lead with no money, and each of those sentences is returned
 * here so the box can say it. An owner learns what the product does from
 * being told, not from an absence.
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const { isId } = require("../utils/objectId");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");

// GET /venues/:slug/enquiries/:enquiryId/document-options
const documentOptions = async (req, res) => {
  try {
    const venue = await Venue.findOne({ slug: req.params.slug })
      .select("_id slug gstin termsDocument cancellationPolicy settings")
      .lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) return res.status(403).json({ message: "Forbidden" });
    if (!isId(req.params.enquiryId)) return res.status(404).json({ message: "Lead not found" });
    const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId, { lean: true });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const [quotes, booking, invoices, latestDocs] = await Promise.all([
      VenueQuote.find({ venue: venue._id, enquiry: lead._id })
        .sort({ version: -1 })
        .select("version status totals.grandTotal tokenAmount validUntil updatedAt")
        .lean(),
      VenueBooking.findOne({ enquiry: lead._id }).lean(),
      VenueInvoice.find({ enquiry: lead._id }).select("invoiceNumber forMilestoneId forPaymentId stream totals.grandTotal totals.taxable").lean(),
      VenueLeadDocument.aggregate([
        { $match: { enquiry: lead._id } },
        { $sort: { version: -1 } },
        { $group: { _id: "$kind", docNotes: { $first: "$docNotes" } } },
      ]),
    ]);

    // ── notes carry-forward, per kind, for the editor to pre-fill ───────────
    const notesByKind = {};
    for (const row of latestDocs) {
      if (row.docNotes && Array.isArray(row.docNotes.lines) && row.docNotes.lines.length) {
        notesByKind[row._id] = { numbered: Boolean(row.docNotes.numbered), lines: row.docNotes.lines };
      }
    }

    // ── payments, grouped exactly as the Payments tab groups them ───────────
    const paymentsById = new Map();
    for (const row of (booking && booking.paymentSchedule) || []) {
      for (const e of row.entries || []) {
        if ((e.status || "approved") !== "approved" || !e.paymentId) continue;
        const key = String(e.paymentId);
        const at = paymentsById.get(key);
        if (at) { at.amount += Math.round(Number(e.amount) || 0); at.rows.push(row.label || "Instalment"); }
        else paymentsById.set(key, {
          paymentId: key,
          amount: Math.round(Number(e.amount) || 0),
          date: e.date || null,
          method: e.method || "",
          reference: e.reference || "",
          rows: [row.label || "Instalment"],
        });
      }
    }
    const payments = Array.from(paymentsById.values()).sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );

    // which payments and milestones already carry invoices
    const invoicesByPayment = new Map();
    const invoicesByMilestone = new Map();
    for (const inv of invoices) {
      if (inv.forPaymentId) {
        const k = String(inv.forPaymentId);
        invoicesByPayment.set(k, [...(invoicesByPayment.get(k) || []), inv.invoiceNumber]);
      }
      if (inv.forMilestoneId) {
        const k = String(inv.forMilestoneId);
        invoicesByMilestone.set(k, [...(invoicesByMilestone.get(k) || []), inv.invoiceNumber]);
      }
    }

    // ── THE SPLIT, MADE LEGIBLE BEFORE THE BUTTON (GST-first only) ──────────
    // One payment can produce TWO invoices: the taxed stream's share becomes
    // a tax invoice and the rest an ordinary invoice. The box must say that
    // BEFORE generation, not surprise the owner after — so the exact
    // allocation createGstFirstSplitInvoices would make is previewed here
    // against the current ledger (taxed-stream-first, same arithmetic).
    if (booking && booking.scheduleIncludesGst) {
      const { computeLineTotals, lineStreams } = require("../utils/venueMoney");
      const streams = lineStreams(computeLineTotals(booking.lineItems, booking.gstPercent));
      let taxedCovered = 0;
      for (const inv of invoices) if (inv.stream === "taxed") taxedCovered += Math.round((inv.totals && inv.totals.grandTotal) || 0);
      let taxedRemaining = Math.max(0, streams.taxed - taxedCovered);
      // CHRONOLOGICAL, not display order: which payment splits depends on the
      // order invoices are raised, and the honest default story is that money
      // which landed first is invoiced first. The list itself stays
      // newest-first for reading.
      const chronological = [...payments].sort(
        (a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      for (const p of chronological) {
        if (invoicesByPayment.has(p.paymentId)) continue; // already documented; the ledger has moved past it
        const taxedHere = Math.max(0, Math.min(p.amount, taxedRemaining));
        p.taxedShare = taxedHere;
        p.untaxedShare = p.amount - taxedHere;
        p.willSplit = taxedHere > 0 && p.untaxedShare > 0;
        taxedRemaining -= taxedHere;
      }
    }
    for (const p of payments) p.invoiced = invoicesByPayment.get(p.paymentId) || [];

    const milestones = ((booking && booking.paymentSchedule) || [])
      .filter((r) => !r.isAdditional)
      .map((r) => ({
        _id: r._id,
        label: r.label || "Instalment",
        amount: Math.round(Number(r.amount) || 0),
        dueDate: r.dueDate || null,
        invoiced: invoicesByMilestone.get(String(r._id)) || [],
      }));

    const hasBooking = Boolean(booking);
    const hasTermsPdf = Boolean(venue.termsDocument && venue.termsDocument.url);

    // ── the six kinds, each pickable, each honest ───────────────────────────
    const kinds = {
      quote: quotes.length
        ? {
            available: true,
            quotes: quotes.map((q) => ({
              _id: q._id, version: q.version, status: q.status,
              grandTotal: (q.totals && q.totals.grandTotal) || 0,
              tokenAmount: q.tokenAmount || null, validUntil: q.validUntil || null,
            })),
            hasTermsPdf,
          }
        : {
            available: false,
            reason: "This lead has no quote yet. Build one on the Money tab — the generate box then files it as a document, with the booking amount and validity you set here.",
          },
      confirmation: hasBooking
        ? {
            available: true,
            hasCancellationPolicy: Boolean(venue.cancellationPolicy && (venue.cancellationPolicy.blocks || []).length),
            hasTermsPdf,
          }
        : {
            available: false,
            reason: "No booking exists yet — a confirmation renders the booking as it stands, so there is nothing to confirm until the booking is made.",
          },
      invoice: hasBooking
        ? { available: true, milestones, payments, gstFirst: Boolean(booking.scheduleIncludesGst) }
        : {
            available: false,
            reason: "You cannot invoice before a booking exists — an invoice is priced from the booking's agreed lines, and this lead has none yet.",
          },
      receipt: payments.length
        ? { available: true, payments }
        : {
            available: false,
            reason: hasBooking
              ? "There is no approved payment to receipt yet — a receipt records money received. Record and approve a payment on the Money tab first."
              : "There is no payment to receipt yet — a receipt records money received, and money is recorded against a booking. Confirm the booking first.",
          },
      statement: hasBooking
        ? { available: true }
        : {
            available: false,
            reason: "This lead has no money story yet — a statement states the whole booking's account as of now, so it needs a booking to account for.",
          },
      terms: hasTermsPdf
        ? { available: true, sourceFilename: (venue.termsDocument && venue.termsDocument.filename) || "" }
        : {
            available: false,
            reason: "No T&C PDF uploaded yet — there is nothing to put behind a cover page. Upload it in Settings → Terms, then generate the personalised copy here.",
          },
    };

    return res.status(200).json({ kinds, notesByKind, hasBooking });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { documentOptions };
