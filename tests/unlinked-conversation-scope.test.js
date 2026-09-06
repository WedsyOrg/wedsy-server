/**
 * AN UNOWNED CONVERSATION IS NOT "OUT OF YOUR SCOPE" (#191).
 *
 * getScoped throws 403 for a scope-filtered caller when enquiryId is null, and
 * listInbox filters enquiryId:{$in: inScopeIds}, which a null never matches. A
 * fresh Instagram DM has no linked lead until a phone number is captured — so a
 * salesperson on leads:view:own or :team can neither SEE nor TAKE OVER the
 * threads where a human is most needed. Founders are on :all, which resolves to
 * an empty scope filter and skips the check, which is why nobody reported it.
 *
 * This compounds the closed-conversation repair: 17 of the 27 leaked threads are
 * unlinked Instagram. Reopening them puts them in an inbox that scoped reps
 * still cannot see.
 *
 * THE SEMANTIC: everywhere else in this codebase unassigned work is a TRIAGE
 * QUEUE — visible to the team, claimable by whoever gets there. getScoped was
 * the odd one out in reading "no owner" as "someone else's". There is no scope
 * to be outside of.
 *
 * Born red.
 *
 *   node tests/unlinked-conversation-scope.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const WAConversation = require("../models/WAConversation");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const svc = require("../services/WAConversationService");

const TAG = `unlinked-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

const cleanup = { convs: [], leads: [], admins: [] };
let seq = 0;
const nextPhone = () => `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const mkAdmin = async (n) => {
      const a = await Admin.create({ name: `${TAG}-${n}`, email: `${TAG}-${n}@x.com`,
        phone: nextPhone(), password: "x", roles: ["sales"], status: "active" });
      cleanup.admins.push(a._id); return a;
    };
    const rep = await mkAdmin("rep");
    const otherRep = await mkAdmin("other");

    const mkLead = async (owner) => {
      const l = await Enquiry.create({ name: `${TAG}-lead`, phone: nextPhone(), source: "instagram",
        stage: "new", verified: false, isInterested: false, isLost: false, assignedTo: owner._id });
      cleanup.leads.push(l._id); return l;
    };
    const mkConv = async (n, over = {}) => {
      const c = await WAConversation.create({ phone: `${TAG}_${n}`, channel: "instagram",
        profileName: n, status: "active", mode: "ai", enquiryId: null,
        lastInboundAt: new Date(), lastMessageAt: new Date(), ...over });
      cleanup.convs.push(c._id); return c;
    };

    const unlinked = await mkConv("fresh");                       // a fresh IG DM
    const mine = await mkConv("mine", { enquiryId: (await mkLead(rep))._id });
    const theirs = await mkConv("theirs", { enquiryId: (await mkLead(otherRep))._id });

    const ownFilter = { assignedTo: rep._id };
    const sees = async (filter) => {
      const r = await svc.listInbox({ limit: 200 }, filter);
      return (id) => r.list.some((c) => String(c._id) === String(id));
    };
    const tryGet = async (id, filter) => {
      try { await svc.getScoped(id, filter); return { ok: true }; }
      catch (e) { return { ok: false, status: e.status, message: e.message }; }
    };
    const tryTakeover = async (id, filter) => {
      try { await svc.takeover(id, rep._id, filter); return { ok: true }; }
      catch (e) { return { ok: false, status: e.status, message: e.message }; }
    };

    console.log("\n1. A SCOPED REP CAN SEE AN UNOWNED THREAD");
    {
      const scopedSees = await sees(ownFilter);
      eq(scopedSees(unlinked._id), true, "an unlinked thread IS in a scoped rep's inbox");
      eq(scopedSees(mine._id), true, "…so is their own linked thread");
      eq(scopedSees(theirs._id), false, "…and another rep's linked thread is STILL hidden");
    }

    console.log("\n2. A SCOPED REP CAN OPEN AND TAKE OVER AN UNOWNED THREAD");
    {
      const g = await tryGet(unlinked._id, ownFilter);
      eq(g.ok, true, "getScoped allows an unlinked thread for a scoped caller");
      const t = await tryTakeover(unlinked._id, ownFilter);
      eq(t.ok, true, "takeover succeeds — the escalation path works where it is needed most");
      const after = await WAConversation.findById(unlinked._id).lean();
      eq(after.mode, "human", "…and the thread is actually handed to the human");
    }

    console.log("\n3. SCOPING IS NOT WEAKENED FOR OWNED THREADS");
    {
      const g = await tryGet(theirs._id, ownFilter);
      eq(g.ok, false, "another rep's linked thread is still refused");
      eq(g.status, 403, "…with 403");
      const t = await tryTakeover(theirs._id, ownFilter);
      eq(t.ok, false, "…and cannot be taken over");
    }
    {
      const g = await tryGet(mine._id, ownFilter);
      eq(g.ok, true, "a rep's OWN linked thread is still allowed");
    }

    console.log("\n4. AN UNSCOPED CALLER IS UNCHANGED");
    {
      const allSees = await sees({});
      eq(allSees(unlinked._id), true, "founder sees the unlinked thread");
      eq(allSees(theirs._id), true, "…and every linked one");
      const g = await tryGet(theirs._id, {});
      eq(g.ok, true, "…and can open any of them");
    }

    console.log("\n5. THE #191 + LEAK INTERACTION — a reopened unlinked thread is reachable");
    {
      const closed = await mkConv("reopened", { status: "closed", unreadCount: 3 });
      await svc.recordInbound(closed.phone, "hello? still waiting", "instagram");
      const scopedSees = await sees(ownFilter);
      eq(scopedSees(closed._id), true,
        "a reopened UNLINKED thread reaches a scoped rep — the 17-thread tier");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    await WAConversation.deleteMany({ phone: new RegExp(`^${TAG}`) });
    await Enquiry.deleteMany({ _id: { $in: cleanup.leads } });
    await Admin.deleteMany({ _id: { $in: cleanup.admins } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
