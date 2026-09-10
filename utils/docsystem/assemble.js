/**
 * utils/docsystem/assemble.js — real model documents → the shapes the five
 * renderers draw. Every figure comes from utils/venueMoney or
 * utils/venuePaymentStatus; nothing here computes money, it only arranges it.
 */
const { resolveBranding } = require("../venueBranding");
const { receivedOn, milestoneStatus } = require("../venuePaymentStatus");
const {
  DASH, money, dateProse, dateWindowProse, dateCell, dateTimeProse,
  lineFigures, documentTotals, allocateScheduleGst, decomposeGstInsideRows,
  bankLines,
} = require("./shared");

/**
 * ── LEGACY BOOKINGS (no lineItems) ──────────────────────────────────────────
 * Production carries bookings that predate line quotes: their money is
 * totalValue + gstMode/gstPercent + the schedule. The documents must not
 * refuse them, and must not invent lines — one honest synthetic line carries
 * the agreed value (the same shape the invoice fallback has always used),
 * and the schedule keeps its OWN per-row GST via venuePaymentSchedule.gstOnRow
 * (the single implementation of that rule) instead of a pro-rata allocation.
 */
function legacyAssembly(booking) {
  const { gstOnRow } = require("../venuePaymentSchedule");
  const pct = Number(booking.gstPercent) || 0;
  const gstMode = booking.gstMode || "none";
  const totalValue = Math.round(Number(booking.totalValue) || 0);
  const agreed = ((booking.paymentSchedule) || []).filter((r) => !r.isAdditional);
  const additional = ((booking.paymentSchedule) || []).filter((r) => r.isAdditional);
  const schedule = [];
  let gst = 0;
  let taxable = 0;
  for (const r of agreed) {
    const payable = Math.round(Number(r.amount) || 0);
    const g = gstOnRow(payable, { gstMode, gstPercent: pct, rowApplicable: Boolean(r.gstApplicable) });
    const rowGst = g.bears ? g.gst : 0;
    if (g.bears) taxable += payable;
    gst += rowGst;
    schedule.push({
      label: r.label || "Instalment",
      subLine: r.percent !== null && r.percent !== undefined ? `${r.percent}% of the booking value` : undefined,
      dueDate: r.dueDate, ref: r._id, state: stateOf(r),
      payable, gst: rowGst, collectable: payable + rowGst, refundableCarried: 0,
    });
  }
  for (const r of additional) {
    const payable = Math.round(Number(r.amount) || 0);
    schedule.push({
      label: r.label || "Additional charge", subLine: "Additional billing — on top of the agreed amount",
      dueDate: r.dueDate, ref: r._id, state: stateOf(r),
      payable, gst: 0, collectable: payable, refundableCarried: 0,
    });
  }
  const extrasAmount = additional.reduce((s2, r) => s2 + Math.round(Number(r.amount) || 0), 0);
  const scheduledAgreed = agreed.reduce((s2, r) => s2 + Math.round(Number(r.amount) || 0), 0);
  // The schedule is the collectable truth on a legacy booking; totalValue and
  // the schedule can legitimately disagree (the model says so), and the
  // document's sums must be TRUE — so payable follows the rows.
  const totals = {
    pct, charged: scheduledAgreed, taxable, gst, refundable: 0,
    extrasAmount, extrasGst: 0,
    payable: scheduledAgreed + extrasAmount,
    collectable: scheduledAgreed + extrasAmount + gst,
  };
  const priced = [{
    label: `Venue booking${booking.coupleName ? ` — ${booking.coupleName}` : ""} (as agreed)`,
    amount: scheduledAgreed, taxable, gst, lineTotal: scheduledAgreed + gst,
    refundable: false, treatment: gstMode === "none" || gst === 0 ? "none" : taxable === scheduledAgreed ? "full" : "part",
  }];
  return { totals, priced, refundables: [], schedule, legacy: true };
}

/**
 * ── ONE HEADER, ONE PARTIES BLOCK, EVERY DOCUMENT (founder ruling) ─────────
 * The header is the brand alone; the registrations live in the parties
 * block, on page one, on every document — venue left, client right, each
 * side rendering only what exists. A tax invoice without PAN and GSTIN is
 * not a valid tax invoice, so what the header lost must have this home.
 */
function venueParty(identity, { registers = true } = {}) {
  return {
    name: identity.name,
    lines: [
      identity.legalName && identity.legalName !== identity.name ? identity.legalName : null,
      ...(identity.addressLines || []),
      registers && identity.pan ? `PAN ${identity.pan}` : null,
      registers && identity.gstin ? `GSTIN ${identity.gstin}` : null,
      registers && identity.stateLine ? identity.stateLine : null,
      [identity.phone, identity.email].filter(Boolean).join(" \u00b7 ") || null,
    ].filter(Boolean),
  };
}

