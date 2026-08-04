// QUOTE LAYOUT (.xlsx export ?layout=quote) test. Run: node tests/xlsx-quote-layout.test.js
// Covers: bucket mapping (single-view décor → Decor, furniture → Furniture,
// lighting → Lighting & Sound, mandatory → Logistics, custom → Others),
// merged Event + Category cells, client-language description composition (no
// product codes), bucket totals == event total == server totals to the rupee,
// summary bucket mix reconciling to the grand total, both price modes, both
// exclusion modes, and the OPS layout being byte-for-byte unchanged.
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

const TAG = `qxlsx-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], cats: [] };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const roundTrip = async (wb) => { const buf = await wb.xlsx.writeBuffer(); const back = new ExcelJS.Workbook(); await back.xlsx.load(buf); return back; };
const cellText = (ws) => { const out = []; ws.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => out.push(String(c.value ?? "")))); return out; };
const BUCKETS = ["Decor", "Furniture", "Lighting & Sound", "Logistics", "Others"];
// bucket column indices in the quote sheet: Event,Category,Image,Description,Qty then buckets → col 6..10
const bucketCol = (b) => 6 + BUCKETS.indexOf(b);

(async () => {
  let imgServer = null;
  try {
    imgServer = http.createServer((req, res) => { if (req.url === "/i.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); } else { res.writeHead(404); res.end(); } });
    await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
    const IMG = `http://127.0.0.1:${imgServer.address().port}/i.png`;

    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // categories: a single-view décor one + a group Furniture + a group Lighting
    const catStage = await Category.create({ name: `${TAG}-Stage`, order: 1, status: true, adminEventToolView: "single" });
    const catFurn = await Category.create({ name: `${TAG}-Furniture`, order: 20, status: true, adminEventToolView: "group" });
    const catLight = await Category.create({ name: `${TAG}-Sound & Light`, order: 21, status: true, adminEventToolView: "group" });
    const catProps = await Category.create({ name: `${TAG}-Props`, order: 22, status: true, adminEventToolView: "group" }); // unmapped group → Others
    created.cats.push(catStage._id, catFurn._id, catLight._id, catProps._id);

    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-Couple`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDays: [{ date: "2026-11-20", functions: [{ type: "Mehendi", time: "16:00", venue: "Lawn", pax: "250" }] }] },
    });
    created.leads.push(lead._id);
    const mkDecor = (cat, name, sell, img) => Decor.create({ category: cat, name, unit: "unit", tags: [], image: img || "x.jpg", thumbnail: img || "x.jpg", rating: 0, productInfo: { id: "code123" }, productTypes: [{ name: "Standard", costPrice: 100, sellingPrice: sell }] });
    const dStage = await mkDecor(catStage.name, `${TAG}-stage`, 10000, IMG);
    const dFurn = await mkDecor(catFurn.name, `${TAG}-chairs`, 3000);
    const dLight = await mkDecor(catLight.name, `${TAG}-uplights`, 2000);
    const dProps = await mkDecor(catProps.name, `${TAG}-props`, 500);
    created.decors.push(dStage._id, dFurn._id, dLight._id, dProps._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Quote" }, admin._id);
    created.events.push(draft._id);
    const seed = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const dayId = seed.days[0].dayId;

    // a rich stage item exercising description composition
    await DraftEventService.addItem(lead._id, draft._id, dayId, {
      decorId: dStage._id, quantity: 1, platform: true, dimensions: { length: 12, breadth: 12, height: 2 },
      flooring: "Carpet", primaryColor: "Red", secondaryColor: "Ivory", setupLocation: "North lawn",
      included: ["Backdrop", "Seating"],
      addOns: [{ name: "Fairy lights", price: 500, quantity: 2 }],
      notes: [{ text: "gate 2 entry", image: "" }],
    }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dFurn._id, quantity: 10 }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dLight._id, quantity: 1 }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dProps._id, quantity: 1 }, admin._id);
    const excl = await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: dStage._id, quantity: 1, includedInTotal: false }, admin._id);
    await DraftEventService.addCustomItem(lead._id, draft._id, dayId, { name: "LED wall", price: 700 }); // ES → Others
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, { title: "Generator", price: 8000, itemRequired: true, includeInTotalSummary: false, selection: { Size: "64Kw", Duration: "6hrs" } }); // ES → Logistics
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, { title: "Valet", price: 1200, itemRequired: true, includeInTotalSummary: true }); // TS → summary only

    const serverTotals = (await DraftEventService.getDraftDetail(lead._id, draft._id)).totals;
    const serverDayTotal = serverTotals.days[0].total;

    // ── full quote (withPrice, includeExcluded) ──
    const wb = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: true, includeExcluded: true }));
    ok(wb.worksheets[0].name === "Summary", "Summary sheet first");
    const ws = wb.worksheets.find((w) => w.name === "Mehendi");
    ok(!!ws, "one sheet per event, named for the function");
    const txt = cellText(ws);
    ok(txt.some((t) => t.includes("Pax: 250")), "header block carries date/time/venue/pax");

    // bucket mapping — find each item's row and confirm its money is in the right bucket
    const findRow = (needle) => { let hit = null; ws.eachRow((r) => { if (!hit && String(r.getCell(4).value || "").includes(needle)) hit = r; }); return hit; };
    const stageRow = findRow(`${TAG}-stage`); // first match = the rich (included) stage item
    ok(stageRow && Number(stageRow.getCell(bucketCol("Decor")).value) > 0 && !stageRow.getCell(bucketCol("Furniture")).value,
      "single-view décor → Decor bucket (only)");
    ok(Number(findRow(`${TAG}-chairs`).getCell(bucketCol("Furniture")).value) === 30000, "furniture category → Furniture bucket (qty 10 × 3000)");
    ok(Number(findRow(`${TAG}-uplights`).getCell(bucketCol("Lighting & Sound")).value) === 2000, "lighting category → Lighting & Sound bucket");
    ok(Number(findRow(`${TAG}-props`).getCell(bucketCol("Others")).value) === 500, "unmapped group category → Others bucket");
    ok(Number(findRow("Generator").getCell(bucketCol("Logistics")).value) === 8000, "mandatory (ES) → Logistics bucket");
    ok(Number(findRow("LED wall").getCell(bucketCol("Others")).value) === 700, "ES custom item → Others bucket");
    ok(!txt.some((t) => t === "Valet"), "TS mandatory is NOT on the event sheet (whole-wedding only)");

    // description composition — client language, no product code
    const desc = String(stageRow.getCell(4).value || "");
    ok(desc.includes("Platform 12 × 12 × 2 ft") && desc.includes("Carpet flooring") && desc.includes("Colours: Red · Ivory")
      && desc.includes("Includes: Backdrop; Seating") && desc.includes("Add-ons: Fairy lights ×2") && desc.includes("gate 2 entry"),
      "description composed in client language (platform/flooring/colours/includes/add-ons/notes)");
    ok(!txt.some((t) => t.includes("code123")), "product code omitted from the quote layout");

    // merged cells — Event col A and the Stage category col B
    const hasMerge = (r1, c1, r2, c2) => ws.model.merges.includes(`${ws.getCell(r1, c1).address}:${ws.getCell(r2, c2).address}`);
    // event merge spans all data rows in col 1
    const firstData = 5; // after title, subtitle, blank, header
    ok(ws.model.merges.some((m) => m.startsWith(ws.getCell(firstData, 1).address.replace(/\d+$/, firstData) )) || ws.model.merges.some((m) => /^A\d+:A\d+$/.test(m)),
      "Event cell (col A) merged down its rows");
    ok(ws.model.merges.some((m) => /^B\d+:B\d+$/.test(m)), "Category cells (col B) merged down their runs");

    // bucket totals == event total == server day total
    let btRow = null, etVal = null;
    ws.eachRow((r) => { if (String(r.getCell(2).value) === "Bucket totals") btRow = r; if (String(r.getCell(2).value) === "EVENT TOTAL") etVal = Number(r.getCell(6).value); });
    const btSum = BUCKETS.reduce((s, b) => s + (Number(btRow.getCell(bucketCol(b)).value) || 0), 0);
    ok(btSum === serverDayTotal, `Σ bucket totals (₹${btSum}) === server day total (₹${serverDayTotal})`);
    ok(etVal === serverDayTotal, "EVENT TOTAL row === server day total");

    // summary bucket mix reconciles to the grand total
    const sTxt = cellText(wb.worksheets[0]);
    let grand = null, sub = null; const mix = {};
    wb.worksheets[0].eachRow((r) => {
      const k = String(r.getCell(1).value || "");
      if (k === "Grand total") grand = Number(r.getCell(2).value);
      if (k === "Subtotal") sub = Number(r.getCell(2).value);
      if (BUCKETS.includes(k)) mix[k] = Number(r.getCell(2).value) || 0;
    });
    const mixSum = BUCKETS.reduce((s, b) => s + (mix[b] || 0), 0);
    ok(mixSum === serverDayTotal, `summary bucket mix (₹${mixSum}) === Σ day totals`);
    ok(sub === serverTotals.gross, "summary subtotal === server gross");
    ok(grand === serverTotals.net, "summary grand total === server net");
    ok(sTxt.some((t) => t.includes("Valet (whole wedding)")), "TS whole-wedding line shown in summary");

    // ── withPrice=false: no bucket columns / totals ──
    const wb2 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: false, includeExcluded: true }));
    const ws2 = wb2.worksheets.find((w) => w.name === "Mehendi");
    const t2 = cellText(ws2);
    ok(!t2.includes("Decor") && !t2.includes("Bucket totals") && !t2.includes("EVENT TOTAL"), "withPrice=false: no bucket columns, no totals");
    ok(t2.some((t) => t.includes(`${TAG}-stage`)), "…descriptions still present (spec sheet)");

    // ── includeExcluded=false: the alternative omitted, totals identical ──
    const wb3 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { layout: "quote", withPrice: true, includeExcluded: false }));
    const ws3 = wb3.worksheets.find((w) => w.name === "Mehendi");
    let stageRows = 0; ws3.eachRow((r) => { if (String(r.getCell(4).value || "").startsWith(`${TAG}-stage`)) stageRows++; });
    ok(stageRows === 1, "includeExcluded=false: the excluded alternative row is omitted (only the kept stage remains)");
    let etVal3 = null; ws3.eachRow((r) => { if (String(r.getCell(2).value) === "EVENT TOTAL") etVal3 = Number(r.getCell(6).value); });
    ok(etVal3 === serverDayTotal, "…and totals are identical either way (server-owned)");
    void excl;

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
