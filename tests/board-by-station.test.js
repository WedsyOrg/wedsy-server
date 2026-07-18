// W3 — BOARD BY STATION test. Run: node tests/board-by-station.test.js
// Covers: station placement per deal-spine facts, pre-qual new/working split,
// lost + onboarded columns, intern column set, value gating by scope, and the
// query-count assertion (bulk spine — count must not scale per lead).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const CalendarEvent = require("../models/CalendarEvent");
const LeadPayment = require("../models/LeadPayment");
const BoardService = require("../services/BoardService");

const TAG = `board-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], events: [], payments: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    // Intern detection = role NAME in assignment.poolRoles (default "Sales Intern").
    const internRole = await Role.create({ name: "Sales Intern", departmentId: dept._id, permissions: ["leads:view:own"], description: TAG });
    created.roles.push(mgrRole._id, icRole._id, internRole._id);

    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const manager = await mkAdmin("mgr", mgrRole._id);
    const seller = await mkAdmin("seller", icRole._id, { reportingManagerId: manager._id });
    const internA = await mkAdmin("intern", internRole._id, { reportingManagerId: manager._id });
    created.admins.push(manager._id, seller._id, internA._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: seller._id, ...extra,
      });

    const Lnew = await mkLead("new", { stage: "new", firstRespondedAt: null });
    const Lwork = await mkLead("working", { firstRespondedAt: now });
    const Lqual = await mkLead("qualified", { qualified: true, qualifiedAt: now, firstRespondedAt: now });
    const Lmeet = await mkLead("meetset", {
      qualified: true, qualifiedAt: now, firstRespondedAt: now,
      followUps: [{ type: "meet", scheduledAt: new Date(+now + 2 * DAY), promiseNote: "", createdBy: seller._id }],
    });
    const Lheld = await mkLead("meetheld", { qualified: true, qualifiedAt: now, firstRespondedAt: now });
    const held = await CalendarEvent.create({ ownerId: seller._id, type: "gmeet", title: `${TAG} held`, start: new Date(+now - DAY), end: new Date(+now - DAY + 3600e3), leadId: Lheld._id, status: "closed", closedAt: new Date(+now - DAY) });
    created.events.push(held._id);
    const Lprop = await mkLead("proposal", {
      qualified: true, qualifiedAt: now, firstRespondedAt: now,
      proposalSentAt: now, dealValue: { amount: 200000, history: [] },
    });
    const Lagree = await mkLead("agreement", {
      qualified: true, qualifiedAt: now, firstRespondedAt: now,
      proposalSentAt: now, agreementSentAt: { at: now, by: seller._id },
      dealValue: { amount: 300000, history: [] },
    });
    const pay = await LeadPayment.create({ leadId: Lagree._id, amount: 25000, mode: "bank" });
    created.payments.push(pay._id);
    const Lwon = await mkLead("won", { qualified: true, qualifiedAt: now, firstRespondedAt: now, stage: "won" });
    const Llost = await mkLead("lost", { stage: "lost", isLost: true });
    created.leads.push(Lnew._id, Lwork._id, Lqual._id, Lmeet._id, Lheld._id, Lprop._id, Lagree._id, Lwon._id, Llost._id);

    const teamFilter = { assignedTo: { $in: [manager._id, seller._id] } };

    // ── Manager board (team scope) ──
    const b = await BoardService.board(manager._id, "team", teamFilter);
    const colOf = (doc) => {
      for (const k of Object.keys(b.columns)) {
        if (b.columns[k].leads.some((l) => String(l._id) === String(doc._id))) return k;
      }
      return null;
    };
    ok(colOf(Lnew) === "new", "unresponded pre-qual → new");
    ok(colOf(Lwork) === "working", "responded unqualified → working");
    ok(colOf(Lqual) === "qualified", "fresh qual (no spine facts) → qualified");
    ok(colOf(Lmeet) === "meeting_set", "meet follow-up booked → meeting_set");
    ok(colOf(Lheld) === "meeting_held", "closed calendar event → meeting_held");
    ok(colOf(Lprop) === "proposal", "proposalSentAt → proposal");
    ok(colOf(Lagree) === "agreement", "agreement sent + first payment → agreement");
    ok(colOf(Lwon) === "onboarded", "stage won → onboarded");
    ok(colOf(Llost) === "lost", "lost lead → lost column");
    ok(Object.keys(b.columns).length === 9 && b.columnKeys.length === 9, "manager gets all nine columns");

    // value gating — manager sees sums
    ok(b.columns.proposal.value === 200000, "proposal column sums dealValue (manager+)");
    ok(b.columns.agreement.value === 300000, "agreement column sums dealValue (manager+)");
    const propRow = b.columns.proposal.leads.find((l) => String(l._id) === String(Lprop._id));
    ok(propRow && propRow.dealValue && propRow.dealValue.amount === 200000, "manager rows carry dealValue.amount");
    ok(propRow && typeof propRow.dueToday === "number" && typeof propRow.overdue === "number", "rows carry dueToday/overdue marks");
    ok("snoozedUntil" in propRow, "rows carry snoozedUntil");

    // ── Own-scope board (seller) — value nulled ──
    const own = await BoardService.board(seller._id, "own", { assignedTo: seller._id });
    ok(own.columns.proposal.value === null, "own-scope column value is null");
    const ownRow = own.columns.proposal.leads.find((l) => String(l._id) === String(Lprop._id));
    ok(ownRow && ownRow.dealValue === null, "own-scope rows carry dealValue null");

    // ── Intern column set ──
    const ib = await BoardService.board(internA._id, "own", { assignedTo: seller._id });
    ok(ib.intern === true, "intern caller detected via assignment.poolRoles");
    ok(JSON.stringify(ib.columnKeys) === JSON.stringify(["new", "working", "qualified", "lost"]), "intern gets ONLY new/working/qualified/lost");
    const iColOf = (doc) => {
      for (const k of Object.keys(ib.columns)) {
        if (ib.columns[k].leads.some((l) => String(l._id) === String(doc._id))) return k;
      }
      return null;
    };
    ok(iColOf(Lprop) === "qualified" && iColOf(Lagree) === "qualified", "intern: station leads collapse into qualified");
    ok(iColOf(Llost) === "lost" && iColOf(Lnew) === "new" && iColOf(Lwork) === "working", "intern: pre-qual/lost placement unchanged");

    // ── Query-count discipline (bulk spine, no N+1) ──
    let queries = 0;
    mongoose.set("debug", () => { queries += 1; });
    await BoardService.board(manager._id, "team", teamFilter);
    const q1 = queries;
    for (let i = 0; i < 4; i++) {
      const extra = await mkLead(`extraq-${i}`, { qualified: true, qualifiedAt: now, firstRespondedAt: now, proposalSentAt: now });
      created.leads.push(extra._id);
    }
    queries = 0;
    await BoardService.board(manager._id, "team", teamFilter);
    const q2 = queries;
    mongoose.set("debug", false);
    console.log(`    queries: ${q1} → ${q2} (after +4 qualified leads)`);
    // +1 tolerance: the settings cache (5-min TTL) can expire between runs and
    // add one read — the point is the count not scaling with lead count.
    ok(q2 <= q1 + 1, `query count does not scale with lead count (${q1} → ${q2})`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    mongoose.set("debug", false);
    await CalendarEvent.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await LeadPayment.deleteMany({ _id: { $in: created.payments } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