/**
 * The client side: name from the booking (or the billed-to snapshot), the
 * primary contact's phone/email, the BOOKING's address snapshot, and the
 * GSTIN (snapshot first, live contact for bookings that predate it).
 * `showGstin: false` is the ordinary invoice's no-register rule.
 */
function clientParty({ name, contact, clientDetails, gstin, showGstin = true }) {
  const cdd = clientDetails || {};
  const addressLine = [cdd.house, cdd.street].filter(Boolean).join(", ");
  const cityLine = [cdd.city, cdd.pincode].filter(Boolean).join(" ");
  return {
    name: name || (contact && contact.name) || null,
    lines: [
      contact && contact.name && contact.name !== name ? contact.name : null,
      (contact && contact.phone) || null,
      (contact && contact.email) || null,
      addressLine || null,
      cityLine || null,
      showGstin && gstin ? `GSTIN ${gstin}` : null,
    ].filter(Boolean),
  };
}

/**
 * ── EVERY DOCUMENT SAYS WHEN THIS COPY WAS MADE (founder ruling) ────────────
 * The event dates stay what they are — Issued and Confirmed are facts about
 * the thing, immutable across regenerations — and this rides beside them in
 * the reference row: a couple holding two copies of a regenerated statement
 * needs to know which is newer. Plain fact, not a system stamp.
 */
/**
 * Only when it DIFFERS from the document's own issue-type date (finding 1):
 * the generation date exists to distinguish a reissued copy from the
 * original — on a freshly cut document it says the same thing twice.
 * Pass the sibling date; identical days suppress the ref.
 */
function generatedRef(siblingDate) {
  const today = dateProse(new Date());
  if (siblingDate && dateProse(siblingDate) === today) return null;
  return `Generated ${today}`;
}

function primaryContactOf(lead) {
  return ((lead && lead.contacts) || []).find((c) => c.isPrimary) || ((lead && lead.contacts) || [])[0] || null;
}

function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function identityFrom(venue, logoBuffer) {
  const b = resolveBranding(venue || {});
  const addressLines = String(b.address || "").split(/,\s*/).reduce((acc, part) => {
    // fold the free-text address into at most two printed lines
    if (!acc.length || acc[acc.length - 1].length + part.length > 38) acc.push(part);
    else acc[acc.length - 1] += `, ${part}`;
    return acc;
  }, []).slice(0, 3);
  return {
    name: b.name || "Venue",
    // ONE HEADER (founder ruling): the brand alone on every document — the
    // parties block carries the registrations everywhere.
    headerBrandOnly: true,
    // Settings → Business bank details — null when the venue filled nothing,
    // and the payment block then does not exist (no heading, no empty rows).
    bank: b.hasBank ? b.bank : null,
    upiQr: b.upiQr || null,
    monogram: logoBuffer ? "" : initialsOf(b.name),
    tagline: (venue && venue.tagline) || "",
    legalName: b.name,
    addressLines,
    pan: b.pan, gstin: b.gstin, phone: b.phone, email: b.email,
    logoBuffer: logoBuffer || null,
  };
}

/**
 * ── THE ROOMS LINE (BOOKING 3) ──────────────────────────────────────────────
 * Printed ONLY from the booking's recorded allocation. When the rooms step
 * was skipped the documents say NOTHING about rooms — never zero, and never
 * the enquiry's ask (that is a request, not what the couple gets).
 */
function roomsLineOf(booking) {
  const alloc = booking && booking.roomsAllocation;
  if (!alloc || !(alloc.items || []).length) return null;
  if (alloc.mode === "all") {
    const total = alloc.items.reduce((s2, it) => s2 + it.count, 0);
    return `All rooms (${total})`;
  }
  return alloc.items
    .map((it) => (it.count === it.total ? `all ${it.total} ${it.name}` : `${it.count} of ${it.total} ${it.name}`))
    .join(" · ");
}

function windowFacts(lead, booking, venueSpaces, { includeSpaces = true } = {}) {
  const checkIn = (booking && booking.checkIn) || (lead && lead.checkIn);
  const checkOut = (booking && booking.checkOut) || (lead && lead.checkOut);
  const hours = checkIn && checkOut ? Math.round((new Date(checkOut) - new Date(checkIn)) / 36e5) : null;
  const spaceNames = venueSpaces && venueSpaces.length ? venueSpaces.join(", ") : null;
  const rooms = roomsLineOf(booking);
  const facts = [
    { label: "Check-in", value: dateTimeProse(checkIn) },
    { label: "Check-out", value: dateTimeProse(checkOut) },
    { label: "Total hours", value: hours ? `${hours} hours` : DASH },
  ];
  // the confirmation gives spaces and rooms their own full-width section, so
  // its fact strip must not carry a cramped duplicate of the same facts
  if (includeSpaces) {
    facts.push(rooms
      ? { label: "Spaces & rooms", value: [spaceNames, rooms].filter(Boolean).join(" · ") }
      : { label: "Spaces", value: spaceNames || DASH });
  }
  return facts;
}

