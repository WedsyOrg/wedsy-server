// noFurtherAction dashboard section — the worklist for leads with nowhere to go.
// Run: node tests/no-further-action-section.test.js
//
// With the discovery guards removed, a lead can be qualified and a call ended
// with nothing captured. setNoFurtherAction has always flagged those, but until
// this section the only reader was the lead detail page — visible solely to
// someone who had already opened that lead.
//
// The load-bearing cases, in order of what would actually bite:
//   • SCOPE — an intern must see theirs and ONLY theirs; a manager the team's.
//   • LIVE vs RAW — production showed 29 ever-flagged against 9 live. A section
//     that counted 29 would send people chasing leads that are already won,
//     lost or archived, and would look broken on day one.
//   • WORKLIST NOT SCORECARD — no per-person tallies, action-shaped rows.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const DashboardSectionsService = require("../services/DashboardSectionsService");

const TAG = `nfa-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (g, w, label) => ok(g === w, `${label} (got ${JSON.stringify(g)})`);

const created = { leads: [], admins: [], roles: [], depts: [] };
let phoneSeq = 0;
const nextPhone = () => `9${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(3, "0")}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(mgrRole._id, icRole._id);

    const mk = async (name, roleId, mgr) => {
      const a = await Admin.create({
        name: `${TAG}-${name}`, email: `${TAG}-${name}@x.com`, phone: nextPhone(),
        password: "x", roles: ["sales"], roleId, roleIds: [roleId],
        departmentId: dept._id, reportingManagerId: mgr || null, status: "active",
      });
      created.admins.push(a._id);
      return a;
    };
    const manager = await mk("mgr", mgrRole._id, null);
    const intern = await mk("intern", icRole._id, manager._id);
    const otherIntern = await mk("other", icRole._id, manager._id);

    // flaggedAt is the age clock — set it explicitly per lead.
    const lead = async (over = {}) => {
      const { flaggedDaysAgo, ...rest } = over;
      const l = await Enquiry.create({
        name: `${TAG}-lead`, phone: nextPhone(), source: "instagram",
        stage: "new", verified: false, isInterested: false, isLost: false,
        noFurtherAction: flaggedDaysAgo === undefined ? {} : {
          flagged: true,
          flaggedAt: new Date(now - flaggedDaysAgo * DAY),
          flaggedReason: "Saved without a next step (discovery incomplete)",
        },
        ...rest,
      });
      created.leads.push(l._id);
      return l;
    };

    const ownFilter = { assignedTo: intern._id };
    const teamFilter = { assignedTo: { $in: [manager._id, intern._id, otherIntern._id] } };
    const sectionFor = async (adminId, scope, filter) =>
      (await DashboardSectionsService.buildWorkspaceSections(adminId, scope, filter)).noFurtherAction;

    // ── fixtures ────────────────────────────────────────────────────────────
    const mine30 = await lead({ assignedTo: intern._id, flaggedDaysAgo: 30 });
    const mine7 = await lead({ assignedTo: intern._id, flaggedDaysAgo: 7 });
    const mine1 = await lead({ assignedTo: intern._id, flaggedDaysAgo: 1 });
    const theirs = await lead({ assignedTo: otherIntern._id, flaggedDaysAgo: 5 });
    // Flagged but NO LONGER LIVE — the 29-vs-9 case.
    await lead({ assignedTo: intern._id, flaggedDaysAgo: 20, stage: "won" });
    await lead({ assignedTo: intern._id, flaggedDaysAgo: 20, stage: "lost", isLost: true });
    await lead({ assignedTo: intern._id, flaggedDaysAgo: 20, archivedAt: new Date() });
    // Not flagged at all.
    await lead({ assignedTo: intern._id });

    console.log("\n1. SCOPE — an intern sees theirs, and only theirs");
    const own = await sectionFor(intern._id, "own", ownFilter);
    eq(own.count, 3, "intern sees their own 3 flagged live leads");
    ok(!own.rows.some((r) => r.leadId === String(theirs._id)),
      "…and NOT another intern's flagged lead");

    console.log("\n2. SCOPE — a manager sees the team's");
    const team = await sectionFor(manager._id, "team", teamFilter);
    eq(team.count, 4, "manager sees all 4 across the team");
    ok(team.rows.some((r) => r.leadId === String(theirs._id)),
      "…including the other intern's");

    console.log("\n3. LIVE vs RAW — won / lost / archived must not appear");
    // 7 leads carry the flag; only 4 are live. Counting raw would send people
    // chasing leads that are already closed.
    const rawFlagged = await Enquiry.countDocuments({
      _id: { $in: created.leads }, "noFurtherAction.flagged": true,
    });
    eq(rawFlagged, 7, "fixture check: 7 leads carry the flag");
    eq(team.count, 4, "…but the section counts only the 4 that are still live");
    ok(team.rows.every((r) => r.name.startsWith(TAG)), "rows are all ours (no bleed)");

    console.log("\n4. OLDEST FIRST — the age is the signal");
    eq(own.rows[0].leadId, String(mine30._id), "the 30-day-old lead is first");
    eq(own.rows[1].leadId, String(mine7._id), "then the 7-day-old");
    eq(own.rows[2].leadId, String(mine1._id), "then the 1-day-old");

    console.log("\n5. ageDays comes from flaggedAt, not createdAt");
    const r30 = own.rows.find((r) => r.leadId === String(mine30._id));
    eq(r30.ageDays, 30, "a lead flagged 30 days ago reports ageDays 30");
    ok(r30.since instanceof Date || typeof r30.since === "string", "…and carries `since`");
    // These fixtures were CREATED seconds ago — if ageDays read createdAt it
    // would be 0 for every row, which is the bug this pins.
    ok(own.rows.every((r) => r.ageDays !== 0 || r.leadId === String(mine1._id)) && r30.ageDays === 30,
      "…so a just-created lead flagged long ago is NOT reported as fresh");
    const noStamp = await Enquiry.create({
      name: `${TAG}-nostamp`, phone: nextPhone(), source: "instagram", stage: "new",
      verified: false, isInterested: false, isLost: false,
      noFurtherAction: { flagged: true, flaggedAt: null },
      assignedTo: intern._id,
    });
    created.leads.push(noStamp._id);
    const withNoStamp = await sectionFor(intern._id, "own", ownFilter);
    const nsRow = withNoStamp.rows.find((r) => r.leadId === String(noStamp._id));
    ok(nsRow && nsRow.ageDays === null, "a flag with NO flaggedAt reports ageDays null, not 0");
    // AND it sorts FIRST. Mongo orders null before dates ascending, so an
    // un-aged flag lands at the top of the worklist. Asserted deliberately
    // rather than discovered later: setNoFurtherAction always writes flaggedAt,
    // so a null one is inconsistent data, and surfacing it where somebody will
    // actually look is the behaviour we want — not burying it under 20 rows.
    eq(withNoStamp.rows[0].leadId, String(noStamp._id),
      "…and sorts FIRST — an unknown age is surfaced, not buried");
    // Removed here so the cap test below measures the cap and nothing else.
    await Enquiry.deleteOne({ _id: noStamp._id });

    console.log("\n6. WORKLIST, NOT SCORECARD");
    ok(own.rows.every((r) => r.needs === "a next step"),
      "every row says what the lead NEEDS (action-shaped)");
    const keys = Object.keys(own.rows[0]).sort();
    eq(JSON.stringify(keys), JSON.stringify(["ageDays","leadId","name","needs","ownerId","ownerName","since"].sort()),
      "row shape is exactly the agreed fields");
    const blob = JSON.stringify(own);
    ok(!/incomplete|failed|missed|score|total/i.test(blob),
      "no failure- or tally-shaped wording anywhere in the payload");
    ok(!Array.isArray(own.byOwner) && own.byOwner === undefined,
      "NO per-person aggregation — grouping these by owner rebuilds the hidden intern metric");
    ok(typeof own.count === "number" && Object.keys(own).sort().join() === "count,rows",
      "the section is exactly { count, rows } — count is the queue length, not a person's tally");

    console.log("\n7. THE 20-ROW CAP with an exact count");
    for (let i = 0; i < 22; i++) await lead({ assignedTo: otherIntern._id, flaggedDaysAgo: 40 + i });
    const big = await sectionFor(manager._id, "team", teamFilter);
    eq(big.rows.length, 20, "rows are capped at 20");
    eq(big.count, 26, "…while count stays exact (4 + 22)");
    eq(big.rows[0].ageDays, 61, "…and the cap keeps the OLDEST, not an arbitrary 20");

    console.log("\n8. ownerName is resolved");
    const mgrRow = team.rows.find((r) => r.leadId === String(theirs._id));
    eq(mgrRow.ownerName, `${TAG}-other`, "the row carries the owner's name");
    eq(mgrRow.ownerId, String(otherIntern._id), "…and their id");

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    await Enquiry.deleteMany({ _id: { $in: created.leads } });
    await Admin.deleteMany({ _id: { $in: created.admins } });
    await Role.deleteMany({ _id: { $in: created.roles } });
    await Department.deleteMany({ _id: { $in: created.depts } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
