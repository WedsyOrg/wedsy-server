// OPS SHEET (.xlsx export) test. Run: node tests/draft-xlsx-export.test.js
// Covers: workbook structure (Summary first + one sheet per event day, header
// block, frozen header, category band + category total), price-mode columns
// (withPrice=false strips every money column/row), includeExcluded behaviour
// (false omits the row entirely; true greys/strikes it), totals matching the
// server's own totals object to the rupee, mandatory/add-on rows, and image
// handling (a working local image embeds; a dead URL degrades to a blank cell
// without failing the export).
require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const DraftExportService = require("../services/DraftExportService");

const TAG = `xlsx-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [] };

// a 1×1 red PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const roundTrip = async (wb) => {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return back;
};
const sheetText = (ws) => {
  const cells = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (c) => cells.push(String(c.value ?? "")));
  });
  return cells;
};

(async () => {
  let imgServer = null;
  try {
    // local image host: /good.png serves a PNG; everything else 404s
    imgServer = http.createServer((req, res) => {
      if (req.url === "/good.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
    const port = imgServer.address().port;
    const GOOD_IMG = `http://127.0.0.1:${port}/good.png`;
    const DEAD_IMG = `http://127.0.0.1:${port}/missing.png`;

    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-Couple`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDays: [{ date: "2026-11-20", functions: [{ type: "Mehendi", time: "16:00", venue: "Lawn", pax: "250" }] }] },
    });
    created.leads.push(lead._id);
    const decorA = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: GOOD_IMG, thumbnail: GOOD_IMG, rating: 0,
      productInfo: { id: "st069" },
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }],
    });
    const decorB = await Decor.create({
      category: "Mandap", name: `${TAG}-mandap`, unit: "unit", tags: [], image: DEAD_IMG, thumbnail: DEAD_IMG, rating: 0,
      productTypes: [{ name: "Premium", costPrice: 2000, sellingPrice: 6000 }],
    });
    created.decors.push(decorA._id, decorB._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Ops" }, admin._id);
    created.events.push(draft._id);
    const detailSeed = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const dayId = detailSeed.days[0].dayId; // Mehendi, seeded from discovery
    const kept = await DraftEventService.addItem(lead._id, draft._id, dayId, {
      decorId: decorA._id, quantity: 2, setupLocation: "North lawn",
      addOns: [{ name: "Fairy lights", price: 500, quantity: 2, notes: "warm white" }],
    }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: decorB._id, quantity: 1 }, admin._id);
    const excluded = await DraftEventService.addItem(lead._id, draft._id, dayId, {
      decorId: decorA._id, quantity: 1, includedInTotal: false,
    }, admin._id);
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, {
      title: "Generator", itemRequired: true, includeInTotalSummary: false, price: 8000,
      selection: { Size: "64Kw", Duration: "6hrs" },
    });
    await DraftEventService.setCategoryNote(lead._id, draft._id, dayId, { category: "Stage", note: "keep it low" }, admin._id);

    const serverTotals = (await DraftEventService.getDraftDetail(lead._id, draft._id)).totals;

    // ── full export (withPrice, includeExcluded) ──
    const wb1 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { withPrice: true, includeExcluded: true }));
    ok(wb1.worksheets[0].name === "Summary", "Summary sheet is FIRST");
    const mehendi = wb1.worksheets.find((w) => w.name === "Mehendi");
    ok(!!mehendi, "one sheet per event day, named for the function");
    const txt = sheetText(mehendi);
    ok(txt.some((t) => t.includes("Date: 2026-11-20") && t.includes("Pax: 250")),
      "titled header block carries date/time/venue/pax (pax from discovery)");
    ok(mehendi.views && mehendi.views[0] && mehendi.views[0].state === "frozen", "header row is frozen");
    ok(txt.includes("Stage") && txt.includes("Mandap"), "category band rows present");
    ok(txt.includes("Stage total") && txt.includes("EVENT TOTAL"), "category total + event total rows present");
    ok(txt.some((t) => t === "st069"), "product ID column populated");
    ok(txt.some((t) => t.includes("keep it low")), "the (day, category) note rides under its band");
    ok(txt.some((t) => t.includes("Generator · 64Kw · 6hrs")), "mandatory row uses the formatted label");
    ok(txt.some((t) => t.includes("Fairy lights")), "add-on row present");

    // totals come from the server's own object
    let eventTotalCell = null;
    mehendi.eachRow((row) => {
      if (row.getCell(3).value === "EVENT TOTAL") eventTotalCell = row.getCell(14).value;
    });
    ok(eventTotalCell === serverTotals.days[0].total,
      `EVENT TOTAL equals the server's totals.days row (₹${eventTotalCell})`);
    const summary1 = wb1.worksheets[0];
    let grand = null;
    summary1.eachRow((row) => { if (row.getCell(1).value === "Grand total") grand = row.getCell(3).value; });
    ok(grand === serverTotals.net, `Summary grand total equals server net (₹${grand})`);

    // excluded row rendered + struck
    let excludedStruck = false;
    mehendi.eachRow((row) => {
      if (String(row.getCell(12).value) === "No" && row.getCell(3).font && row.getCell(3).font.strike) excludedStruck = true;
    });
    ok(excludedStruck, "includeExcluded=true renders the alternative greyed/struck (Included=No)");
    ok(mehendi.getImages().length === 2, `working thumbnails embedded (${mehendi.getImages().length} of 3 rows — the dead URL cell stays blank)`);

    // ── withPrice=false strips money ──
    const wb2 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { withPrice: false, includeExcluded: true }));
    const m2 = wb2.worksheets.find((w) => w.name === "Mehendi");
    const t2 = sheetText(m2);
    ok(!t2.includes("Unit price") && !t2.includes("Line total") && !t2.includes("EVENT TOTAL"),
      "withPrice=false: no price columns, no total rows");
    const s2 = sheetText(wb2.worksheets[0]);
    ok(!s2.includes("Grand total") && !s2.includes("Subtotal"), "price-mode aware Summary (no money lines)");

    // ── includeExcluded=false omits the row entirely ──
    const wb3 = await roundTrip(await DraftExportService.buildWorkbook(lead._id, draft._id, { withPrice: true, includeExcluded: false }));
    const m3 = wb3.worksheets.find((w) => w.name === "Mehendi");
    let noRows = 0;
    m3.eachRow((row) => { if (String(row.getCell(12).value) === "No") noRows++; });
    ok(noRows === 0, "includeExcluded=false: the alternative row is omitted entirely");
    let eventTotal3 = null;
    m3.eachRow((row) => { if (row.getCell(3).value === "EVENT TOTAL") eventTotal3 = row.getCell(14).value; });
    ok(eventTotal3 === serverTotals.days[0].total, "…and totals are identical either way (server-owned)");
    void kept; void excluded;
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
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