function spacesOf(booking) {
  const names = [...new Set(((booking && booking.days) || []).flatMap((d) => (d && d.spaces) || []))].filter(Boolean);
  return names;
}

/**
 * Schedule rows shaped for print. The AGREED rows carry the agreed GST
 * (shared.allocateScheduleGst); the ADDITIONAL rows ride after them with
 * their own (currently zero) GST — included so the printed columns sum to
 * payable-with-extras EXACTLY, which the total row claims and the renderer
 * asserts before drawing.
 */
function shapeSchedule(booking, totals, { includeAdditional = true } = {}) {
  const agreed = ((booking && booking.paymentSchedule) || []).filter((r) => !r.isAdditional);
  const additional = includeAdditional ? ((booking && booking.paymentSchedule) || []).filter((r) => r.isAdditional) : [];
  // GST-FIRST (wizard2): on a booking whose schedule includes the GST, the
  // rows ARE the collectable. They are DECOMPOSED into payable + GST by the
  // taxed-stream-first rule (what each instalment's tax invoice carries),
  // never re-taxed — so the table's columns agree with the document's own
  // stated totals instead of contradicting them. Older schedules keep the
  // ex-GST base they were written with, GST spread on top.
  const gstInside = Boolean(booking && booking.scheduleIncludesGst);
  const bare = agreed.map((r) => ({
    label: r.label || "Instalment",
    subLine: r.percent !== null && r.percent !== undefined ? `${r.percent}% of the booking value` : undefined,
    amount: r.amount, dueDate: r.dueDate, ref: r._id,
    state: stateOf(r),
  }));
  const shaped = gstInside
    ? decomposeGstInsideRows(bare, totals)
    : allocateScheduleGst(bare, { ...totals, extrasGst: 0 });
  for (const r of additional) {
    const payable = Math.round(Number(r.amount) || 0);
    shaped.push({
      label: r.label || "Additional charge", subLine: "Additional billing — on top of the agreed amount",
      dueDate: r.dueDate, ref: r._id, state: stateOf(r),
      payable, gst: 0, collectable: payable, refundableCarried: 0,
    });
  }
  return shaped;
}
function stateOf(row) {
  const s = milestoneStatus(row);
  return s === "paid" ? "Paid" : s === "partial" ? "Part-paid" : s === "overdue" ? "Late" : "Upcoming";
}

// ── 1. QUOTE ────────────────────────────────────────────────────────────────
function assembleQuote({ venue, lead, quote, booking, logoBuffer }) {
  const pct = Number(quote.gstPercent) || 0;
  const lines = (quote.lineItems || []).map((l) => lineFigures(l, pct));
  const totals = documentTotals(quote.lineItems || [], [], pct);
  const spaceNames = spacesOf(null).length ? spacesOf(null) : null;
  const heldUntil = quote.validUntil || null;
  // The quote's plan: the stored schedule does not exist pre-booking; the
  // document prints the venue's proposed split only when the quote carries
  // one. Without one, the schedule section states the booking amount alone.
  const schedule = allocateScheduleGst(
    [{ label: "Booking amount", subLine: "Confirms the date and holds the spaces", dueLabel: "On confirmation", amount: totals.payable }],
    totals
  );
  const qIdentity = identityFrom(venue, logoBuffer);
  const qContact = primaryContactOf(lead);
  return {
    identity: qIdentity,
    // parties on the quote too (one anatomy): pre-booking there is no
    // address snapshot yet — the contact's own facts render, nothing more
    parties: {
      venue: venueParty(qIdentity),
      client: clientParty({
        name: (lead && lead.coupleName) || null,
        contact: qContact,
        clientDetails: booking && booking.clientDetails,
        gstin: (booking && booking.clientDetails && booking.clientDetails.gstin) || (qContact && qContact.gstin) || "",
      }),
    },
    meta: { reference: quote.quoteNumber || `Quote v${quote.version || 1}` },
    titleMeta: {
      eyebrow: "Quote",
      // the design titles the quote with WHAT IS QUOTED (the spaces); a lead
      // has no spaces yet, so the event window carries the title instead —
      // never the couple's name, which "Prepared for" already says
      title: lead && lead.checkIn ? `Event — ${dateProse(lead.checkIn)}` : "Venue quote",
      subject: lead && lead.coupleName ? `Prepared for ${lead.coupleName}` : undefined,
      presentedTo: lead && lead.coupleName,
      refs: [
        `Quote ${quote.quoteNumber || `v${quote.version || 1}`}`,
        `Issued ${dateProse(quote.createdAt || new Date())}`,
        heldUntil ? `Held until ${dateProse(heldUntil)}` : null,
        generatedRef(quote.createdAt || new Date()),
      ].filter(Boolean),
    },
    facts: windowFacts(lead, booking || null, booking ? spacesOf(booking) : null),
    priced: lines.filter((l) => !l.refundable),
    refundables: lines.filter((l) => l.refundable),
    totals,
    inclusions: [],
    schedule,
    noteLines: [
      "This quote is not a booking until the booking amount is received. Each instalment is invoiced separately with GST on its taxable share; the refundable deposit is never invoiced.",
      "Amounts in Indian rupees. Rates are for the stated dates, hours and spaces; changes to any of these are re-quoted before they are charged.",
    ],
    signatory: null,
  };
}

