/**
 * utils/venueBookingConfirmationPdf.js — the booking confirmation (S3).
 *
 * Generated FROM the booking. Every value on this page is read off the booking,
 * the lead, or venue Settings — there is no field an owner re-types, which is
 * the whole point: a confirmation that restates details by hand is a
 * confirmation that can contradict the booking it confirms.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is NOT signed and carries no acceptance block. A confirmation says "this is
 * what we have you down for"; an agreement asks for assent. Printing a signature
 * line on the former would misrepresent what the couple is receiving, which is
 * the same reasoning streamTermsPdf already applies to per-lead terms.
 *
 * ── ASSEMBLED FROM PARTS THAT ALREADY EXIST ─────────────────────────────────
 *   branding            utils/venueBranding      (S1a — resolved once)
 *   dates with weekday  utils/documentDate       (#132 — identical on any runtime)
 *   payment table       utils/venueDocTable      (#131 limits handled: repeating
 *                                                 header, guarded cells)
 *   balance / status    utils/venuePaymentStatus (S4 — the ONE derivation)
 *   cancellation policy utils/venueRichText      (S1c — the constrained tree)
 *   letterhead/footer   utils/venuePdf
 *
 * Nothing here recomputes a balance or a milestone status: if this page and the
 * lead disagreed about what a couple owes, the document is the one the couple
 * keeps, so it must come from the same derivation as the screen.
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
const { resolveBranding } = require("./venueBranding");
const { docDayWithWeekday, docInstantDay } = require("./documentDate");
const { renderTable } = require("./venueDocTable");
const { summarizeSchedule } = require("./venuePaymentStatus");
const { describeRoomsWorking } = require("./venueRoomsPolicy");
const { renderBlocksToPdf } = require("./venueRichText");

const BODY = "#222222";
const TEXT_W = 495;

/** "Rs. 8,12,500" — Helvetica has no rupee glyph. */
const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

const clean = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return /^(undefined|null|nan)$/i.test(s) ? "" : s;
};

/**
 * @param {object}  args
 * @param {object}  args.venue    selected with BRANDING_SELECT (+ cancellationPolicy)
 * @param {object}  args.booking
 * @param {object}  args.lead     for contacts
 * @param {boolean} [args.includeCancellationPolicy]
 * @param {Date}    [args.issuedAt]
 * @returns {Promise<{ buffer: Buffer, tableStats: object, includedPolicy: boolean }>}
 */
