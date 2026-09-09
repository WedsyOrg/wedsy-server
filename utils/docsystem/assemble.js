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
    // Settings → Business bank details — null when the venue filled nothing,
    // and the payment block then does not exist (no heading, no empty rows).
    bank: b.hasBank ? b.bank : null,
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
  return {
    identity: identityFrom(venue, logoBuffer),
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
  // The header carries the BRAND ALONE on this document (finding 6): the
  // venue block below is the registration record, so PAN and GSTIN print
  // there and not twice.
  identity.headerBrandOnly = true;
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
      refs: [bookingRef, `Confirmed ${dateProse(booking.createdAt)}`],
    },
    intro: "The booking amount has been received and the dates below are held exclusively. This page records the agreed amount and the plan for the balance.",
    // venue left, client right — as Indian tax documents read. Address and
    // GSTIN are not collected for clients yet (the People model has no such
    // fields); the block renders whichever facts exist and nothing where
    // they are absent, so it grows the day the collection step lands.
    parties: {
      venue: {
        name: identity.name,
        // name, address, PAN, GSTIN, phone (finding 7) — the header lost the
        // registrations to this block, so this block must actually carry them
        lines: [
          ...(identity.addressLines || []),
          identity.pan ? `PAN ${identity.pan}` : null,
          identity.gstin ? `GSTIN ${identity.gstin}` : null,
          [identity.phone, identity.email].filter(Boolean).join(" · ") || null,
        ].filter(Boolean),
      },
      client: (() => {
        // Address + GSTIN come from the BOOKING'S OWN SNAPSHOT (clientDetails,
        // written at confirm, edited only through the People tab's logged
        // edit) — the disputed-document rule. The GSTIN falls back to the
        // live contact for bookings that predate the snapshot, because those
        // invoices already print it from there.
        const cdd = (booking.clientDetails) || {};
        const addressLine = [cdd.house, cdd.street].filter(Boolean).join(", ");
        const cityLine = [cdd.city, cdd.pincode].filter(Boolean).join(" ");
        const gstin = cdd.gstin || (primaryContact && primaryContact.gstin) || "";
        return {
          name: booking.coupleName || (primaryContact && primaryContact.name) || null,
          lines: [
            primaryContact && primaryContact.name && primaryContact.name !== booking.coupleName ? primaryContact.name : null,
            (primaryContact && primaryContact.phone) || booking.couplePhone || null,
            (primaryContact && primaryContact.email) || null,
            addressLine || null,
            cityLine || null,
            gstin ? `GSTIN ${gstin}` : null,
          ].filter(Boolean),
        };
      })(),
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
function assembleInvoice({ venue, lead, booking, invoice, logoBuffer }) {
  const inv = invoice;
  const half = (n) => Math.round((Number(n) || 0) / 2);
  const items = (inv.lineItems || []).map((li) => {
    const amount = Math.round((Number(li.qty) || 1) * (Number(li.unitPrice) || 0));
    const hasFacts = li.taxable !== null && li.taxable !== undefined && li.gst !== null && li.gst !== undefined;
    const taxable = hasFacts ? Math.round(Number(li.taxable) || 0) : null;
    const gst = hasFacts ? Math.round(Number(li.gst) || 0) : null;
    return {
      label: li.label || "Charge",
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
  if (isTax) identity.stateLine = "State code 29 · Karnataka";
  else { identity.gstin = ""; identity.pan = ""; }
  return {
    identity,
    plain: !isTax,
    meta: { reference: inv.invoiceNumber },
    titleMeta: {
      eyebrow: isTax ? "Tax invoice" : "Invoice",
      title: inv.kind === "addon" ? "Additional billing" : inv.kind === "final" ? "Final instalment" : "Instalment",
      subject: booking && booking.coupleName ? `For ${booking.coupleName}` : undefined,
      presentedTo: billed.name || (booking && booking.coupleName),
      refs: [
        `Invoice ${inv.invoiceNumber}`,
        `Issued ${dateProse(inv.createdAt || new Date())}`,
        isTax ? "Place of supply — Karnataka (29)" : null,
      ].filter(Boolean),
    },
    facts: [
      {
        label: "Billed to",
        value: [
          billed.name || (booking && booking.coupleName),
          isTax ? (billed.gstin ? `GSTIN ${billed.gstin}` : "GSTIN — unregistered (B2C)") : null,
        ].filter(Boolean).join("\n"),
      },
      { label: "Supply", value: isTax ? ["Venue & event services", "SAC 996334"].join("\n") : "Venue & event services" },
      {
        label: "Against",
        value: [
          `Booking ${booking ? String(booking._id).slice(-6).toUpperCase() : DASH}`,
          isTax ? "Reverse charge — not applicable" : null,
        ].filter(Boolean).join("\n"),
      },
    ],
    items, sum,
    dueDate: inv.dueDate || null,
    // The amount-due block's designed remit slot. Composed from Settings →
    // Business; null when nothing is filled, and the slot then never draws.
    remit: identity.bank ? bankLines(identity.bank).join("\n") : null,
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
  return {
    identity: identityFrom(venue, logoBuffer),
    meta: { reference: `Statement · Booking ${String(booking._id).slice(-6).toUpperCase()}` },
    titleMeta: {
      eyebrow: "Statement of account",
      title: booking.coupleName || "Statement",
      subject: `As of ${dateProse(new Date())}`,
      presentedTo: booking.coupleName,
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
  return {
    identity: identityFrom(venue, logoBuffer),
    meta: { reference: `Receipt · ${String(paymentId).slice(-8).toUpperCase()}` },
    titleMeta: {
      eyebrow: "Payment receipt",
      title: "Received, with thanks",
      subject: booking.coupleName ? `From ${booking.coupleName}` : undefined,
      presentedTo: booking.coupleName,
      refs: [`Receipt ${String(paymentId).slice(-8).toUpperCase()}`, `Issued ${dateProse(new Date())}`],
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