// ── 2. BOOKING CONFIRMATION ─────────────────────────────────────────────────
function assembleConfirmation({ venue, lead, booking, logoBuffer, policyBlocks = [] }) {
  const pct = Number(booking.gstPercent) || 0;
  const isLegacy = !(booking.lineItems || []).length;
  const legacy = isLegacy ? legacyAssembly(booking) : null;
  const lines = isLegacy ? [] : (booking.lineItems || []).map((l) => lineFigures(l, pct));
  const totals = isLegacy
    ? { ...legacy.totals, extrasAmount: 0, extrasGst: 0, payable: legacy.totals.charged, collectable: legacy.totals.charged + legacy.totals.gst }
    : documentTotals(booking.lineItems || [], [], pct);
  // ── SPACES AND ROOMS, LINE BY LINE (founder ruling, confirmdoc3 f9) ──────
  // One line PER SPACE — the function name does not belong on the space line
  // ("Entire property", never "Entire property — Wedding") — and no date in
  // the detail: check-in, check-out and hours sit directly above. Rooms are
  // COUNT AND CATEGORY per line ("8 · Deluxe"), each category its own line,
  // never a summary that says the same thing twice.
  const spaces = [...new Set(((booking.days || []).length
    ? (booking.days || []).flatMap((day) => (day.spaces || []).length ? day.spaces : ["Venue"])
    : spacesOf(booking)))].map((name) => ({ name }));
  const alloc = booking.roomsAllocation;
  const rooms = alloc && (alloc.items || []).length
    ? alloc.items.filter((it) => it.count > 0).map((it) => ({ name: `${it.count} \u00b7 ${it.name}` }))
    : [];
  const firstDay = (booking.days && booking.days[0] && booking.days[0].date) || booking.checkIn;
  const primaryContact = ((lead && lead.contacts) || []).find((c) => c.isPrimary) || ((lead && lead.contacts) || [])[0] || null;
  const received = ((booking.paymentSchedule || []).filter((r) => !r.isAdditional)).reduce((s2, r) => s2 + Math.round(receivedOn(r)), 0);
  // what the schedule rows themselves total — GST inside on a GST-first
  // booking, ex-GST on older ones. Received is recorded against these same
  // rows, so the balance is honest in either era.
  const scheduledTotal = ((booking.paymentSchedule || []).filter((r) => !r.isAdditional))
    .reduce((s2, r) => s2 + Math.round(Number(r.amount) || 0), 0);
  const identity = identityFrom(venue, logoBuffer);
  // the WINDOW the couple holds runs check-in to check-out (finding 2's own
  // example checks out on the 3rd) — event days are a subset of it
  const winFrom = booking.checkIn || firstDay;
  const winTo = booking.checkOut || (booking.days && booking.days.length && booking.days[booking.days.length - 1].date) || winFrom;
  const held = dateWindowProse(winFrom, winTo);
  const multiDay = held !== dateProse(winFrom);
  const bookingRef = `Booking ${String(booking._id).slice(-6).toUpperCase()}`;
  return {
    identity,
    meta: { reference: bookingRef },
    // THE HIERARCHY, righted (finding 3): the document's NAME carries the
    // weight — the sentiment is the whisper above it, and the facts (the
    // window, finding 2, and the client) sit beneath. The reference row is
    // the anatomy's home for the searchable number (finding 5), and the old
    // "Booking Confirmation" ref repeated the eyebrow (finding 4) — dropped.
    titleMeta: {
      eyebrow: multiDay ? "Your dates are held" : "Your date is held",
      title: "Booking confirmation",
      subject: [held, booking.coupleName ? `For ${booking.coupleName}` : null].filter(Boolean).join(" \u00b7 "),
      presentedTo: booking.coupleName,
      refs: [bookingRef, `Confirmed ${dateProse(booking.createdAt)}`, generatedRef(booking.createdAt)].filter(Boolean),
    },
    intro: "The booking amount has been received and the dates below are held exclusively. This page records the agreed amount and the plan for the balance.",
    // venue left, client right — as Indian tax documents read. Address and
    // GSTIN are not collected for clients yet (the People model has no such
    // fields); the block renders whichever facts exist and nothing where
    // they are absent, so it grows the day the collection step lands.
    parties: {
      venue: venueParty(identity),
      client: clientParty({
        name: booking.coupleName,
        contact: primaryContact || (booking.couplePhone ? { phone: booking.couplePhone } : null),
        clientDetails: booking.clientDetails,
        gstin: ((booking.clientDetails || {}).gstin) || (primaryContact && primaryContact.gstin) || "",
      }),
    },
    facts: (() => {
      const facts = windowFacts(lead, booking, spacesOf(booking), { includeSpaces: false });
      // guests moved off the space lines (finding 9), so the fact strip
      // carries them: the plain number, or "Up to N" when days differ
      const counts = [...new Set(((booking.days || []).map((d) => d.guestCount).filter((n) => n > 0)))];
      if (counts.length) {
        const max = Math.max(...counts);
        facts.push({ label: "Guests", value: counts.length > 1 ? `Up to ${max}` : String(max) });
      }
      return facts;
    })(),
    spaces,
    rooms,
    priced: isLegacy ? legacy.priced : lines.filter((l) => !l.refundable),
    refundables: isLegacy ? [] : lines.filter((l) => l.refundable),
    totals,
    inclusions: [],
    // The confirmation documents the AGREED deal: its schedule is the plan
    // for the agreed amount alone. Extras live on the statement, which sums
    // them explicitly — the confirmation's own note says exactly that.
    schedule: (() => {
      if (isLegacy) return legacy.schedule.filter((r) => !r.subLine || !r.subLine.startsWith("Additional"));
      const rows = shapeSchedule(booking, totals, { includeAdditional: false });
      // THE TOKEN ROW'S ONE LINE (finding 10): a couple sees a round token
      // split into two odd figures — that is the taxed stream filling first,
      // said in the schedule's own voice. Only where there is GST to explain.
      if (booking.scheduleIncludesGst && rows.length && rows[0].gst > 0 && !rows[0].subLine) {
        rows[0].subLine = `Includes ${money(rows[0].gst)} GST \u2014 payments cover the quote's taxed share first`;
      }
      return rows;
    })(),
    // The venue's cancellation policy, when the owner asked for it: rich-text
    // blocks flattened to sentences. Content inside the existing closing
    // section, not a new section — the anatomy stays fixed.
    received,
    balance: Math.max(0, scheduledTotal - received),
    specialRequirements: booking.specialRequirements || null,
    policyLines: (policyBlocks || []).flatMap((bk) => {
      if (!bk) return [];
      const own = ((bk.spans) || []).map((sp) => sp.text).join("");
      const items = ((bk.items) || []).map((it, i) => `${i + 1}. ${((it && it.spans) || []).map((sp) => sp.text).join("")}`);
      return [own, ...items].filter(Boolean);
    }),
    noteLines: [
      "Each instalment is invoiced separately with GST on its taxable share; the refundable deposit is never invoiced and is returned after the event.",
      "This is a confirmation, not an agreement — no signature is required to keep the dates held; the booking amount already did that.",
    ],
    signatory: null,
  };
}

