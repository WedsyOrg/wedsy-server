// CLIENT QUOTE layout (.xlsx export ?layout=quote) test.
// Run: node tests/xlsx-quote-layout.test.js
// Covers the ONE-continuous-sheet rebuild: a single "Client Quote" sheet
// (gridlines off, landscape fit-to-page), the hero band + logo, the 8-column
// header, single-view note rows (note in F, its ONE ref image in G on the SAME
// row, C/D/E/H merged down the block), group-view category + common-note
// merges, the ↳ Platform sub-row splitting the stored price exactly, gradient
// event-total rows carrying the server's per-day number, alternatives shown but
// never summed, the whole-wedding closing block (TS once, discount, grand
// total == totals.net), Indian-grouping number format, withPrice/includeExcluded
// modes — and the OPS layout being byte-for-byte unchanged.
require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const Category = require("../models/Category");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const DraftExportService = require("../services/DraftExportService");
const { lineTotal } = require("../utils/eventDecorPricing");

const TAG = `qxlsx-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], cats: [] };
// a 2×1 PNG — non-square on purpose, so aspect-preservation is observable
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR42mP8z8BQz0AEAAB/AgHXaJm0AAAAAElFTkSuQmCC", "base64");

const roundTrip = async (wb) => { const buf = await wb.xlsx.writeBuffer(); const back = new ExcelJS.Workbook(); await back.xlsx.load(buf); return back; };
const cellText = (ws) => { const out = []; ws.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => out.push(String(c.value ?? "")))); return out; };
// first row whose column `col` contains `needle`
const findRow = (ws, col, needle) => { let hit = null; ws.eachRow((r) => { if (!hit && String(r.getCell(col).value ?? "").includes(needle)) hit = r; }); return hit; };
const countRows = (ws, col, needle) => { let n = 0; ws.eachRow((r) => { if (String(r.getCell(col).value ?? "").includes(needle)) n++; }); return n; };
// distinct BLOCKS, not rows: a vertically-merged cell reports the master's
// value on every slave row, so slaves must not be counted twice.
const countBlocks = (ws, col, needle) => { let n = 0; ws.eachRow((r) => { const c = r.getCell(col); if (!c.isMerged || c.master === c) { if (String(c.value ?? "").includes(needle)) n++; } }); return n; };
const HEADERS = ["Date", "Event", "Category", "Image", "Item description", "Notes", "Notes Ref Image", "Pricing"];
const WIDTHS = [12, 18, 22, 26, 48, 28, 24, 16];

(async () => {
  let imgServer = null;
  try {
    imgServer = http.createServer((req, res) => {
      if (req.url === "/i.png" || req.url === "/n.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
    const PORT = imgServer.address().port;
    const IMG = `http://127.0.0.1:${PORT}/i.png`;      // product thumbnail
    const NOTE_IMG = `http://127.0.0.1:${PORT}/n.png`; // a note's ref image

    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // a single-view décor category + a group-view one
    const catStage = await Category.create({ name: `${TAG}-Stage`, order: 1, status: true, adminEventToolView: "single" });
    const catFurn = await Category.create({ name: `${TAG}-Furniture`, order: 20, status: true, adminEventToolView: "group" });
    created.cats.push(catStage._id, catFurn._id);

    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-Couple`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: {
        groomName: "Arjun", brideName: "Meera",
        eventDays: [{ date: "2026-11-20", functions: [{ type: "Mehendi", time: "16:00", venue: "Lawn", pax: "250" }] }],
      },
    });
    created.leads.push(lead._id);
    const mkDecor = (cat, name, sell, img, specIncluded) => Decor.create({ category: cat, name, unit: "unit", tags: [], image: img || "x.jpg", thumbnail: img || "x.jpg", rating: 0, productInfo: { id: "code123", included: specIncluded || [] }, productTypes: [{ name: "Standard", costPrice: 100, sellingPrice: sell }] });
    const dStage = await mkDecor(catStage.name, `${TAG}-stage`, 10000, IMG);
    const dFurn = await mkDecor(catFurn.name, `${TAG}-chairs`, 3000);
    const dSofa = await mkDecor(catFurn.name, `${TAG}-sofa`, 4000);
    // a product whose SPEC list is the only source of "included" — the item
    // itself is added with no included[] at all
    const dSpec = await mkDecor(catStage.name, `${TAG}-specprop`, 1500, "", ["Frame", "Drape"]);
    // no spec list at all — only an add-on can fill the Included: line
    const dBare = await mkDecor(catStage.name, `${TAG}-bareprop`, 900);
    created.decors.push(dStage._id, dFurn._id, dSofa._id, dSpec._id, dBare._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Quote" }, admin._id);
    created.events.push(draft._id);
    const seed = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const dayId = seed.days[0].dayId;

    // the rich single-view item: platform + flooring + add-ons + TWO notes
    // (the first carrying a ref image) — exercises the whole single block.
    await DraftEventService.addItem(lead._id, draft._id, dayId, {
      decorId: dStage._id, quantity: 1, platform: true, dimensions: { length: 12, breadth: 12, height: 2 },
      flooring: "Carpet", primaryColor: "Red", secondaryColor: "Ivory", setupLocation: "North lawn",
      included: ["Backdrop", "Seating"],
      addOns: [{ name: "Fairy lights", price: 500, quantity: 2 }],
      notes: [{ text: "gate 2 entry", image: NOTE_IMG }, { text: "hand over by 4pm", image: "" }],
    }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dFurn._id, quantity: 10 }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dSofa._id, quantity: 2 }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dSpec._id, quantity: 1 }, admin._id); // no included[] — spec list must fill in
    // no included[], no spec list, no colours — the add-on alone must earn the Included: line
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dBare._id, quantity: 1, addOns: [{ name: "Ribbon", price: 300, quantity: 1 }] }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dStage._id, quantity: 1, includedInTotal: false }, admin._id);
    await DraftEventService.setCategoryNote(lead._id, draft._id, dayId, { category: catFurn.name, note: "white covers throughout" }, admin._id);
    await DraftEventService.addCustomItem(lead._id, draft._id, dayId, { name: "LED wall", price: 700 });                                   // ES
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, { title: "Generator", price: 8000, itemRequired: true, includeInTotalSummary: false, selection: { Size: "64Kw", Duration: "6hrs" } }); // ES
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, { title: "Valet", price: 1200, itemRequired: true, includeInTotalSummary: true });  // TS → closing block only

    // platform/flooring rates are Config snapshots in prod; set them here and
    // reprice through the SERVER'S OWN util so `price` stays the pricing truth.
    const ev = await Event.findById(draft._id);
    const stageItem = ev.eventDays.id(dayId).decorItems.find((i) => String(i.decor) === String(dStage._id) && i.includedInTotal !== false);
    stageItem.platformRate = 100;
    stageItem.flooringRate = 50;
    stageItem.price = lineTotal(stageItem.toObject());
    await ev.save();
    const STAGE_PRODUCT = 1 * 10000 + 500 * 2;            // qty×(decorPrice+mod+adj) + Σ add-ons
    const STAGE_EXTRA = 12 * 12 * 100 + (12 + 2) * (12 + 2) * 50; // platform + flooring legs
    const STAGE_LINE = stageItem.price;

    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const serverTotals = detail.totals;
    const serverDayTotal = serverTotals.days[0].total;

    // ── full quote (withPrice, includeExcluded) ──
    // `live` is the in-memory workbook; `wb` is the same book written out and
    // read back. exceljs's READER downcasts <sz> to an integer, so the 10.5pt
    // header is asserted on `live` (the written styles.xml carries 10.5).
    const live = await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: true, includeExcluded: true });
    ok(live.worksheets[0].getCell(6, 1).font.size === 10.5, "header font is 10.5pt as written");
    const wb = await roundTrip(live);

    // ── ONE sheet ──
    ok(wb.worksheets.length === 1, "exactly ONE worksheet (no summary tab, no per-event tabs)");
    const ws = wb.worksheets[0];
    ok(ws.name === "Client Quote", 'the sheet is named "Client Quote"');
    ok(ws.views && ws.views[0] && ws.views[0].showGridLines === false, "gridlines OFF");
    const ps = ws.pageSetup || {};
    ok(ps.orientation === "landscape" && ps.fitToPage === true && ps.fitToWidth === 1 && ps.fitToHeight === 1,
      "page setup: landscape, fitToPage, fitToWidth 1, fitToHeight 1");
    ok(Math.abs((ps.margins && ps.margins.left) - 0.2) < 0.001, "small (~0.2\") margins");
    // exceljs omits a <col> entry for width 9 (its "non-custom" value), so
    // column A reads back undefined and inherits the sheet default — which the
    // builder pins to 9 for exactly this reason.
    ok(ws.properties.defaultColWidth === 9, "sheet default column width pinned to 9 (so column A is 9)");
    ok(WIDTHS.every((w, i) => (ws.getColumn(i + 1).width ?? ws.properties.defaultColWidth) === w), `column widths ${WIDTHS.join("|")}`);

    // ── HERO ──
    ok(String(ws.getCell(2, 7).value) === "Arjun & Meera", "row 2: couple names from groomName & brideName");
    const nameFont = ws.getCell(2, 7).font || {};
    ok(nameFont.size === 14 && nameFont.bold === true && nameFont.color && nameFont.color.argb === "FF842B2E",
      "…14pt bold maroon (#842B2E)");
    ok(String(ws.getCell(3, 7).value).includes("2026"), "row 3: date range");
    ok(String(ws.getCell(4, 7).value) === "Décor Quote · 250 guests", "row 4: Décor Quote · <max pax> guests");
    const imgs = ws.getImages();
    const logo = imgs.find((i) => i.range && i.range.ext && Math.round(i.range.ext.width) === 340);
    ok(!!logo && logo.range.tl.nativeRow === 1 && Math.round(logo.range.ext.height) === 88,
      "the real logo embedded at A2, 340×88 (aspect preserved, no squash)");

    // ── HEADER row 6 ──
    ok(HEADERS.every((h, i) => String(ws.getCell(6, i + 1).value) === h), "row 6: the 8 column titles");
    const hCell = ws.getCell(6, 1);
    ok(hCell.fill && hCell.fill.fgColor && hCell.fill.fgColor.argb === "FF842B2E", "…filled #842B2E");
    ok(hCell.font.bold === true && hCell.font.color.argb === "FFFFFFFF" && hCell.font.name === "Arial", "…white bold Arial");
    ok(hCell.alignment.horizontal === "center" && hCell.alignment.wrapText === true, "…centered, wrap on");
    ok(!!hCell.border && !!hCell.border.top, "…bordered");

    // ── SINGLE view: notes one-per-row in F, C/D/E/H merged down the block ──
    const stageRow = findRow(ws, 5, `${TAG}-stage`);
    const sr = stageRow.number;
    ok(String(ws.getCell(sr, 6).value) === "gate 2 entry" && String(ws.getCell(sr + 1, 6).value) === "hand over by 4pm",
      "single: each note renders on its OWN row in F");
    const merges = ws.model.merges;
    ok(["C", "D", "E", "H"].every((c) => merges.includes(`${c}${sr}:${c}${sr + 1}`)),
      "single: C, D, E and H merge vertically across the item's note rows");
    ok(String(ws.getCell(sr, 3).value) === catStage.name, "single: the item's category sits in C");
    const noteImg = imgs.find((i) => i.range.tl.nativeCol === 6 && i.range.tl.nativeRow === sr - 1);
    ok(!!noteImg, "single: the note's ONE ref image lands in G on the SAME row");
    ok(noteImg && Math.abs(noteImg.range.ext.width / noteImg.range.ext.height - 2) < 0.05,
      "…fit-to-cell proportionally (2:1 source stays 2:1)");
    ok(noteImg && noteImg.range.ext.width > 100, "…and renders large (fills the G column box)");
    const prodImg = imgs.find((i) => i.range.tl.nativeCol === 3 && i.range.tl.nativeRow === sr - 1);
    ok(!!prodImg && prodImg.range.ext.width > 100, "single: the product image fills the merged D cell");

    // description: client language, notes NOT stuffed in, no product code
    const desc = String(ws.getCell(sr, 5).value || "");
    ok(desc.startsWith(`${TAG}-stage`) && desc.includes("Included: Red · Ivory; Backdrop; Seating; Fairy lights ×2") && desc.includes("Setup: North lawn"),
      "E carries the description + an Included: line (colours / includes / add-on names)");
    ok(!desc.includes("gate 2 entry"), "…and NOT the notes (they live in F/G now)");
    ok(!cellText(ws).some((t) => t.includes("code123")), "product code omitted from the quote layout");

    // Included: falls back to the PRODUCT's spec list when the item has none
    const specDesc = String(findRow(ws, 5, `${TAG}-specprop`).getCell(5).value || "");
    ok(specDesc.includes("Included: Frame; Drape"),
      "an item with an empty included[] still gets an Included: line from specIncluded");
    // gated on the COMPOSED list, so an add-on alone is enough
    const bareDesc = String(findRow(ws, 5, `${TAG}-bareprop`).getCell(5).value || "");
    ok(bareDesc.includes("Included: Ribbon"),
      "no includes, no spec list, no colours — one add-on still renders an Included: line naming it");

    // ── PLATFORM/FLOORING sub-row ──
    const subRow = findRow(ws, 3, "↳ Platform");
    ok(!!subRow, "a ↳ Platform sub-row sits directly beneath the item");
    ok(subRow.number === sr + 2, "…on the very next row after the item's note rows");
    ok(String(subRow.getCell(5).value).includes("12 × 12 × 2 ft") && String(subRow.getCell(5).value).includes("Carpet flooring"),
      "…E = size + flooring type on one line");
    const parentH = Number(ws.getCell(sr, 8).value);
    const subH = Number(subRow.getCell(8).value);
    ok(parentH === STAGE_PRODUCT, `parent H shows the product portion only (₹${STAGE_PRODUCT})`);
    ok(subH === STAGE_EXTRA, `sub-row H shows the platform+flooring terms (₹${STAGE_EXTRA})`);
    ok(parentH + subH === STAGE_LINE, `parent + sub === the item's stored line price (₹${STAGE_LINE}) exactly`);
    ok(String(ws.getCell(sr, 8).numFmt || "").includes("#,##,##0"), "Indian-grouping number format on the money column");

    // ── GROUP view: category merged in C, the common note merged in F ──
    const chairsRow = findRow(ws, 5, `${TAG}-chairs`);
    const sofaRow = findRow(ws, 5, `${TAG}-sofa`);
    ok(!!chairsRow && !!sofaRow && Math.abs(chairsRow.number - sofaRow.number) === 1, "group: each item is its own row");
    const gFirst = Math.min(chairsRow.number, sofaRow.number);
    const gLast = Math.max(chairsRow.number, sofaRow.number);
    ok(merges.includes(`C${gFirst}:C${gLast}`), "group: the category name merges in C across all its items");
    ok(String(ws.getCell(gFirst, 3).value) === catFurn.name, "…and carries the category name");
    ok(merges.includes(`F${gFirst}:F${gLast}`) && String(ws.getCell(gFirst, 6).value) === "white covers throughout",
      "group: the category's COMMON note merges in F across the item rows");
    ok(merges.includes(`G${gFirst}:G${gLast}`), "group: G mirrors that merge");
    ok(String(chairsRow.getCell(5).value).startsWith(`${TAG}-chairs — `), 'group: E reads "Name — desc"');
    ok(Number(chairsRow.getCell(8).value) === 30000, "group: price in H (qty 10 × 3000)");

    // ── ALTERNATIVES: shown, muted, tagged, never summed ──
    ok(countRows(ws, 5, "Not included") === 1, 'the alternative renders in-line tagged "Not included"');
    const altRow = findRow(ws, 5, "Not included");
    ok(altRow.getCell(5).font.color.argb === "FF6B655E", "…muted (#6B655E), de-emphasised");
    ok(Number(altRow.getCell(8).value) === 10000, "…its price still shows");

    // ── EVENT TOTAL: gradient, label merged A:G, server's own number ──
    const etRow = findRow(ws, 1, "Event Total");
    ok(!!etRow && merges.includes(`A${etRow.number}:G${etRow.number}`), "event total: label merged A:G");
    const etFill = etRow.getCell(1).fill || {};
    ok(etFill.type === "gradient" && etFill.degree === 0
      && etFill.stops[0].color.argb === "FFAD373B" && etFill.stops[1].color.argb === "FF5D2021",
      "event total: gradient fill, degree 0, #AD373B → #5D2021");
    ok(etRow.getCell(1).font.bold === true && etRow.getCell(1).font.color.argb === "FFFFFFFF", "event total: white bold label");
    ok(Number(etRow.getCell(8).value) === serverDayTotal, `event total (₹${etRow.getCell(8).value}) === the server's per-event total (₹${serverDayTotal})`);

    // every rendered included line sums to the server's event total
    const lineSum = STAGE_LINE + 30000 + 8000 /* sofa 2×4000 */ + 1500 /* spec prop */ + 1200 /* bare prop 900 + Ribbon 300 */ + 700 + 8000;
    ok(lineSum === serverDayTotal, `Σ rendered lines (₹${lineSum}) === the server's event total (₹${serverDayTotal})`);

    // ── CLOSING ──
    const capRow = findRow(ws, 1, "Applies across all events");
    ok(!!capRow && capRow.number > etRow.number, "closing: the caption follows the LAST event");
    ok(countRows(ws, 3, "Valet") === 1, "TS item appears exactly ONCE, and only in the closing block");
    const tsRow = findRow(ws, 3, "Valet");
    ok(tsRow.number > etRow.number && String(tsRow.getCell(1).value) === "Mandatory"
      && merges.includes(`A${tsRow.number}:B${tsRow.number}`) && merges.includes(`C${tsRow.number}:G${tsRow.number}`),
      "…as its own line: label A:B, desc C:G, amount H");
    ok(Number(tsRow.getCell(8).value) === 1200, "…carrying the server's TS price");
    ok(!findRow(ws, 1, "Discount"), "closing: no Discount row when the discount is zero");
    const grandRow = findRow(ws, 1, "GRAND TOTAL");
    ok(!!grandRow && grandRow.number === tsRow.number + 1, "closing: GRAND TOTAL is the last row");
    const gFill = grandRow.getCell(1).fill || {};
    ok(gFill.type === "gradient" && merges.includes(`A${grandRow.number}:G${grandRow.number}`)
      && grandRow.getCell(1).font.size === 13 && grandRow.getCell(1).font.bold === true,
      "grand total: gradient row, label merged A:G, white bold 13pt");
    const grand = Number(grandRow.getCell(8).value);
    ok(grand === serverTotals.net, `GRAND TOTAL (₹${grand}) === the server's net (₹${serverTotals.net}) — not recomputed`);
    ok(grand === Math.max(0, serverDayTotal + serverTotals.eventLevelTotal - serverTotals.discount),
      "…and reconciles: Σ event totals + Σ TS − discount");

    // Arial + centred throughout
    ok(ws.getCell(sr, 5).font.name === "Arial" && ws.getCell(sr, 5).alignment.horizontal === "center" && ws.getCell(sr, 5).alignment.wrapText === true,
      "Arial throughout, everything centered, wrap on");

    // ── a draft with NO whole-wedding items: the caption earns no row ──
    const plain = await DraftEventService.createDraft(lead._id, { name: "Plain" }, admin._id);
    created.events.push(plain._id);
    const plainDay = (await DraftEventService.getDraftDetail(lead._id, plain._id)).days[0].dayId;
    await DraftEventService.addItem(lead._id, plain._id, plainDay, { decorId: dFurn._id, quantity: 4 }, admin._id);
    const wbPlain = await roundTrip(await DraftExportService.buildWorkbook(lead._id, plain._id, { layout: "quote", withPrice: true, includeExcluded: true }));
    const wsPlain = wbPlain.worksheets[0];
    ok(!findRow(wsPlain, 1, "Applies across all events"), "no TS items → the caption row is suppressed");
    ok(!findRow(wsPlain, 1, "Discount"), "no discount → the Discount row is suppressed");
    const plainGrand = findRow(wsPlain, 1, "GRAND TOTAL");
    ok(!!plainGrand && Number(plainGrand.getCell(8).value) === 12000, "…GRAND TOTAL always renders (₹12,000)");
    ok(plainGrand.number === findRow(wsPlain, 1, "Event Total").number + 1, "…and follows the event total directly");

    // ── FIX 4: the quote downloads under the client's name ──
    const { clientFileName } = require("../controllers/plan");
    ok(clientFileName({ name: "ignored", qualificationData: { groomName: "Arjun", brideName: "Meera" } }) === "Arjun & Meera",
      "filename: both names → “Groom & Bride”");
    ok(clientFileName({ name: "Walk-in Lead", qualificationData: { groomName: "Arjun", brideName: "" } }) === "Walk-in Lead",
      "filename: a missing name falls back to the lead's own name");
    ok(clientFileName({ name: 'a/b\\c:d*e?f"g<h>i|j' }) === "abcdefghij", "filename: path/reserved characters stripped");
    ok(clientFileName({ name: "  Arjun \n\t  Meera  " }) === "Arjun Meera", "filename: whitespace collapsed and trimmed");
    ok(clientFileName({ name: "A\u0007B\u001FC" }) === "ABC", "filename: control characters stripped");
    ok(clientFileName({}) === "" && clientFileName({ name: "///" }) === "", "filename: resolves empty → caller keeps the legacy name");

    // ── withPrice=false: column H blank, layout intact ──
    const wb2 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: false, includeExcluded: true }));
    const ws2 = wb2.worksheets[0];
    ok(HEADERS.every((h, i) => String(ws2.getCell(6, i + 1).value) === h), "withPrice=false: the 8-column layout is unchanged");
    let anyMoney = false;
    // H on the caption row is a slave of the A:H merge — not a money cell.
    ws2.eachRow((r) => { const c = r.getCell(8); if (r.number > 6 && !c.isMerged && c.value !== null && c.value !== undefined && c.value !== "") anyMoney = true; });
    ok(!anyMoney, "withPrice=false: column H is blank");
    ok(!!findRow(ws2, 5, `${TAG}-stage`), "…descriptions still present (spec sheet)");

    // ── includeExcluded=false: the alternative dropped, totals identical ──
    const wb3 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: true, includeExcluded: false }));
    const ws3 = wb3.worksheets[0];
    ok(countRows(ws3, 5, "Not included") === 0, "includeExcluded=false: the alternative is dropped entirely");
    ok(countBlocks(ws3, 5, `${TAG}-stage`) === 1 && countBlocks(ws, 5, `${TAG}-stage`) === 2,
      "…only the kept stage item remains (2 blocks with the alternative, 1 without)");
    ok(Number(findRow(ws3, 1, "Event Total").getCell(8).value) === serverDayTotal, "…and totals are identical either way (server-owned)");
    ok(Number(findRow(ws3, 1, "GRAND TOTAL").getCell(8).value) === serverTotals.net, "…grand total too");

    // ── OPS layout unchanged ──
    const ops = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "ops", withPrice: true, includeExcluded: true }));
    const opsWs = ops.worksheets.find((w) => w.name === "Mehendi");
    const oTxt = cellText(opsWs);
    ok(oTxt.includes("Product ID") && oTxt.includes("Line total") && oTxt.includes("EVENT TOTAL"),
      "OPS layout still emits its own columns (Product ID / Line total) — unchanged");
    ok(oTxt.includes("code123"), "OPS layout still shows the product code");
    // default layout (no layout arg) === ops
    const def = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { withPrice: true, includeExcluded: true }));
    ok(def.worksheets.find((w) => w.name === "Mehendi") && cellText(def.worksheets.find((w) => w.name === "Mehendi")).includes("Product ID"),
      "default layout is OPS (backwards compatible)");
    ok(ops.worksheets[0].name === "Summary" && ops.worksheets.length > 1, "OPS keeps its Summary + per-event tabs");
    ok(!ops.worksheets[0].pageSetup.fitToPage, "OPS gets no quote page setup");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (imgServer) imgServer.close();
    if (mongoose.connection.readyState === 1) {
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Category.deleteMany({ _id: { $in: created.cats } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
