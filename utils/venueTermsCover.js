/**
 * utils/venueTermsCover.js — the generated cover page that personalises a
 * venue's own Terms & Conditions PDF.
 *
 * ── WHY A COVER PAGE AND NOT AN EDITOR ──────────────────────────────────────
 * A full editor (TipTap + a ProseMirror→pdfkit renderer + mammoth import) was
 * evaluated and deliberately deferred. The venue's terms are a PDF they
 * uploaded and approved; the moment we parse and re-render it we own every
 * fidelity bug in it — a dropped clause, a reflowed table, a missing signature
 * block — on a document that decides disputes. So the uploaded file is never
 * opened for content. We generate ONE page that says who these terms were
 * issued to, and stitch it in front. No extraction, no conversion, no risk.
 *
 * ── THE ONLY REAL DIFFICULTY: ABSENT FIELDS ─────────────────────────────────
 * This page is assembled from a live negotiation, where almost everything is
 * optional. A lead may have no email, no dates yet, no quote. The failure modes
 * to avoid are specific and both worse than omission:
 *
 *   · "undefined" / "null" / "NaN" rendered at a couple
 *   · an empty labelled row ("Email:" with nothing after it), which reads as
 *     though the venue lost the information rather than never having asked
 *
 * Every value therefore goes through `clean()`, and every row is only drawn
 * when it has content — `detailRow` returns without touching the cursor
 * otherwise, so absent fields leave no gap. The issue sentence degrades in
 * stages instead of collapsing: with dates it names them, without dates it
 * simply omits that clause, and with no couple name it addresses the document
 * generically rather than to "undefined".
 *
 * Money is "Rs. 1,23,456", not "₹1,23,456": pdfkit's built-in Helvetica has no
 * rupee glyph, so the symbol renders as a blank box. Same call as
 * services/BillingDocService made, for the same reason.
 */
const {
  bufferDoc,
  loadLogoBuffer,
  venueHeader,
  poweredByFooter,
  BURGUNDY,
  GOLD,
  GREY,
} = require("./venuePdf");
const { docDay, docDayWithWeekday } = require("./documentDate");

const BODY = "#222222";
const TEXT_W = 495; // matches the x-grid in venuePdf (left 50 → rule end 545)

/**
 * A displayable string, or "" for anything that must not reach the page.
 * Guards the literal strings too: a lead field can genuinely hold the text
 * "undefined" after a bad client write, and printing that is the same bug.
 */
function clean(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v).trim();
  if (!s) return "";
  if (/^(undefined|null|nan)$/i.test(s)) return "";
  return s;
}

/**
 * "Thursday, 26 November 2026" — weekday included, as the brief asks.
 *
 * Composed by utils/documentDate rather than by toLocaleDateString, which
 * printed "Thursday 26 November, 2026" on prod's Node 18 (ICU 74) and
 * "Thursday, 26 November 2026" on dev's Node 20 (ICU 78). Couples received the
 * first. Event dates are midnight-UTC calendar labels, so the UTC-based preset
 * is the correct one — shifting them into a zone would move the wedding.
 */
const longDate = (d) => docDayWithWeekday(d);

/** "26 November 2026" — no weekday, for running prose. */
const plainDate = (d) => docDay(d);

const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  return `Rs. ${Math.round(v).toLocaleString("en-IN")}`;
};

/**
 * Every distinct event day on the lead, earliest first.
 *
 * Reads functions[] first because that is where a multi-day wedding actually
 * lives (mehendi, haldi, reception), then falls back to the checkIn/checkOut
 * window and finally the legacy eventDate. De-duplicated by day key so a
 * three-function single day is "one date", not the same date printed thrice.
 */