// ── 3. TAX INVOICE ──────────────────────────────────────────────────────────
async function assembleInvoice({ venue, lead, booking, invoice, logoBuffer }) {
  const inv = invoice;
  const half = (n) => Math.round((Number(n) || 0) / 2);
  const items = (inv.lineItems || []).map((li) => {
    const amount = Math.round((Number(li.qty) || 1) * (Number(li.unitPrice) || 0));
    const hasFacts = li.taxable !== null && li.taxable !== undefined && li.gst !== null && li.gst !== undefined;
    const taxable = hasFacts ? Math.round(Number(li.taxable) || 0) : null;
    const gst = hasFacts ? Math.round(Number(li.gst) || 0) : null;
    // the line is named after the instalment; the couple's name is the
    // addressee, not part of the charge (finding 4) — a stored " — <name>"
    // suffix is display-trimmed, and new invoices no longer append it
    const coupleName = (booking && booking.coupleName) || "";
    const rawLabel = li.label || "Charge";
    return {
      label: coupleName && rawLabel.endsWith(` \u2014 ${coupleName}`)
        ? rawLabel.slice(0, -(` \u2014 ${coupleName}`.length))
        : rawLabel,
      subLine: hasFacts && !gst ? "No GST" : undefined,
      amount, taxable, gst,
      cgst: gst !== null ? half(gst) : null,
      sgst: gst !== null ? gst - half(gst) : null,
      total: amount + (gst || 0),
    };
  });
  const t = inv.totals || {};
  const pct = Number(inv.gstPercent) || 0;
  const sum = {
    amount: Math.round(Number(t.subtotal) || 0),
    taxable: Math.round(Number(t.taxable) || 0),
    nonTaxable: Math.round(Number(t.subtotal) || 0) - Math.round(Number(t.taxable) || 0),
    cgst: half(t.gst),
    sgst: Math.round(Number(t.gst) || 0) - half(t.gst),
    total: Math.round(Number(t.grandTotal) || 0),
    pctHalf: pct % 2 === 0 ? pct / 2 : (pct / 2).toFixed(1),
  };
  const billed = inv.billedTo || {};
  const identity = identityFrom(venue, logoBuffer);
  const isTax = inv.gstMode !== "none" && (Number(t.gst) || 0) > 0;
  // ── THE ORDINARY INVOICE IS A RECIPE VARIATION, NOT A DOCUMENT ───────────
  // Founder ruling (GST-first): a non-GST invoice carries NO GSTINs — not the
  // venue's, not the client's, no B2C fallback line — and no tax columns.
  // That is the entire reason the taxed/untaxed split exists, so the plain
  // shape strips every GST-register fact: registration lines, state code,
  // place of supply, SAC, reverse-charge. The layout is otherwise the same
  // tax-invoice anatomy.
  if (isTax) identity.stateLine = "State code 29 \u00b7 Karnataka";
  else { identity.gstin = ""; identity.pan = ""; identity.stateLine = ""; }
  // THE TITLE FOLLOWS THE LINE (finding 4): a milestone-backed invoice is
  // titled by the instalment it bills — the stored `kind` (every milestone
  // invoice was written "final") stays a creator-side defect for the money
  // ruling, but the document stops repeating the lie.
  const firstLabel = items.length === 1 ? items[0].label : null;
  const title = inv.kind === "addon"
    ? "Additional billing"
    : inv.forMilestoneId && firstLabel ? firstLabel
    : inv.kind === "final" ? "Final instalment" : "Instalment";
  // the event window, as the confirmation carries it (finding 7)
  const window = booking && (booking.checkIn || (booking.days && booking.days[0]))
    ? dateWindowProse(booking.checkIn || booking.days[0].date, booking.checkOut || booking.checkIn)
    : null;
  // ── THE PAY-QR CARRIES NO AMOUNT (founder ruling, superseding the
  // amount-carrying build): every QR is the VPA alone — the payer types the
  // figure. The amount was the only reason the invoice generated per
  // render, so it now uses the ONE STORED QR from Settings like every
  // other surface would — one image, one code path. The single residue: a
  // venue that saved its UPI ID before the QR store existed (bankdetails
  // shipped a release ahead of upiqr) has an ID and an empty store, so an
  // amountless QR is generated for it — the SAME encoder, byte-equivalent
  // payload to what the store would hold; a second trigger, not a second
  // code path. A payment-backed invoice still carries no pay-QR at all:
  // that money already arrived, and a QR inviting a second payment is
  // worse than none.
  let payQr = null;
  if (!inv.forPaymentId) {
    if (identity.upiQr && identity.upiQr.dataUrl) {
      const b64 = (identity.upiQr.dataUrl.split(",")[1]) || "";
      if (b64) payQr = { buffer: Buffer.from(b64, "base64"), upiString: "", source: identity.upiQr.source || "stored" };
    } else if (identity.bank && identity.bank.upiId) {
      const { generateUpiQr } = require("../venueUpiQr");
      const q = await generateUpiQr(identity.bank.upiId, identity.name);
      payQr = { buffer: Buffer.from(q.dataUrl.split(",")[1], "base64"), upiString: q.upiString, source: "fallback" };
    }
  }
  return {
    identity,
    plain: !isTax,
    parties: {
      venue: venueParty(identity, { registers: isTax }),
      client: clientParty({
        name: billed.name || (booking && booking.coupleName),
        contact: primaryContactOf(lead),
        clientDetails: booking && booking.clientDetails,
        // the invoice's own snapshot first (immutable), the booking's for
        // invoices that predate the address collection
        gstin: isTax ? (billed.gstin || (booking && booking.clientDetails && booking.clientDetails.gstin) || "") : "",
        showGstin: isTax,
      }),
      // a TAX invoice must state the unregistered case explicitly — B2C is a
      // fact of the invoice, not an absence
      clientNote: isTax && !(billed.gstin || (booking && booking.clientDetails && booking.clientDetails.gstin))
        ? "GSTIN \u2014 unregistered (B2C)" : null,
    },
    meta: { reference: inv.invoiceNumber },
    titleMeta: {
      eyebrow: isTax ? "Tax invoice" : "Invoice",
      title,
      subject: booking && booking.coupleName ? `For ${booking.coupleName}` : undefined,
      presentedTo: billed.name || (booking && booking.coupleName),
      refs: [
        `Invoice ${inv.invoiceNumber}`,
        `Issued ${dateProse(inv.createdAt || new Date())}`,
        isTax ? "Place of supply \u2014 Karnataka (29)" : null,
        generatedRef(inv.createdAt || new Date()),
      ].filter(Boolean),
    },
    facts: [
      { label: "Supply", value: isTax ? ["Venue & event services", "SAC 996334"].join("\n") : "Venue & event services" },
      {
        label: "Against",
        value: [
          `Booking ${booking ? String(booking._id).slice(-6).toUpperCase() : DASH}`,
          window ? `Event ${window}` : null,
        ].filter(Boolean).join("\n"),
      },
      isTax ? { label: "Reverse charge", value: "Not applicable" } : null,
    ].filter(Boolean),
    items, sum,
    dueDate: inv.dueDate || null,
    // THE POSITION, printed from the invoice's own frozen snapshot (f5) —
    // never re-derived from the live schedule. Older invoices have none and
    // print none.
    position: inv.position || null,
    // ONE payment block (f6): bank transfer and UPI together, the QR beside
    // the UPI ID it encodes. The UPI line is split out so the two halves of
    // "how to pay us" are never separated by the amount again.
    remit: identity.bank ? {
      lines: bankLines(identity.bank).filter((l) => !/^UPI /.test(l)),
      upiId: (identity.bank.upiId || ""),
    } : null,
    payQr,
    noteLines: [],
    signatory: null,
  };
}

