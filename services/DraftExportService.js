// THE OPS SHEET — server-side .xlsx export of a Build & Bill draft (exceljs;
// deliberately NOT Puppeteer — Chromium OOMs the t3.micro, exceljs streams).
// One sheet per event day + a Summary sheet first. Totals are NEVER recomputed
// here — every money row comes from the server's own totals object
// (DraftEventService.totalsFor via getDraftDetail) or stored line prices.
// Images are best-effort: any fetch failure leaves the cell blank; capped
// concurrency + a global time budget guard the whole pass.
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

// ── the workbook ─────────────────────────────────────────────────────────────
const buildWorkbook = async (leadId, eventId, { withPrice = true, includeExcluded = true } = {}) => {
  const detail = await DraftEventService.getDraftDetail(leadId, eventId);
  const lead = await Enquiry.findById(leadId, { name: 1, qualificationData: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const byCategory = await categoryOrderer();
  const paxOf = paxResolver(lead);
  const totals = detail.totals || {};

  // image pass (product thumbnails + setup photos), before any sheet work
  const urls = [];
  for (const day of detail.days || []) {
    for (const it of day.decorItems || []) {
      urls.push(it.thumbnail, it.setupLocationImage);
    }
  }
  const images = await fetchImages(urls);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wedsy OS";
  const usedNames = new Set();

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
