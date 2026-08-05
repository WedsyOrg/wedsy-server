// THE OPS SHEET — server-side .xlsx export of a Build & Bill draft (exceljs;
// deliberately NOT Puppeteer — Chromium OOMs the t3.micro, exceljs streams).
// One sheet per event day + a Summary sheet first. Totals are NEVER recomputed
// here — every money row comes from the server's own totals object
// (DraftEventService.totalsFor via getDraftDetail) or stored line prices.
// Images are best-effort: any fetch failure leaves the cell blank; capped
// concurrency + a global time budget guard the whole pass.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const DraftEventService = require("./DraftEventService");
const Enquiry = require("../models/Enquiry");
const Category = require("../models/Category");

const err = (status, message) => Object.assign(new Error(message), { status });

const RUPEE_FMT = '"₹"#,##0';
const GREY = "FF9A9A9A";
const BAND_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EFE7" } };
const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9E2D4" } };

const IMAGE_CONCURRENCY = 4;
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const IMAGE_TOTAL_BUDGET_MS = 25000;

// ── image fetching (best-effort, never throws) ───────────────────────────────
const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif" };
const fetchImage = async (url) => {
  try {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const resp = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const mime = String(resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const extension = EXT_BY_MIME[mime];
    if (!extension) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
    return { buffer, extension };
  } catch {
    return null; // an image must never fail the export
  }
};
// url → {buffer, extension}|null, deduped, concurrency-capped, time-budgeted.
const fetchImages = async (urls) => {
  const unique = [...new Set(urls.filter(Boolean))];
  const out = new Map();
  const started = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < unique.length) {
      if (Date.now() - started > IMAGE_TOTAL_BUDGET_MS) return; // budget spent — rest stay blank
      const url = unique[i++];
      out.set(url, await fetchImage(url));
    }
  };
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
  return out;
};