// ── 4. STATEMENT OF ACCOUNT ─────────────────────────────────────────────────
function assembleStatement({ venue, lead, booking, summary, logoBuffer }) {
  const pct = Number(booking.gstPercent) || 0;
  const isLegacy = !(booking.lineItems || []).length;
  const legacy = isLegacy ? legacyAssembly(booking) : null;
  const lines = isLegacy ? [] : (booking.lineItems || []).map((l) => lineFigures(l, pct));
  const extras = ((booking.paymentSchedule || []).filter((r) => r.isAdditional)).map((r) => ({
    label: r.label + (r.foldedInto ? "" : ""), amount: Math.round(Number(r.amount) || 0), gst: 0,
    foldedIntoLabel: null,
  }));
  const totals = isLegacy ? legacy.totals : documentTotals(booking.lineItems || [],
    (booking.paymentSchedule || []).filter((r) => r.isAdditional).map((r) => ({ label: r.label, amount: r.amount, gstTreatment: "none" })), pct);
  const received = (summary && summary.totals && summary.totals.received) || 0;
  const outstanding = Math.max(0, totals.collectable - received);
  const schedule = isLegacy ? legacy.schedule : shapeSchedule(booking, totals);
  // payment sub-rows: one per instalment a payment touched, split stated
  const paymentSubRows = [];
  for (const r of (booking.paymentSchedule || [])) {
    const approved = (r.entries || []).filter((e) => e.status === "approved");
    for (const e of approved) {
      const siblings = [];
      for (const r2 of booking.paymentSchedule) {
        for (const e2 of (r2.entries || [])) {
          if (e.paymentId && e2.paymentId && String(e2.paymentId) === String(e.paymentId)) siblings.push({ row: r2, entry: e2 });
        }
      }
      const totalPaid = siblings.reduce((s, x) => s + Math.round(Number(x.entry.amount) || 0), 0);
      const here = Math.round(Number(e.amount) || 0);
      const text = siblings.length > 1
        ? `${money(totalPaid)} on ${dateCell(e.date)}, of which ${money(here)} to this instalment`
        : `${money(here)} received on ${dateCell(e.date)}`;
      paymentSubRows.push({ rowRef: r._id, text, amountText: null });
    }
  }
  const paymentDates = (booking.paymentSchedule || []).flatMap((r) => (r.entries || []).filter((e) => e.status === "approved").map((e) => new Date(e.date)));
  const receivedSub = paymentDates.length
    ? `${paymentDates.length} payment${paymentDates.length === 1 ? "" : "s"}, ${dateCell(new Date(Math.min(...paymentDates)))} – ${dateCell(new Date(Math.max(...paymentDates)))}`
    : "No payments yet";
  const overdueTotal = (summary && summary.overdueTotal) || 0;
  const stIdentity = identityFrom(venue, logoBuffer);
  const stContact = primaryContactOf(lead);
  return {
    identity: stIdentity,
    parties: {
      venue: venueParty(stIdentity),
      client: clientParty({
        name: booking.coupleName,
        contact: stContact || (booking.couplePhone ? { phone: booking.couplePhone } : null),
        clientDetails: booking.clientDetails,
        gstin: ((booking.clientDetails || {}).gstin) || (stContact && stContact.gstin) || "",
      }),
    },
    meta: { reference: `Statement \u00b7 Booking ${String(booking._id).slice(-6).toUpperCase()}` },
    titleMeta: {
      eyebrow: "Statement of account",
      title: booking.coupleName || "Statement",
      subject: `As of ${dateProse(new Date())}`,
      presentedTo: booking.coupleName,
      // "As of <today>" above IS this copy's date — a Generated ref beside it
      // would say the same thing twice on every copy (finding 1's rule)
      refs: [`Booking ${String(booking._id).slice(-6).toUpperCase()}`, `Event ${dateProse((booking.days && booking.days[0] && booking.days[0].date) || booking.checkIn)}`],
    },
    bookedOn: booking.createdAt,
    priced: isLegacy ? legacy.priced : lines.filter((l) => !l.refundable),
    refundables: isLegacy ? [] : lines.filter((l) => l.refundable),
    extras,
    totals,
    received, outstanding, receivedSub, overdueTotal,
    schedule,
    paymentSubRows,
    contactLine: null,
    noteLines: ["Figures as recorded on the booking as of the date above. Payments claimed but not yet approved are not included."],
    signatory: null,
  };
}