async function buildBookingConfirmationPdf({
  venue,
  booking,
  lead,
  includeCancellationPolicy = false,
  issuedAt = new Date(),
} = {}) {
  const brand = resolveBranding(venue || {});
  const bk = booking || {};
  const ld = lead || {};
  const logoBuffer = await loadLogoBuffer(brand.logo);

  const { doc, done } = bufferDoc();
  venueHeader(doc, venue || {}, "Booking Confirmation", logoBuffer);

  if (brand.taxLine) {
    doc.fillColor(GREY).fontSize(9).text(brand.taxLine, 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.4);
  }

  // ── who ───────────────────────────────────────────────────────────────────
  // Absent values draw NO row, so a missing email never leaves a labelled blank
  // that reads as though the venue lost it.
  const row = (label, value) => {
    const text = clean(value);
    if (!text) return;
    const y = doc.y;
    doc.fillColor(GREY).fontSize(9).text(String(label).toUpperCase(), 50, y, { width: 115 });
    doc.fillColor(BODY).fontSize(10).text(text, 170, y, { width: 375 });
    doc.moveDown(0.32);
  };

  row("Confirmed for", bk.coupleName || ld.coupleName);
  row("Phone", bk.couplePhone || ld.couplePhone);
  row("Issued", docInstantDay(issuedAt));

  // Contacts beyond the couple — who the venue actually deals with. Each on its
  // own line with their relation, because "who do I call" is the question this
  // answers on the day.
  const contacts = (ld.contacts || []).filter((c) => c && (clean(c.name) || clean(c.phone) || clean(c.email)));
  if (contacts.length) {
    doc.moveDown(0.25);
    doc.fillColor(GREY).fontSize(9).text("CONTACTS", 50, doc.y, { width: 115 });
    doc.moveDown(0.1);
    for (const c of contacts) {
      const bits = [clean(c.name), clean(c.phone), clean(c.email)].filter(Boolean).join("  ·  ");
      const rel = clean(c.relation);
      doc.fillColor(BODY).fontSize(10).text(`${bits}${rel && rel !== "other" ? `  (${rel})` : ""}`, 170, doc.y, { width: 375 });
      doc.moveDown(0.22);
    }
  }

  // ── the event ─────────────────────────────────────────────────────────────
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).stroke();
  doc.moveDown(0.5);
  doc.fillColor(BURGUNDY).fontSize(12).text("Your booking", 50, doc.y, { width: TEXT_W });
  doc.moveDown(0.3);

  const days = (bk.days || []).filter((d) => d && d.date);
  for (const d of days) {
    const y = doc.y;
    doc.fillColor(BODY).fontSize(10).text(docDayWithWeekday(d.date), 50, y, { width: 250 });
    const detail = [
      clean(d.eventType),
      d.guestCount ? `${d.guestCount} guests` : "",
      (d.spaces || []).filter(Boolean).join(", "),
    ].filter(Boolean).join("  ·  ");
    if (detail) doc.fillColor(GREY).fontSize(9.5).text(detail, 305, y, { width: 240 });
    doc.moveDown(0.35);
  }
  if (!days.length) {
    doc.fillColor(GREY).fontSize(10).text("Dates to be confirmed.", 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.3);
  }

  if (clean(bk.specialRequirements)) {
    doc.moveDown(0.2);
    doc.fillColor(GREY).fontSize(9).text("NOTES", 50, doc.y, { width: 115 });
    doc.fillColor(BODY).fontSize(10).text(clean(bk.specialRequirements), 170, doc.y - 11, { width: 375 });
    doc.moveDown(0.4);
  }

  // ── the money ─────────────────────────────────────────────────────────────
  const s = summarizeSchedule(bk, issuedAt);
  doc.moveDown(0.5);
  doc.fillColor(BURGUNDY).fontSize(12).text("Payment schedule", 50, doc.y, { width: TEXT_W });
  doc.moveDown(0.3);

  let tableStats = { rows: 0, pages: 1, headerRepeats: 0, truncatedCells: 0 };
  if (s.rows.length) {
    tableStats = renderTable(doc, {
      header: [
        { text: "Instalment", backgroundColor: "#f6f4f7" },
        { text: "Due", backgroundColor: "#f6f4f7" },
        { text: "%", backgroundColor: "#f6f4f7" },
        { text: "Amount", backgroundColor: "#f6f4f7" },
        { text: "Received", backgroundColor: "#f6f4f7" },
      ],
      rows: s.rows.map((m) => [
        m.label,
        m.dueDate ? docDayWithWeekday(m.dueDate).replace(/^\w+,\s*/, "") : "—",
        m.percent === null ? "—" : `${m.percent}%`,
        money(m.amount),
        // The couple's copy states what has ARRIVED, not an internal status
        // label: "Paid" and "3 days late" are the venue's vocabulary, and a
        // confirmation is not the place to tell a couple they are late.
        m.paidAmount > 0 ? money(m.paidAmount) : "—",
      ]),
      opts: { columnStyles: ["*", 95, 45, 90, 90] },
    });
  } else {
    doc.fillColor(GREY).fontSize(10).text("No schedule set yet.", 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.3);
  }

  // Totals, from the S4 derivation rather than re-added here.
  doc.moveDown(0.5);
  const right = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.fillColor(bold ? BURGUNDY : GREY).fontSize(bold ? 12 : 10).text(label, 300, y, { width: 140, align: "right" });
    doc.fillColor(bold ? BURGUNDY : BODY).fontSize(bold ? 12 : 10).text(value, 450, y, { width: 95, align: "right" });
    doc.font("Helvetica");
    doc.moveDown(0.28);
  };
  // ── AGREED AND ADDITIONAL, ALWAYS SEPARATE ────────────────────────────────
  // "Agreed Rs. 5,00,000 + additional billing Rs. 40,000" is the line a couple
  // has to be able to check against what they signed. Folding an extra into the
  // booking value would make the document disagree with the agreement it is
  // confirming — and the agreed value is precisely the number a dispute turns
  // on. With no extras the document reads exactly as it always has.
  // ── ROOMS, WITH ITS WORKING ───────────────────────────────────────────────
  // A couple reading "rooms Rs. 70,000" with no breakdown telephones to ask how
  // it was arrived at. Broken out ABOVE the agreed value because it is a
  // COMPONENT of it — not an extra on top — so the two lines above add to the
  // one below and can be checked by adding them up.
  const rc = bk && bk.roomsCharge;
  if (rc && Number(rc.amount) > 0) {
    right("Venue", money(Math.max(0, s.totals.bookingValue - Number(rc.amount))));
    right("Rooms", money(rc.amount));
    const working = describeRoomsWorking(rc);
    if (working) {
      doc.fillColor(GREY).fontSize(8).text(working, 300, doc.y, { width: 245, align: "right" });
      doc.fillColor(BODY).fontSize(10);
      doc.moveDown(0.28);
    }
  }
  right(s.totals.additional > 0 ? "Agreed value" : "Booking value", money(s.totals.bookingValue));
  if (s.totals.additional > 0) {
    right("Additional billing", `+ ${money(s.totals.additional)}`);
    right("Total", money(s.totals.total));
  }
  if (s.totals.received > 0) right("Received", `− ${money(s.totals.received)}`);
  right("Balance due", money(s.totals.balance), true);

  // ── the cancellation policy, when asked for ───────────────────────────────
  const blocks = (venue && venue.cancellationPolicy && venue.cancellationPolicy.blocks) || [];
  const includedPolicy = Boolean(includeCancellationPolicy && blocks.length);
  if (includedPolicy) {
    // Its own page: a refund policy that starts halfway down a payment table is
    // a policy nobody reads, and it is the part a couple returns to.
    doc.addPage();
    doc.fillColor(BURGUNDY).fontSize(13).text("Cancellation policy", 50, 50, { width: TEXT_W });
    doc.moveDown(0.3);
    renderBlocksToPdf(doc, blocks, { width: TEXT_W });
  }

  // ── what this document is ─────────────────────────────────────────────────
  doc.moveDown(0.8);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#dddddd").stroke();
  doc.moveDown(0.4).fillColor(GREY).fontSize(9);
  doc.text(
    "This confirms the booking above and the payment schedule agreed for it. It is a confirmation, not an agreement — no signature is required.",
    50,
    doc.y,
    { width: TEXT_W }
  );

  poweredByFooter(doc, "", brand.whiteLabel);
  doc.end();
  const buffer = await done;
  return { buffer, tableStats, includedPolicy };
}

module.exports = { buildBookingConfirmationPdf, money };