function eventDays(lead) {
  const keys = new Map();
  const add = (d) => {
    if (!d) return;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return;
    keys.set(dt.toISOString().slice(0, 10), dt);
  };
  for (const f of (lead && lead.functions) || []) add(f.date);
  if (!keys.size) {
    add(lead && lead.checkIn);
    add(lead && lead.checkOut);
  }
  if (!keys.size) add(lead && lead.eventDate);
  return [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
}

/** The couple's best contact email — the primary contact wins, else the first. */
function contactEmail(lead) {
  const contacts = (lead && lead.contacts) || [];
  const primary = contacts.find((c) => c && c.isPrimary && clean(c.email));
  const any = contacts.find((c) => c && clean(c.email));
  return clean((primary || any || {}).email);
}

function contactPhone(lead) {
  const direct = clean(lead && lead.couplePhone);
  if (direct) return direct;
  const contacts = (lead && lead.contacts) || [];
  const primary = contacts.find((c) => c && c.isPrimary && clean(c.phone));
  const any = contacts.find((c) => c && clean(c.phone));
  return clean((primary || any || {}).phone);
}

const coupleName = (lead) => clean(lead && (lead.coupleName || lead.name));

/**
 * The sentence the brief asks for, degrading in stages rather than collapsing.
 *
 *   both      → "These terms are issued for Priya & Arjun for their event on 26 November 2026."
 *   no dates  → "These terms are issued for Priya & Arjun."
 *   no name   → "These terms are issued for the event on 26 November 2026."
 *   neither   → "" — and the caller draws nothing, because a sentence with both
 *               halves missing has nothing left to say.
 */
function issueSentence(lead, days) {
  const who = coupleName(lead);
  const labels = days.map(plainDate).filter(Boolean);
  let when = "";
  if (labels.length === 1) when = `on ${labels[0]}`;
  else if (labels.length === 2) when = `on ${labels[0]} and ${labels[1]}`;
  else if (labels.length > 2) when = `on ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  if (who && when) return `These terms are issued for ${who} for their event ${when}.`;
  if (who) return `These terms are issued for ${who}.`;
  if (when) return `These terms are issued for the event ${when}.`;
  return "";
}

/**
 * Build the cover page.
 *
 * @param {object}  args.venue          for letterhead (name, logo, contact, address)
 * @param {object}  args.lead           the negotiation this is issued against
 * @param {number} [args.quotedAmount]  current quoted figure; omitted when absent or 0
 * @param {Date}   [args.issuedAt]      defaults to now
 * @param {string} [args.sendNote]      the operator's version note, printed so the
 *                                      document itself explains which version it is
 * @param {string} [args.documentName]  the venue's own PDF filename, named so the
 *                                      reader knows the cover belongs to what follows
 * @returns {Promise<Buffer>}
 */
async function buildTermsCoverBuffer({ venue, lead, quotedAmount, issuedAt, sendNote, documentName } = {}) {
  const v = venue || {};
  const l = lead || {};
  // Resolved BEFORE the doc opens, same as every stream renderer: a slow logo
  // fetch must not interleave with writing, and a broken one must not throw.
  const logoBuffer = await loadLogoBuffer(v.logo);

  const { doc, done } = bufferDoc();
  venueHeader(doc, v, "Terms & Conditions", logoBuffer);

  const days = eventDays(l);

  // ── who these terms are for ──────────────────────────────────────────────
  const detailRow = (label, value) => {
    const text = clean(value);
    if (!text) return; // absent → no row, no gap, no "Email:" with nothing after it
    const y = doc.y;
    doc.fillColor(GREY).fontSize(9).text(`${label.toUpperCase()}`, 50, y, { width: 110 });
    doc.fillColor(BODY).fontSize(10).text(text, 165, y, { width: 380 });
    doc.moveDown(0.35);
  };

  detailRow("Prepared for", coupleName(l));
  detailRow("Phone", contactPhone(l));
  detailRow("Email", contactEmail(l));

  if (days.length === 1) {
    detailRow("Event date", longDate(days[0]));
  } else if (days.length > 1) {
    // Each day on its own line with its weekday — a five-day wedding is five
    // rows, not one unreadable comma run.
    detailRow("Event dates", longDate(days[0]));
    for (const d of days.slice(1)) detailRow("", longDate(d));
  }

  detailRow("Quoted", money(quotedAmount));
  detailRow("Issued", longDate(issuedAt || new Date()));

  // ── the issue sentence ───────────────────────────────────────────────────
  const sentence = issueSentence(l, days);
  if (sentence) {
    doc.moveDown(0.6);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).stroke();
    doc.moveDown(0.5).fillColor(BODY).fontSize(11).text(sentence, 50, doc.y, { width: TEXT_W });
  }

  // ── the version note ─────────────────────────────────────────────────────
  // On the page as well as in the list. Six weeks later the difference between
  // three near-identical PDFs has to be legible from the file itself, not only
  // from the row in the UI that happened to be beside it.
  const note = clean(sendNote);
  if (note) {
    doc.moveDown(0.7);
    doc.fillColor(GREY).fontSize(9).text("NOTE ON THIS VERSION", 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.15).fillColor(BODY).fontSize(10).text(note, 50, doc.y, { width: TEXT_W });
  }

  // ── what follows, and what this is not ───────────────────────────────────
  doc.moveDown(0.9);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#dddddd").stroke();
  doc.moveDown(0.4).fillColor(GREY).fontSize(9);
  const named = clean(documentName);
  doc.text(
    named
      ? `The venue's full terms & conditions follow this page, exactly as issued (${named}).`
      : "The venue's full terms & conditions follow this page, exactly as issued.",
    50,
    doc.y,
    { width: TEXT_W }
  );
  doc.moveDown(0.3);
  // Same standing as the generated-clause path: shared during a negotiation, so
  // it must not read as something already agreed.
  doc.text(
    "These terms are shared for information while the booking is being discussed. They form part of the booking contract only once a booking is confirmed and the contract is acknowledged.",
    50,
    doc.y,
    { width: TEXT_W }
  );

  poweredByFooter(doc, "", v.whiteLabel);
  doc.end();
  return done;
}

module.exports = {
  buildTermsCoverBuffer,
  // Exported for direct unit assertions — the absent-field rules are the point
  // of this module and are cheaper to pin here than through a rendered buffer.
  clean,
  longDate,
  plainDate,
  money,
  eventDays,
  issueSentence,
  contactEmail,
  contactPhone,
};