// ── 5. PAYMENT RECEIPT ──────────────────────────────────────────────────────
function assembleReceipt({ venue, lead, booking, summary, paymentId, logoBuffer }) {
  const pct = Number(booking.gstPercent) || 0;
  const isLegacy = !(booking.lineItems || []).length;
  const totals = isLegacy ? legacyAssembly(booking).totals : documentTotals(booking.lineItems || [],
    (booking.paymentSchedule || []).filter((r) => r.isAdditional).map((r) => ({ label: r.label, amount: r.amount, gstTreatment: "none" })), pct);
  const pieces = [];
  for (const r of (booking.paymentSchedule || [])) {
    for (const e of (r.entries || [])) {
      // An entry WITHOUT a paymentId (a wizard-recorded token, a legacy row)
      // must never match — String(undefined) === String(undefined) let a
      // nonsense id print a receipt for the wrong payment, caught live.
      if (!e.paymentId || !paymentId) continue;
      if (String(e.paymentId) === String(paymentId) && e.status === "approved") pieces.push({ row: r, entry: e });
    }
  }
  if (!pieces.length) return null;
  const amount = pieces.reduce((s, x) => s + Math.round(Number(x.entry.amount) || 0), 0);
  const first = pieces[0].entry;
  const received = (summary && summary.totals && summary.totals.received) || 0;
  const outstanding = Math.max(0, totals.collectable - received);
  const applied = pieces.map((x, i) => {
    const here = Math.round(Number(x.entry.amount) || 0);
    const rowPaid = receivedOn(x.row);
    const left = Math.max(0, Math.round(Number(x.row.amount) || 0) - rowPaid);
    return {
      label: x.row.label || "Instalment",
      subLine: pieces.length > 1
        ? `${money(amount)} in one payment, of which ${money(here)} to this instalment`
        : undefined,
      reference: x.entry.reference || null,
      amount: here,
      left,
    };
  });
  const next = (summary && summary.next) || null;
  const modeLabel = { bank_transfer: "Bank transfer", cash: "Cash", cheque: "Cheque", upi: "UPI", card: "Card", other: "Other" }[first.method] || first.method || DASH;
  const rcIdentity = identityFrom(venue, logoBuffer);
  const rcContact = primaryContactOf(lead);
  return {
    identity: rcIdentity,
    parties: {
      venue: venueParty(rcIdentity),
      client: clientParty({
        name: booking.coupleName,
        contact: rcContact || (booking.couplePhone ? { phone: booking.couplePhone } : null),
        clientDetails: booking.clientDetails,
        gstin: ((booking.clientDetails || {}).gstin) || (rcContact && rcContact.gstin) || "",
      }),
    },
    meta: { reference: `Receipt \u00b7 ${String(paymentId).slice(-8).toUpperCase()}` },
    titleMeta: {
      eyebrow: "Payment receipt",
      title: "Received, with thanks",
      subject: booking.coupleName ? `From ${booking.coupleName}` : undefined,
      presentedTo: booking.coupleName,
      refs: [`Receipt ${String(paymentId).slice(-8).toUpperCase()}`, `Generated ${dateProse(new Date())}`],
    },
    amount,
    receivedOn: first.date,
    mode: modeLabel,
    reference: first.reference || null,
    from: booking.coupleName || null,
    creditedTo: null,
    applied,
    totals,
    received, outstanding,
    nextDue: next && next.outstanding > 0 ? `Next due: ${next.label || "Instalment"} — ${money(next.outstanding)} by ${dateProse(next.dueDate)}.` : null,
    noteLines: [],
    signatory: null,
  };
}

module.exports = { identityFrom, assembleQuote, assembleConfirmation, assembleInvoice, assembleStatement, assembleReceipt };