// ── helpers ──────────────────────────────────────────────────────────────────
const sheetNameFor = (raw, used) => {
  let name = String(raw || "Event").replace(/[\[\]:*?/\\]/g, "-").slice(0, 28).trim() || "Event";
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${name} (${n++})`;
  used.add(candidate.toLowerCase());
  return candidate;
};

const strikeRow = (row) => {
  row.eachCell({ includeEmpty: false }, (c) => {
    c.font = { ...(c.font || {}), strike: true, color: { argb: GREY } };
  });
};

// OS render order: single-view categories first, then group-view; each set by
// the Category.order field, unknown categories last alphabetically.
const categoryOrderer = async () => {
  const cats = await Category.find({}, { name: 1, order: 1, adminEventToolView: 1 }).lean().catch(() => []);
  const rank = new Map();
  const sorted = [...cats].sort((a, b) => ((a.order ?? 1e9) - (b.order ?? 1e9)));
  let i = 0;
  for (const c of sorted.filter((c) => c.adminEventToolView !== "group")) rank.set(c.name, i++);
  for (const c of sorted.filter((c) => c.adminEventToolView === "group")) rank.set(c.name, 1000 + i++);
  return (a, b) => {
    const ra = rank.has(a) ? rank.get(a) : 1e9;
    const rb = rank.has(b) ? rank.get(b) : 1e9;
    return ra !== rb ? ra - rb : String(a).localeCompare(String(b));
  };
};

// "Generator · 64Kw · 6hrs" / "Transportation & Logistics · {note}"
const mandatoryLabel = (mi) => {
  const bits = [mi.title];
  const sel = mi.selection && typeof mi.selection === "object" ? Object.values(mi.selection).filter(Boolean) : [];
  if (sel.length) bits.push(...sel);
  else if (mi.note) bits.push(mi.note);
  return bits.join(" · ");
};

const paxResolver = (lead) => {
  const map = new Map();
  for (const d of (lead && lead.qualificationData && lead.qualificationData.eventDays) || []) {
    for (const fn of (d && d.functions) || []) {
      if (fn && fn.type) map.set(`${String(fn.type).toLowerCase()}|${String(d.date || "")}`, fn.pax || "");
    }
  }
  return (day) => map.get(`${String(day.name || "").toLowerCase()}|${String(day.date || "")}`) || "—";
};

// ── CLIENT QUOTE layout (?layout=quote) ──────────────────────────────────────
// ONE continuous branded sheet — no per-event tabs, no summary tab. Hero band,
// a single header row, every event's items running straight into the next, and
// the whole-wedding closing block last. DISPLAY ONLY: every rupee shown is the
// server's own number (totals.days[].total / totals.eventLevelItems /
// totals.net) or the item's stored `price`; the platform/flooring split is a
// presentation of `price`, never a re-derivation of it.
const QUOTE_SHEET = "Client Quote";
const QUOTE_COLS = [
  { header: "Date", width: 9 },
  { header: "Event", width: 13 },
  { header: "Category", width: 17 },
  { header: "Image", width: 19 },
  { header: "Item description", width: 31 },
  { header: "Notes", width: 19 },
  { header: "Notes Ref Image", width: 16 },
  { header: "Pricing", width: 13 },
];
// Excel's char-unit → pixel rule (px = round(chars × 7) + 5); needed because
// image placement is in pixels but columns are sized in char units.
const COL_PX = QUOTE_COLS.map((c) => Math.round(c.width * 7) + 5);
const PT_PX = 4 / 3; // points → pixels (96dpi)

// STYLE TOKENS — sampled from assets/logo-black.png.
const Q_MAROON = "FF842B2E"; // header fill + event-total start
const Q_DEEP = "FF5D2021"; // grand total + gradient end
const Q_BRIGHT = "FFAD373B"; // gradient start
const Q_INK = "FF1C1815";
const Q_MUTED = "FF6B655E";
const Q_BORDER = "FFD9D3C9";
const Q_WHITE = "FFFFFFFF";
const Q_MONEY = '"₹"#,##,##0;-"₹"#,##,##0;"—"'; // Indian grouping; zero renders as —
const Q_GRADIENT = {
  type: "gradient",
  gradient: "angle",
  degree: 0,
  stops: [
    { position: 0, color: { argb: Q_BRIGHT } },
    { position: 1, color: { argb: Q_DEEP } },
  ],
};
const LOGO_PATH = path.join(__dirname, "../assets/logo-black.png");
const LOGO_W = 340;
const LOGO_H = 88; // 1220×315 → 3.873:1; 340×88 preserves it (no squash)

const ITEM_ROW_PT = 78; // an item/note row — tall enough for a large image
const SUB_ROW_PT = 18; // the ↳ Platform / ↳ Flooring sub-row
const FLAT_ROW_PT = 24; // package / custom / mandatory rows (no image)
const IMG_PAD = 4;

// ── image geometry ───────────────────────────────────────────────────────────
// Natural pixel size straight off the buffer — no image library. Unknown
// format → null, and the caller then fills the box (never distorts a known one).
const imageSize = (buffer, extension) => {
  try {
    if (extension === "png" && buffer.length > 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
      return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    }
    if (extension === "gif" && buffer.length > 10) {
      return { w: buffer.readUInt16LE(6), h: buffer.readUInt16LE(8) };
    }
    if (extension === "jpeg") {
      let p = 2;
      while (p + 9 < buffer.length) {
        if (buffer[p] !== 0xff) { p++; continue; }
        const marker = buffer[p + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buffer.readUInt16BE(p + 5), w: buffer.readUInt16BE(p + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
        p += 2 + buffer.readUInt16BE(p + 2);
      }
    }
  } catch {
    /* unreadable header — fall through to null */
  }
  return null;
};

// Fit-to-cell, aspect preserved, centred in the (possibly merged) cell box.
// col/row are 0-based/1-based exactly as exceljs wants them.
const placeImage = (wb, ws, img, { col, row, spanRows, rowPt }) => {
  if (!img || !img.buffer) return false;
  const boxW = COL_PX[col] - IMG_PAD * 2;
  const rowPx = rowPt * PT_PX;
  const boxH = spanRows * rowPx - IMG_PAD * 2;
  if (boxW <= 0 || boxH <= 0) return false;
  const natural = imageSize(img.buffer, img.extension) || { w: boxW, h: boxH };
  const scale = Math.min(boxW / natural.w, boxH / natural.h);
  const w = Math.max(1, natural.w * scale);
  const h = Math.max(1, natural.h * scale);
  const imageId = wb.addImage({ buffer: img.buffer, extension: img.extension });
  ws.addImage(imageId, {
    tl: {
      col: col + (IMG_PAD + (boxW - w) / 2) / COL_PX[col],
      row: row - 1 + (IMG_PAD + (boxH - h) / 2) / rowPx,
    },
    ext: { width: w, height: h },
    editAs: "oneCell",
  });
  return true;
};

// ── hero copy ────────────────────────────────────────────────────────────────
const Q_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parseDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};
const shortDate = (s) => {
  const d = parseDay(s);
  return d ? `${d.getDate()} ${Q_MONTHS[d.getMonth()]}` : String(s || "—");
};
const longDate = (s) => {
  const d = parseDay(s);
  return d ? `${d.getDate()} ${Q_MONTHS[d.getMonth()]} ${d.getFullYear()}` : String(s || "");
};
const dateRangeOf = (days) => {
  const dated = (days || []).map((d) => d && d.date).filter((s) => parseDay(s)).sort();
  if (!dated.length) return "";
  const a = dated[0];
  const b = dated[dated.length - 1];
  return a === b ? longDate(a) : `${longDate(a)} – ${longDate(b)}`;
};
// "Groom & Bride"; either name missing → the lead's own name.
const coupleNameOf = (lead) => {
  const q = (lead && lead.qualificationData) || {};
  const groom = String(q.groomName || "").trim();
  const bride = String(q.brideName || "").trim();
  if (groom && bride) return `${groom} & ${bride}`;
  return String((lead && lead.name) || "").trim() || "Wedsy Client";
};
// pax lives per FUNCTION as a free string ("250", "~300 pax"); the hero shows
// the biggest one that parses, and nothing at all when none do.
const maxPaxOf = (lead) => {
  let max = 0;
  for (const d of (lead && lead.qualificationData && lead.qualificationData.eventDays) || []) {
    for (const fn of (d && d.functions) || []) {
      const n = Number(String((fn && fn.pax) || "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max || null;
};

// ── per-item money split (DISPLAY of the stored price, not a recompute) ──────
// The legs mirror eventDecorPricing.lineTotal exactly so the sub-row can be
// labelled correctly; the sub-row's VALUE is the remainder of the stored price,
// so parent + sub ≡ item.price to the rupee whatever the util rounded.
const priceLegs = (it) => {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const qty = num(it.quantity);
  const dim = it.dimensions || {};
  const L = num(dim.length);
  const B = num(dim.breadth);
  const H = num(dim.height);
  const pathwayMult = it.category === "Pathway" ? qty : 1;
  const addOns = (Array.isArray(it.addOns) ? it.addOns : []).reduce(
    (s, a) => s + num(a && a.price) * (a && a.quantity !== undefined ? num(a.quantity) : 1),
    0
  );
  const product = Math.round(qty * (num(it.decorPrice) + num(it.priceModifier) + num(it.priceAdj)) + addOns);
  const platformLeg = (it.platform ? L * B * num(it.platformRate) : 0) * pathwayMult;
  const flooringLeg = (L + H) * (B + H) * num(it.flooringRate) * pathwayMult;
  const line = num(it.price);
  return { product, extra: line - product, platformLeg, flooringLeg, line };
};

// The E column: the item's name, then its descriptive sub-components. Notes are
// deliberately ABSENT — they render one-per-row in F with their image in G.
const describeParts = (it) => {
  const detail = [];
  if (it.variant && it.variant !== it.productVariant && it.variant !== "Standard") detail.push(it.variant);
  if (it.productVariant && it.productVariant !== "Standard" && it.productVariant !== it.variant) detail.push(it.productVariant);
  if (Number(it.quantity) > 1) detail.push(`Qty ${it.quantity}${it.unit ? ` ${it.unit}` : ""}`);
  const included = [];
  const colours = [it.primaryColor, it.secondaryColor, it.tertiaryColor].filter(Boolean);
  if (colours.length) included.push(colours.join(" · "));
  for (const inc of (it.included || []).filter(Boolean)) included.push(inc);
  for (const a of (it.addOns || []).filter((a) => a && a.name)) {
    included.push(Number(a.quantity) > 1 ? `${a.name} ×${a.quantity}` : a.name);
  }
  if (included.length) detail.push(`Included: ${included.join("; ")}`);
  if (it.setupLocation) detail.push(`Setup: ${it.setupLocation}`);
  return { head: it.name || "Item", detail };
};
const singleDesc = (it) => {
  const { head, detail } = describeParts(it);
  return [head, ...detail].join("\n");
};
const groupDesc = (it) => {
  const { head, detail } = describeParts(it);
  return detail.length ? `${head} — ${detail.join(" · ")}` : head;
};
// The sub-row's E: size + flooring type, one line.
const platformDesc = (it) => {
  const d = it.dimensions || {};
  const bits = [];
  if (it.platform) bits.push(`${d.length || 0} × ${d.breadth || 0} × ${d.height || 0} ft`);
  else if (d.length || d.breadth) bits.push(`${d.length || 0} × ${d.breadth || 0} ft`);
  if (it.flooring) bits.push(`${it.flooring} flooring`);
  return bits.join(" · ") || "Platform & flooring";
};
const quoteMandatoryDesc = (mi) => {
  const sel = mi.selection && typeof mi.selection === "object" ? Object.values(mi.selection).filter(Boolean) : [];
  if (sel.length) return `${mi.title} — ${sel.join(", ")}`;
  if (mi.note) return `${mi.title} — ${mi.note}`;
  return mi.title || "Item";
};
const PACKAGE_VARIANT = {
  artificialFlowers: "Artificial flowers",
  naturalFlowers: "Natural flowers",
  mixedFlowers: "Mixed flowers",
};

// Categories rendered in "group" mode in the admin event tool — everything
// else (including a category with no view set) renders "single".
const groupViewSet = async () => {
  const cats = await Category.find({}, { name: 1, adminEventToolView: 1 }).lean().catch(() => []);
  return new Set(cats.filter((c) => c.adminEventToolView === "group").map((c) => c.name));
};

const buildQuoteBody = async ({ wb, detail, totals, lead, images, usedNames, withPrice, includeExcluded }) => {
  const byCategory = await categoryOrderer();
  const isGroupView = await groupViewSet();

  const ws = wb.addWorksheet(sheetNameFor(QUOTE_SHEET, usedNames), {
    views: [{ showGridLines: false }],
    // exceljs treats width 9 as "not custom" and omits its <col> entry, so
    // column A would fall back to Excel's 8.43 default. Declaring the sheet
    // default as 9 pins A at exactly the spec'd width.
    properties: { defaultColWidth: 9 },
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2, header: 0, footer: 0 },
    },
  });
  ws.columns = QUOTE_COLS.map((c) => ({ width: c.width }));

  const CENTER = { horizontal: "center", vertical: "middle", wrapText: true };
  const font = (extra = {}) => ({ name: "Arial", size: 10, color: { argb: Q_INK }, ...extra });
  const MUTED = font({ color: { argb: Q_MUTED } });
  const MUTED_ITALIC = font({ color: { argb: Q_MUTED }, italic: true, size: 9 });
  const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const thin = { style: "thin", color: { argb: Q_BORDER } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  // Borders + centring land on FILLED rows only; the hero band above stays bare.
  const dressRow = (rowNumber, { height, fill, rowFont } = {}) => {
    const row = ws.getRow(rowNumber);
    if (height) row.height = height;
    for (let c = 1; c <= QUOTE_COLS.length; c++) {
      const cell = row.getCell(c);
      cell.alignment = CENTER;
      cell.border = BORDER;
      cell.font = rowFont || font();
      if (fill) cell.fill = fill;
    }
    return row;
  };
  // withPrice=false blanks column H and keeps the layout intact.
  const money = (cell, value, { muted = false } = {}) => {
    if (!withPrice) return;
    cell.value = Math.round(Number(value) || 0);
    cell.numFmt = Q_MONEY;
    if (muted) cell.font = { ...(cell.font || {}), color: { argb: Q_MUTED }, italic: true };
  };

  // ── HERO (rows 2–4) ──
  ws.getRow(1).height = 6;
  ws.getRow(2).height = 26;
  ws.getRow(3).height = 20;
  ws.getRow(4).height = 20; // 66pt == 88px == the logo's height
  ws.getRow(5).height = 6; // 8px spacer
  try {
    const logo = fs.readFileSync(LOGO_PATH);
    const logoId = wb.addImage({ buffer: logo, extension: "png" });
    ws.addImage(logoId, { tl: { col: 0, row: 1 }, ext: { width: LOGO_W, height: LOGO_H }, editAs: "oneCell" });
  } catch (e) {
    console.error("[quote] logo unavailable:", e.message); // flag, never fake
  }
  const heroLine = (rowNumber, text, cellFont) => {
    ws.mergeCells(rowNumber, 7, rowNumber, 8);
    const cell = ws.getCell(rowNumber, 7);
    cell.value = text;
    cell.alignment = { horizontal: "right", vertical: "middle" };
    cell.font = cellFont;
  };
  const pax = maxPaxOf(lead);
  heroLine(2, coupleNameOf(lead), font({ size: 14, bold: true, color: { argb: Q_MAROON } }));
  heroLine(3, dateRangeOf(detail.days), MUTED);
  heroLine(4, `Décor Quote${pax ? ` · ${pax} guests` : ""}`, MUTED);

  // ── HEADER (row 6) ──
  const header = ws.getRow(6);
  QUOTE_COLS.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  dressRow(6, { height: 22, fill: solid(Q_MAROON), rowFont: font({ bold: true, size: 10.5, color: { argb: Q_WHITE } }) });

  let r = 7;
  let renderedGrand = 0;

  // One flat row (packages / custom / mandatory / any image-less line).
  const flatRow = ({ desc, note, amount, excluded }) => {
    const row = dressRow(r, { height: FLAT_ROW_PT, rowFont: excluded ? MUTED : font() });
    row.getCell(5).value = excluded ? `${desc}\nNot included` : desc;
    if (note) row.getCell(6).value = note;
    money(row.getCell(8), amount, { muted: excluded });
    r++;
  };
  // The ↳ Platform / ↳ Flooring sub-row. Its H is the REMAINDER of the stored
  // price, so parent + sub is the item's full line exactly.
  const subRow = (it, legs, excluded) => {
    if (legs.platformLeg + legs.flooringLeg <= 0) return;
    const row = dressRow(r, { height: SUB_ROW_PT, rowFont: MUTED_ITALIC });
    row.getCell(3).value = legs.platformLeg > 0 ? "↳ Platform" : "↳ Flooring";
    row.getCell(5).value = platformDesc(it);
    money(row.getCell(8), legs.extra, { muted: true });
    r++;
  };

  for (const day of detail.days || []) {
    const eventFirstRow = r;
    let eventRendered = 0;

    const decor = (day.decorItems || []).filter((it) => includeExcluded || it.includedInTotal !== false);
    const cats = [...new Set(decor.map((it) => it.category || "Décor"))].sort(byCategory);

    for (const cat of cats) {
      const items = decor.filter((it) => (it.category || "Décor") === cat);
      const catFirstRow = r;

      if (isGroupView.has(cat)) {
        // GROUP — the category name merges down every item; each item is a row.
        for (const it of items) {
          const legs = priceLegs(it);
          const excluded = it.includedInTotal === false;
          const row = dressRow(r, { height: ITEM_ROW_PT, rowFont: excluded ? MUTED : font() });
          row.getCell(5).value = excluded ? `${groupDesc(it)}\nNot included` : groupDesc(it);
          money(row.getCell(8), legs.product, { muted: excluded });
          if (it.thumbnail) placeImage(wb, ws, images.get(it.thumbnail), { col: 3, row: r, spanRows: 1, rowPt: ITEM_ROW_PT });
          r++;
          subRow(it, legs, excluded);
          if (!excluded) { eventRendered += legs.line; }
        }
        const catLastRow = r - 1;
        if (catLastRow > catFirstRow) {
          ws.mergeCells(catFirstRow, 3, catLastRow, 3);
          ws.mergeCells(catFirstRow, 6, catLastRow, 6); // the category's COMMON note
          ws.mergeCells(catFirstRow, 7, catLastRow, 7); // G mirrors the merge (group notes carry no image)
        }
        ws.getCell(catFirstRow, 3).value = cat;
        const catNote = (day.categoryNotes || []).find((c) => c && c.category === cat);
        if (catNote && catNote.note) ws.getCell(catFirstRow, 6).value = catNote.note;
      } else {
        // SINGLE — one detail block per item; notes one-per-row in F with that
        // note's ONE ref image in G on the SAME row.
        for (const it of items) {
          const legs = priceLegs(it);
          const excluded = it.includedInTotal === false;
          const notes = (it.notes || []).filter((n) => n && (n.text || n.image));
          const span = Math.max(1, notes.length);
          const blockFirst = r;
          for (let i = 0; i < span; i++) {
            const row = dressRow(r, { height: ITEM_ROW_PT, rowFont: excluded ? MUTED : font() });
            if (i === 0) {
              row.getCell(3).value = cat;
              row.getCell(5).value = excluded ? `${singleDesc(it)}\nNot included` : singleDesc(it);
              money(row.getCell(8), legs.product, { muted: excluded });
            }
            if (notes[i] && notes[i].text) row.getCell(6).value = notes[i].text;
            r++;
          }
          const blockLast = blockFirst + span - 1;
          if (span > 1) for (const c of [3, 4, 5, 8]) ws.mergeCells(blockFirst, c, blockLast, c);
          if (it.thumbnail) placeImage(wb, ws, images.get(it.thumbnail), { col: 3, row: blockFirst, spanRows: span, rowPt: ITEM_ROW_PT });
          notes.forEach((n, i) => {
            if (n.image) placeImage(wb, ws, images.get(n.image), { col: 6, row: blockFirst + i, spanRows: 1, rowPt: ITEM_ROW_PT });
          });
          subRow(it, legs, excluded);
          if (!excluded) { eventRendered += legs.line; }
        }
        const catLastRow = r - 1;
        if (catLastRow >= catFirstRow) ws.getCell(catFirstRow, 3).value = cat;
      }
    }

    // Packages / ES custom / ES mandatory — they are part of the server's event
    // total, so they must be on the sheet for it to reconcile.
    const extras = [
      { cat: "Packages", entries: (day.packages || []).map((p) => ({
        desc: `Décor package${p && p.variant ? ` (${PACKAGE_VARIANT[p.variant] || p.variant})` : ""}`,
        note: (p && p.user_notes) || "", amount: Number(p && p.price) || 0, excluded: false,
      })) },
      { cat: day.customItemsTitle || "Additional", entries: (day.customItems || [])
        .filter((c) => c && !c.includeInTotalSummary)
        .filter((c) => includeExcluded || c.includedInTotal !== false)
        .map((c) => ({
          desc: `${c.name || "Custom item"}${Number(c.quantity) > 1 ? ` ×${c.quantity}` : ""}`,
          note: c.notes || "", amount: Number(c.price) || 0, excluded: c.includedInTotal === false,
        })) },
      { cat: "Logistics", entries: (day.mandatoryItems || [])
        .filter((mi) => mi && mi.itemRequired && !mi.includeInTotalSummary)
        .map((mi) => ({ desc: quoteMandatoryDesc(mi), note: mi.description || "", amount: Number(mi.price) || 0, excluded: false })) },
    ];
    for (const block of extras) {
      if (!block.entries.length) continue;
      const blockFirst = r;
      for (const e of block.entries) {
        flatRow(e);
        if (!e.excluded) eventRendered += e.amount;
      }
      const blockLast = r - 1;
      if (blockLast > blockFirst) ws.mergeCells(blockFirst, 3, blockLast, 3);
      ws.getCell(blockFirst, 3).value = block.cat;
    }

    const eventLastRow = r - 1;
    const serverRow = (totals.days || []).find((d) => d.dayId === day.dayId) || {};
    const eventTotal = Number(serverRow.total) || 0;
    if (eventLastRow < eventFirstRow && !eventTotal) continue; // an empty, costless day adds nothing

    // Date + Event identify the whole block.
    if (eventLastRow >= eventFirstRow) {
      if (eventLastRow > eventFirstRow) {
        ws.mergeCells(eventFirstRow, 1, eventLastRow, 1);
        ws.mergeCells(eventFirstRow, 2, eventLastRow, 2);
      }
      ws.getCell(eventFirstRow, 1).value = shortDate(day.date);
      ws.getCell(eventFirstRow, 2).value = day.name || "Event";
      ws.getCell(eventFirstRow, 2).font = font({ bold: true });
    }

    // EVENT TOTAL — the server's per-day number, verbatim.
    const totalRow = dressRow(r, { height: 24, fill: Q_GRADIENT, rowFont: font({ bold: true, size: 11, color: { argb: Q_WHITE } }) });
    ws.mergeCells(r, 1, r, 7);
    totalRow.getCell(1).value = `${day.name || "Event"} — Event Total`;
    money(totalRow.getCell(8), eventTotal);
    r++;

    if (withPrice && Math.abs(eventRendered - eventTotal) > 1) {
      console.warn(`[quote] "${day.name}" rendered ₹${eventRendered} vs server ₹${eventTotal} — showing the server's figure`);
    }
    renderedGrand += eventTotal;
  }

  // ── CLOSING (whole wedding) ──
  const caption = dressRow(r, { height: 16, rowFont: MUTED_ITALIC });
  ws.mergeCells(r, 1, r, 8);
  caption.getCell(1).value = "Applies across all events";
  r++;

  // TS items — server-filtered (mandatory needs itemRequired; custom needs
  // includedInTotal !== false). They appear HERE and nowhere else, counted once.
  for (const ts of totals.eventLevelItems || []) {
    const row = dressRow(r, { height: 20 });
    ws.mergeCells(r, 1, r, 2);
    ws.mergeCells(r, 3, r, 7);
    row.getCell(1).value = ts.kind === "mandatory" ? "Mandatory" : "Additional";
    row.getCell(3).value = ts.name || "Item";
    money(row.getCell(8), Number(ts.price) || 0);
    r++;
  }
  renderedGrand += Number(totals.eventLevelTotal) || 0;

  const discount = Number(totals.discount) || 0;
  const discountRow = dressRow(r, { height: 20 });
  ws.mergeCells(r, 1, r, 7);
  discountRow.getCell(1).value = "Discount";
  money(discountRow.getCell(8), discount ? -discount : 0);
  r++;

  const net = totals.net != null ? Number(totals.net) : Number(totals.grandTotal) || 0;
  const grandRow = dressRow(r, { height: 28, fill: Q_GRADIENT, rowFont: font({ bold: true, size: 13, color: { argb: Q_WHITE } }) });
  ws.mergeCells(r, 1, r, 7);
  grandRow.getCell(1).value = "GRAND TOTAL";
  money(grandRow.getCell(8), net);
  r++;

  // Reconcile — Σ event totals + Σ TS − discount must be the server's net (which
  // clamps at 0). We print the server's figure either way and flag a drift.
  const expected = Math.max(0, renderedGrand - discount);
  if (withPrice && Math.abs(expected - net) > 1) {
    console.warn(`[quote] grand total reconcile drift: composed ₹${expected} vs server net ₹${net}`);
  }
};

