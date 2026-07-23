// READ-ONLY audit — blob-only orphan hunt (stream-purity ruling).
// Run: node scripts/audit-notes-blob-orphans.js
//
// Uses the SAME orphan logic the stream itself runs (NoteStreamService
// exports splitBlobSegments/isCoveredBy/normText): for every lead with a
// non-empty updates.notes blob, list the segments that exist in no other
// note store. Those segments now surface in the merged stream as their own
// rows; this script remains the fleet-wide census. Nothing is modified.
require("dotenv").config();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");
const { splitBlobSegments, isCoveredBy, normText } = require("../services/NoteStreamService");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const leads = await Enquiry.find(
    { "updates.notes": { $exists: true, $nin: [null, ""] } },
    { name: 1, phone: 1, updates: 1, qualifierNotes: 1, "qualificationData.additionalNotes": 1 }
  ).lean();

  let leadsWithBlob = 0, leadsWithOrphans = 0, orphanSegments = 0;
  for (const lead of leads) {
    const blob = String(lead.updates && lead.updates.notes || "").trim();
    if (!blob) continue;
    leadsWithBlob++;

    const known = new Set();
    const add = (t) => { const n = normText(t); if (n) known.add(n); };
    for (const c of (lead.updates && lead.updates.conversations) || []) add(c && c.text);
    add(lead.qualifierNotes);
    add(lead.qualificationData && lead.qualificationData.additionalNotes);
    const events = await LeadInternalEvent.find(
      { leadId: lead._id, type: "commented" }, { payload: 1 }
    ).lean();
    for (const e of events) add(e.payload && e.payload.text);
    const chatNotes = await LeadChatMessage.find(
      { leadId: lead._id, kind: "message", body: { $regex: "^\\[Lead comms\\] " } },
      { body: 1 }
    ).lean();
    for (const m of chatNotes) add(String(m.body).slice("[Lead comms] ".length));

    const orphans = splitBlobSegments(blob).filter((seg) => !isCoveredBy(known, seg.text));
    if (orphans.length) {
      leadsWithOrphans++;
      orphanSegments += orphans.length;
      console.log(`\nLEAD ${lead._id} (${lead.name || "?"} / ${lead.phone || "?"}) — ${orphans.length} orphan segment(s):`);
      for (const o of orphans) {
        const stamp = o.at ? ` [${o.at.toISOString().slice(0, 10)}]` : "";
        console.log(`  ·${stamp} ${o.text.length > 160 ? o.text.slice(0, 160) + "…" : o.text}`);
      }
    }
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`leads with a blob:      ${leadsWithBlob}`);
  console.log(`leads with orphans:     ${leadsWithOrphans}`);
  console.log(`orphan segments total:  ${orphanSegments}`);
  console.log(leadsWithOrphans ? "→ these segments surface in the note stream as orphan rows; stores untouched." : "→ every blob line also exists as an individual note; nothing extra surfaces.");
  await mongoose.disconnect();
  process.exit(0);
})();
