/**
 * COUPLE APP § 06.2 — GET /wedding/:id AND GET /wedding/:id/home, AGAINST A
 * REAL DATABASE.
 *
 * ⚠ NEEDS A DEV DATABASE. Connects with process.env.DATABASE_URL and writes
 * real documents (tagged, removed in the finally block). NOT RUN when written —
 * there is no MongoDB in the build container — so treat every assertion here as
 * unverified until someone runs it. Never point DATABASE_URL at production
 * (repo rule 7).
 *
 *   node tests/couple-wedding-home.int.test.js
 *
 * What it proves that the pure tests cannot: that the two responses match the
 * shapes wedsy-user's screens were built against (lib/plan/api.js →
 * `api.wedding`, `api.home`; fixtures in lib/plan/seed.js), that the Event's
 * eventDays[] really do come back as the couple app's "functions", and that
 * Home's stats are the SAME numbers the guest and payment collections hold.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Event = require("../models/Event");
const Guest = require("../models/Guest");
const Payment = require("../models/Payment");
const CoupleTask = require("../models/CoupleTask");
const SharedMember = require("../models/SharedMember");
const CoupleWeddingService = require("../services/CoupleWeddingService");
const CoupleActivityService = require("../services/CoupleActivityService");
const ActivityLog = require("../models/ActivityLog");

const TAG = `couplehome-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const created = { users: [], events: [], guests: [], payments: [], tasks: [], members: [], logs: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const mother = await User.create({ name: `${TAG}-mother`, phone: `${TAG}-m` });
    created.users.push(bride._id, mother._id);

    const event = await Event.create({
      user: bride._id,
      name: `${TAG} wedding`,
      brideName: "Ananya Sharma", groomName: "Karthik Reddy", eventDate: "2026-12-14",
      eventDays: [
        { name: "Haldi", date: "2026-12-12", time: "10:00", venue: "Home, Jayanagar", decorItems: [] },
        { name: "Wedding", date: "2026-12-14", time: "07:40", venue: "To be confirmed",
          decorItems: [{ category: "Mandap", variant: "artificialFlowers", price: 410000 }] },
      ],
      coupleApp: {
        partners: [{ user: bride._id, name: "Ananya Sharma", role: "bride" }],
        city: "Bengaluru", muhurthamTime: "07:40",
        budget: { estimate: 1840000, target: 1840000, lines: [{ sourceKey: "decor:x", source: "decor", label: "Wedding décor", amount: 410000 }] },
      },
    });
    created.events.push(event._id);
    const weddingId = String(event._id);

    const guests = await Guest.insertMany([
      { weddingId: event._id, first: "Meera", last: "Iyer", side: "bride", phone: "+91 98450 11223", phoneNormalised: "919845011223", party: 4, rsvp: "yes", events: ["haldi", "wedding"] },
      { weddingId: event._id, first: "Divya", last: "Shetty", side: "bride", phone: "+91 91230 44556", party: 1, rsvp: "no", events: ["wedding"] },
      { weddingId: event._id, first: "Arjun", last: "Reddy", side: "groom", phone: "+91 99720 12345", party: 5, rsvp: "pending", events: ["wedding"] },
    ]);
    created.guests = guests.map((g) => g._id);

    const payments = await Payment.insertMany([
      { user: bride._id, amount: 85000, amountPaid: 85000, amountDue: 0, paymentFor: "event", event: event._id, paymentMethod: "upi", status: "paid",
        coupleApp: { weddingId: event._id, label: "Booking advance — décor", vendor: "Wedsy", ref: "WD-2026-0431", dueDate: new Date("2026-09-01"), sourceKey: `${TAG}:1` } },
      { user: bride._id, amount: 150000, amountDue: 150000, paymentFor: "event", event: event._id, status: "created",
        coupleApp: { weddingId: event._id, label: "Venue hold — Taj West End", vendor: "Taj West End", ref: "WD-2026-0518", dueDate: new Date(Date.now() + 5 * 86400000), sourceKey: `${TAG}:2` } },
    ]);
    created.payments = payments.map((p) => p._id);

    const task = await CoupleTask.create({ weddingId: event._id, title: `${TAG} choose a palette`, dueDate: new Date(Date.now() - 86400000), createdByName: "you" });
    created.tasks.push(task._id);

    const log = await ActivityLog.create(
      CoupleActivityService.buildLog({ weddingId, actorType: "team", actor: { name: "Ravi Menon" }, action: "venue.shortlisted", summary: "shortlisted 5 venues for 14 December" })
    );
    created.logs.push(log._id);

    const partner = { userId: String(bride._id), weddingId, event: event.toObject(), role: "partner", member: null };

    console.log("GET /wedding/:id:");
    {
      const w = await CoupleWeddingService.getWedding(partner);
      eq(w.id, weddingId, "the wedding IS the Event");
      eq(w.weddingDate, "2026-12-14", "the date comes off Event.eventDate");
      eq(w.city, "Bengaluru", "the city off the couple-app block");
      eq(w.budgetTarget, 1840000, "the target");
      eq(w.budgetCommitted, 410000, "committed is Σ budget lines (§ 06.3)");
      eq(w.budgetPaid, 85000, "paid is the sum of paid Payment rows");
      eq(w.events.length, 2, "both eventDays come back as functions");
      eq(w.events[0].key, "haldi", "the day's key is derived from its name");
      eq(w.events[1].decorStatus, "priced", "a day with priced items reads as priced");
      eq(w.events[1].expectedGuests, 9, "per-day expected guests is the guest list narrowed to that function (4 + 5, minus the decline)");
      eq(w.partners[0].name, "Ananya Sharma", "the partners");
      eq(w.viewer.role, "partner", "the viewer's own standing");
      eq(w.viewer.canInitiatePayout, true, "a partner may move money");
      ok(Array.isArray(w.team), "team is an array even with no lead attached");
    }

    console.log("GET /wedding/:id/home:");
    {
      const h = await CoupleWeddingService.getHome(partner);
      eq(h.stats.headcount, 9, "headcount is Σ party where rsvp ≠ no");
      eq(h.stats.invited, 3, "invited counts rows");
      eq(h.stats.replied, 2, "replied counts yes + no");
      eq(h.stats.budgetCommitted, 410000, "the same committed number Home and the tracker share");
      eq(h.stats.budgetPaid, 85000, "the same paid number");
      eq(h.stats.openTasks, 1, "the open task");
      ok(h.decisions.length > 0 && h.decisions.length <= 3, "decisions are present and capped at 3");
      eq(h.decisions[0].position, 1, "positions stamped");
      eq(h.stats.openDecisions >= h.decisions.length, true, "the pill counts every blocking item");
      eq(h.activity.length, 1, "the activity row we wrote comes back");
      eq(h.activity[0].actorName, "Ravi Menon", "shaped for the card");
      ok(h.activity[0].unread === true, "and is unread by this partner");
    }

    console.log("§ 06.4 — the same Home, read by a shared member with no payments access:");
    {
      const memberDoc = await SharedMember.create({
        weddingId: event._id, user: mother._id, name: "Sunita Sharma", relation: "Bride's mother", acceptedAt: new Date(),
        access: { guests: "view", website: "none", decor: "none", registry: "none", payments: "none", tasks: "none" },
      });
      created.members.push(memberDoc._id);
      const h = await CoupleWeddingService.getHome({ userId: String(mother._id), weddingId, event: event.toObject(), role: "member", member: memberDoc.toObject() });
      eq(h.stats.headcount, 9, "she sees the headcount her guests access covers");
      eq(h.stats.budgetPaid, null, "and NULL — not 0 — for the money she may not see");
      eq(h.stats.openTasks, null, "and for the tasks");
      ok(h.decisions.every((d) => d.type !== "payment" && d.type !== "task"), "no decision card leaks a section she cannot open");

      const w = await CoupleWeddingService.getWedding({ userId: String(mother._id), weddingId, event: event.toObject(), role: "member", member: memberDoc.toObject() });
      eq(w.budgetTarget, null, "the wedding read withholds the budget too");
      eq(w.viewer.canInitiatePayout, false, "and she may never move money");
      eq(w.weddingDate, "2026-12-14", "but the wedding's own facts are hers to see");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Guest.deleteMany({ _id: { $in: created.guests } }),
      Payment.deleteMany({ _id: { $in: created.payments } }),
      CoupleTask.deleteMany({ _id: { $in: created.tasks } }),
      SharedMember.deleteMany({ _id: { $in: created.members } }),
      ActivityLog.deleteMany({ _id: { $in: created.logs } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