// ── the workbook ─────────────────────────────────────────────────────────────
const buildWorkbook = async (leadId, eventId, { withPrice = true, includeExcluded = true, layout = "ops" } = {}) => {
  const detail = await DraftEventService.getDraftDetail(leadId, eventId);
  const lead = await Enquiry.findById(leadId, { name: 1, qualificationData: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const byCategory = await categoryOrderer();
  const paxOf = paxResolver(lead);
  const totals = detail.totals || {};

  // image pass (product thumbnails + setup photos + per-note ref images),
  // before any sheet work
  const urls = [];
  for (const day of detail.days || []) {
    for (const it of day.decorItems || []) {
      urls.push(it.thumbnail, it.setupLocationImage);
      for (const nt of it.notes || []) urls.push(nt && nt.image);
    }
  }
  const images = await fetchImages(urls);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wedsy OS";
  const usedNames = new Set();

  // CLIENT QUOTE layout is self-contained; the OPS layout below is unchanged.
  if (layout === "quote") {
    await buildQuoteBody({ wb, detail, totals, lead, images, usedNames, withPrice, includeExcluded });
    return wb;
  }

  // ── Summary sheet (first) ──
  const summary = wb.addWorksheet(sheetNameFor("Summary", usedNames));
  summary.columns = [{ width: 34 }, { width: 16 }, { width: 16 }];
  const title = summary.addRow([detail.name || "Draft"]);
  title.font = { bold: true, size: 14 };
  summary.addRow([]);
  const head = summary.addRow(withPrice ? ["Event", "Date", "Total"] : ["Event", "Date"]);
  head.font = { bold: true };
  head.fill = BAND_FILL;
  for (const dayRow of totals.days || []) {
    const r = summary.addRow(withPrice ? [dayRow.name, dayRow.date, dayRow.total] : [dayRow.name, dayRow.date]);
    if (withPrice) r.getCell(3).numFmt = RUPEE_FMT;
  }
  if (withPrice) {
    for (const ts of totals.eventLevelItems || []) {
      const r = summary.addRow([`${ts.name} (whole wedding)`, ts.kind === "mandatory" ? "TS · mandatory" : "TS", ts.price]);
      r.getCell(3).numFmt = RUPEE_FMT;
    }
    const sub = summary.addRow(["Subtotal", "", totals.gross || 0]);
    sub.font = { bold: true };
    sub.getCell(3).numFmt = RUPEE_FMT;
    if (totals.discount) {
      const d = summary.addRow(["Discount", "", -totals.discount]);
      d.getCell(3).numFmt = RUPEE_FMT;
    }
    const grand = summary.addRow(["Grand total", "", totals.net != null ? totals.net : totals.grandTotal || 0]);
    grand.font = { bold: true };
    grand.fill = TOTAL_FILL;
    grand.getCell(3).numFmt = RUPEE_FMT;
  }

  // ── one sheet per event day ──
  const COLS = [
    { header: "Image", width: 14 },
    { header: "Product ID", width: 12 },
    { header: "Name", width: 28 },
    { header: "Variation", width: 16 },
    { header: "Pricing tier", width: 14 },
    { header: "Qty", width: 6 },
    { header: "Platform", width: 14 },
    { header: "Flooring", width: 14 },
    { header: "Setup location", width: 20 },
    { header: "Inclusive of", width: 26 },
    { header: "Notes", width: 30 },
    { header: "Included", width: 9 },
  ];
  const PRICE_COLS = [
    { header: "Unit price", width: 12 },
    { header: "Line total", width: 12 },
  ];
  const allCols = withPrice ? [...COLS, ...PRICE_COLS] : COLS;
  const unitPriceOf = (it) => (Number(it.decorPrice) || 0) + (Number(it.priceModifier) || 0) + (Number(it.priceAdj) || 0);

  for (const day of detail.days || []) {
    const ws = wb.addWorksheet(sheetNameFor(day.name, usedNames));
    ws.columns = allCols.map((c) => ({ width: c.width }));

    // titled header block
    const t1 = ws.addRow([day.name || "Event"]);
    t1.font = { bold: true, size: 13 };
    ws.addRow([`Date: ${day.date || "—"}    Time: ${day.time || "—"}    Venue: ${day.venue || "—"}    Pax: ${paxOf(day)}`]);
    ws.addRow([]);
    const header = ws.addRow(allCols.map((c) => c.header));
    header.font = { bold: true };
    header.fill = BAND_FILL;
    ws.views = [{ state: "frozen", ySplit: header.number }];

    // group items by category in OS render order
    const items = (day.decorItems || []).filter((it) => includeExcluded || it.includedInTotal !== false);
    const cats = [...new Set(items.map((it) => it.category || "Uncategorised"))].sort(byCategory);
    for (const cat of cats) {
      const band = ws.addRow([cat]);
      band.font = { bold: true };
      band.fill = BAND_FILL;
      const catNote = (day.categoryNotes || []).find((c) => c.category === cat);
      if (catNote && catNote.note) {
        const nr = ws.addRow(["", "", `Note: ${catNote.note}`]);
        nr.getCell(3).alignment = { wrapText: true };
        nr.font = { italic: true };
      }
      let catTotal = 0;
      for (const it of items.filter((x) => (x.category || "Uncategorised") === cat)) {
        const excluded = it.includedInTotal === false;
        if (!excluded) catTotal += Number(it.price) || 0;
        const dims = it.dimensions || {};
        const platform = it.platform ? `${dims.length || 0}×${dims.breadth || 0}×${dims.height || 0}` : "—";
        const values = [
          "", // image cell
          it.productId || "",
          it.name || "",
          // Variation vs tier: post-Bug-74 the variation travels in `variant`
          // and the tier in `productVariant` (identical values = tier-only).
          it.variant && it.variant !== it.productVariant ? it.variant : "—",
          it.productVariant || it.variant || "Standard",
          it.quantity || 1,
          platform,
          it.flooring || "—",
          it.setupLocation || "",
          (it.included || []).join("\n"),
          (it.notes || []).map((nn) => nn.text).filter(Boolean).join("\n"),
          excluded ? "No" : "Yes",
        ];
        if (withPrice) values.push(unitPriceOf(it), Number(it.price) || 0);
        const row = ws.addRow(values);
        row.height = 68; // ~90px, fits the embedded thumbnail
        row.alignment = { vertical: "top" };
        row.getCell(10).alignment = { wrapText: true, vertical: "top" };
        row.getCell(11).alignment = { wrapText: true, vertical: "top" };
        if (withPrice) {
          row.getCell(13).numFmt = RUPEE_FMT;
          row.getCell(14).numFmt = RUPEE_FMT;
        }
        if (excluded) strikeRow(row);
        const img = images.get(it.thumbnail);
        if (img) {
          const imageId = wb.addImage({ buffer: img.buffer, extension: img.extension });
          ws.addImage(imageId, {
            tl: { col: 0, row: row.number - 1 },
            ext: { width: 90, height: 88 },
            editAs: "oneCell",
          });
        }
      }
      if (withPrice) {
        const tr = ws.addRow(["", "", `${cat} total`, "", "", "", "", "", "", "", "", "", "", catTotal]);
        tr.font = { bold: true };
        tr.getCell(14).numFmt = RUPEE_FMT;
        tr.fill = TOTAL_FILL;
      }
    }

    // add-ons (across the day's rendered items)
    const addOnRows = items.flatMap((it) =>
      (it.addOns || []).map((a) => ({ item: it, addOn: a }))
    );
    if (addOnRows.length) {
      ws.addRow([]);
      const b = ws.addRow(["Add-ons"]);
      b.font = { bold: true };
      b.fill = BAND_FILL;
      for (const { item, addOn } of addOnRows) {
        const excluded = item.includedInTotal === false;
        const vals = ["", "", `${item.name} — ${addOn.name}`, "", "", addOn.quantity != null ? addOn.quantity : 1, "", "", "", "", addOn.notes || "", excluded ? "No" : "Yes"];
        if (withPrice) vals.push("", (Number(addOn.price) || 0) * (addOn.quantity != null ? Number(addOn.quantity) || 1 : 1));
        const r = ws.addRow(vals);
        if (withPrice) r.getCell(14).numFmt = RUPEE_FMT;
        if (excluded) strikeRow(r);
      }
    }

    // mandatory rows (formatted labels + ES/TS scope)
    const mandatory = day.mandatoryItems || [];
    if (mandatory.length) {
      ws.addRow([]);
      const b = ws.addRow(["Mandatory"]);
      b.font = { bold: true };
      b.fill = BAND_FILL;
      for (const mi of mandatory) {
        const scope = mi.includeInTotalSummary ? "TS" : "ES";
        const required = mi.itemRequired ? "" : " (offer)";
        const vals = ["", "", `${mandatoryLabel(mi)}${required}`, "", "", "", "", "", "", "", "", scope];
        if (withPrice) vals.push("", Number(mi.price) || 0);
        const r = ws.addRow(vals);
        if (withPrice) r.getCell(14).numFmt = RUPEE_FMT;
      }
    }
    // custom items ride the ops sheet too (they are part of the build)
    const custom = day.customItems || [];
    if (custom.length) {
      ws.addRow([]);
      const b = ws.addRow(["Custom items"]);
      b.font = { bold: true };
      b.fill = BAND_FILL;
      for (const c of custom) {
        const vals = ["", "", c.name || "", "", "", c.quantity != null ? c.quantity : 1, "", "", "", "", "", c.includeInTotalSummary ? "TS" : "ES"];
        if (withPrice) vals.push("", Number(c.price) || 0);
        const r = ws.addRow(vals);
        if (withPrice) r.getCell(14).numFmt = RUPEE_FMT;
      }
    }

    // EVENT TOTAL — the server's own per-day total row, never recomputed
    if (withPrice) {
      const serverRow = (totals.days || []).find((d) => d.dayId === day.dayId) || {};
      ws.addRow([]);
      const tr = ws.addRow(["", "", "EVENT TOTAL", "", "", "", "", "", "", "", "", "", "", serverRow.total || 0]);
      tr.font = { bold: true };
      tr.fill = TOTAL_FILL;
      tr.getCell(14).numFmt = RUPEE_FMT;
    }
  }

  return wb;
};

// Streams straight into the response — the workbook is written directly to the
// res stream (never .toBuffer()'d wholly first).
const writeXlsx = async (leadId, eventId, opts, res, filename) => {
  const wb = await buildWorkbook(leadId, eventId, opts);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const ascii = filename.replace(/[^\x20-\x7E]/g, "-");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  await wb.xlsx.write(res);
  res.end();
};

module.exports = { buildWorkbook, writeXlsx };
