/**
 * COUPLE APP § 06.3 — VENUES, DÉCOR, BUDGET, THE STORE AND MAKEUP, AGAINST A
 * REAL DATABASE AND OVER REAL HTTP.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container and
 * none on the machine this milestone was built on — so treat it as unverified
 * until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-planning.int.test.js
 *
 * ⚠ Some assertions need the Payment unique sparse index to exist. The setup
 * calls Payment.syncIndexes() before anything is written; on a database that
 * already holds couple-app rows this may take a moment.
 *
 * ── WHAT IT PROVES THAT THE PURE TESTS CANNOT ──────────────────────────────
 *
 *   1. THE DEFINITION OF DONE for this milestone: a couple finalises their
 *      décor and, with NO MANUAL STEP, the committed budget and the payment
 *      schedule are there on the very next read of `GET /wedding/:id/budget`
 *      and `GET /wedding/:id/payments` — the money milestone's own endpoint,
 *      reading rows this one generated.
 *   2. IDEMPOTENCE AS MONGODB EXECUTES IT. Finalising twice — and then TWICE
 *      CONCURRENTLY — leaves exactly one budget line per day and exactly
 *      three Payment rows per day, because the unique sparse index on
 *      { coupleApp.weddingId, coupleApp.sourceKey } is what enforces it. A
 *      pure test can only assert the decision.
 *   3. That a SENT STORE DRAFT really becomes a QuoteRequest on the SAME queue
 *      the concierge path uses — read back off models/QuoteRequest, with the
 *      couple's picks in its payload and the lead resolved.
 *   4. That ACCEPTING A MAKEUP BID marks every losing bid, closes the round,
 *      and puts the retainer on the SAME payment schedule — not a second one.
 *   5. That `decorStatus: "needs_input"` really comes back over the wire once
 *      the décor team raises it, and that finalising clears it.
 *   6. That décor at `view` is refused a heart and a finalise over HTTP, with
 *      a real token and a real SharedMember row.
 *   7. That a venue reaction lands on VenueShortlist.items[].reaction as the
 *      venue team's own value ("no", never "pass").
 *
 * The venue MARKETPLACE (`GET /venues`) is deliberately not exercised here: it
 * is controllers/venue.getVenues, which predates this milestone and has its own
 * tests.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const Guest = require("../models/Guest");
const Payment = require("../models/Payment");
const SharedMember = require("../models/SharedMember");
const ActivityLog = require("../models/ActivityLog");
const Venue = require("../models/Venue");
const VenueShortlist = require("../models/VenueShortlist");
const QuoteRequest = require("../models/QuoteRequest");
const PlanSnapshot = require("../models/PlanSnapshot");
const Decor = require("../models/Decor");
const Category = require("../models/Category");
const Bidding = require("../models/Bidding");
const BiddingBid = require("../models/BiddingBid");
const BiddingBooking = require("../models/BiddingBooking");
const Vendor = require("../models/Vendor");

const TAG = `coupleplan-${Date.now()}`;

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [], venues: [], vendors: [], biddings: [], categories: [], decors: [] };

const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
app.use("/", require("../routes/coupleApp-planning").itemRoutes);
app.use("/", require("../routes/coupleApp-money").itemRoutes);
app.use("/", require("../routes/coupleApp-people").itemRoutes);

let base = "";
const token = (id) => jwt.sign({ _id: String(id) }, process.env.JWT_SECRET);

const call = async (method, path, { as, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: res.status, data, text };
};

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await Payment.syncIndexes();

    server = http.createServer(app).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    /* ── the wedding ────────────────────────────────────────────────────── */

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const auntie = await User.create({ name: `${TAG}-auntie`, phone: `${TAG}-a` });
    created.users.push(bride._id, auntie._id);

    const leadId = new mongoose.Types.ObjectId();
    const event = await Event.create({
      user: bride._id,
      leadId,
      name: `${TAG} wedding`,
      brideName: "Ananya",
      groomName: "Vikram",
      eventDate: "2026-12-14",
      eventDays: [
        { name: "Haldi", date: "2026-12-12", time: "10:00", venue: "Home", decorItems: [{ category: "Stage", variant: "artificialFlowers", price: 97000 }] },
        { name: "Wedding", date: "2026-12-14", time: "07:40", venue: "Taj West End", decorItems: [{ category: "Mandap", variant: "naturalFlowers", price: 323000 }] },
        { name: "Reception", date: "2026-12-14", time: "19:00", venue: "Taj West End", decorItems: [{ category: "Stage", variant: "mixedFlowers", price: 0 }] },
      ],
      coupleApp: {
        city: "Bengaluru",
        partners: [{ user: bride._id, name: "Ananya Sharma", role: "bride" }, { name: "Vikram Reddy", role: "groom" }],
      },
    });
    created.events.push(event._id);
    const id = String(event._id);
    const AS_BRIDE = token(bride._id);
    const AS_AUNTIE = token(auntie._id);

    await Guest.create([
      { weddingId: event._id, first: "Meera", last: "Iyer", side: "bride", party: 4, rsvp: "yes", events: ["wedding"] },
      { weddingId: event._id, first: "Rahul", last: "Nair", side: "groom", party: 2, rsvp: "pending", events: ["wedding", "haldi"] },
      { weddingId: event._id, first: "Priya", last: "Rao", side: "bride", party: 6, rsvp: "no", events: ["wedding"] },
    ]);

    // A shared family member who may LOOK at the planning and nothing else.
    await SharedMember.create({
      weddingId: event._id, user: auntie._id, name: "Sunita", relation: "Bride's mother",
      acceptedAt: new Date(), revokedAt: null,
      access: { guests: "view", website: "none", decor: "view", registry: "none", payments: "none", tasks: "none" },
    });

    const days = (await Event.findById(event._id).lean()).eventDays;
    const HALDI = String(days[0]._id);
    const WEDDING = String(days[1]._id);
    const RECEPTION = String(days[2]._id);

    /* ── § 06.4 · the refusals, over HTTP ───────────────────────────────── */

    console.log("Décor at `view` may read everything and change nothing:");
    {
      for (const path of [`/wedding/${id}/decor`, `/wedding/${id}/budget`, `/wedding/${id}/venues`, `/wedding/${id}/makeup`, `/wedding/${id}/store/draft`, `/wedding/${id}/store/catalogue`]) {
        eq((await call("GET", path, { as: AS_AUNTIE })).status, 200, `GET ${path} — a viewer may read`);
      }
      const heart = await call("POST", `/decor/${id}/heart`, { as: AS_AUNTIE, body: { themeId: "t-rose" } });
      eq(heart.status, 403, "POST /decor/:id/heart — refused at view");
      eq(heart.data.error, "forbidden", "…with the foundation's refusal shape");
      eq(heart.data.section, "decor", "…naming the section");
      eq(heart.data.required, "edit", "…and the level it needed");

      const fin = await call("POST", `/decor/${id}/finalise`, { as: AS_AUNTIE, body: { tier: "signature" } });
      eq(fin.status, 403, "POST /decor/:id/finalise — refused at view");
      eq(fin.data.error, "forbidden", "…the same way");

      const target = await call("PUT", `/wedding/${id}/budget/target`, { as: AS_AUNTIE, body: { target: 1 } });
      eq(target.status, 403, "PUT /wedding/:id/budget/target — refused at view");

      const stranger = await call("GET", `/wedding/${id}/decor`, { as: token(new mongoose.Types.ObjectId()) });
      ok(stranger.status === 401 || stranger.status === 403, "a signed-in stranger never reads the décor");
      eq((await call("GET", `/wedding/${id}/decor`)).status, 401, "and no token at all is a 401");
    }

    /* ── § 3.2.2 · the five states, and needs_input over the wire ───────── */

    console.log("The five-state journey, as the server derives it:");
    {
      const before = await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE });
      eq(before.status, 200, "GET /wedding/:id/decor answers");
      const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
      let state = byId(before.data.days);
      eq(state[WEDDING].decorStatus, "needs_input", "a PRICED day with no tier chosen is waiting on the couple");
      eq(state[RECEPTION].decorStatus, "needs_input", "…and so is a DRAFTED day with nothing hearted");
      ok(String(state[RECEPTION].needsInputReason).length > 0, "each one says why");

      await call("POST", `/decor/${id}/heart`, { as: AS_BRIDE, body: { themeId: "t-rose", event: "reception" } });
      state = byId((await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE })).data.days);
      eq(state[RECEPTION].decorStatus, "drafted", "hearting a look for that function moves it to drafted");

      await call("POST", `/decor/${id}/select-tier`, { as: AS_BRIDE, body: { tier: "signature" } });
      state = byId((await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE })).data.days);
      eq(state[WEDDING].decorStatus, "priced", "choosing a tier answers the priced day");

      // The décor team raises a question — the one thing that is genuinely stored.
      await Event.updateOne(
        { _id: event._id },
        { $push: { "coupleApp.decor.days": { dayId: HALDI, needsInput: true, needsInputNote: "Marigold or rose?" } } }
      );
      state = byId((await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE })).data.days);
      eq(state[HALDI].decorStatus, "needs_input", "a raised flag reads as needs_input over the wire");
      eq(state[HALDI].needsInputReason, "Marigold or rose?", "in the team's own words");
    }

    console.log("Hearting is a TOGGLE, because the client's control is one:");
    {
      const on = await call("POST", `/decor/${id}/heart`, { as: AS_BRIDE, body: { productId: "p-rose1" } });
      eq(on.data.hearted, true, "the first tap hearts it");
      const off = await call("POST", `/decor/${id}/heart`, { as: AS_BRIDE, body: { productId: "p-rose1" } });
      eq(off.data.hearted, false, "the second unhearts it");
      const hearts = (await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE })).data.hearts;
      eq(hearts.filter((heart) => heart.id === "p-rose1").length, 0, "and the row is gone, not duplicated");
    }

    /* ── § 06.3 invariant 3 · THE DEFINITION OF DONE ────────────────────── */

    console.log("FINALISING → the committed budget and the payment schedule, with no manual step:");
    let committed = 0;
    {
      const fin = await call("POST", `/decor/${id}/finalise`, { as: AS_BRIDE, body: { tier: "signature" } });
      eq(fin.status, 200, "POST /decor/:id/finalise answers");
      ok(fin.data.alreadyFinalised === false, "the first finalise is not 'already'");
      committed = fin.data.committed;
      eq(committed, 420000, "the committed total is the two priced days: ₹97,000 + ₹3,23,000");

      const budget = await call("GET", `/wedding/${id}/budget`, { as: AS_BRIDE });
      eq(budget.data.committed, committed, "GET /wedding/:id/budget reports the SAME number");
      eq(budget.data.lines.length, 2, "one budget line per finalised day");

      // The money milestone's own endpoint, reading rows this one generated.
      const payments = await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE });
      eq(payments.status, 200, "GET /wedding/:id/payments answers");
      eq(payments.data.length, 6, "three instalments for each of the two days");
      eq(
        payments.data.reduce((sum, row) => sum + row.amount, 0),
        committed,
        "and the schedule sums to the committed amount EXACTLY"
      );
      ok(payments.data.every((row) => row.dueDate), "every row falls due on a real date");
      ok(payments.data.every((row) => row.status === "due"), "and none of them is paid yet");

      const home = await call("GET", `/wedding/${id}/home`, { as: AS_BRIDE });
      eq(home.data.stats.budgetCommitted, committed, "Home's budget card reads the same one number (§ 06.3)");
    }

    console.log("The day is locked, and the team is no longer waiting on it:");
    {
      const after = await Event.findById(event._id).lean();
      ok(after.eventDays[0].status.finalized, "the Haldi is finalised on the Event itself");
      ok(after.eventDays[1].status.finalized, "and so is the wedding day");
      eq(after.finalisedBy, "couple", "models/Event's own lock records who did it");
      ok(after.locked, "and the draft is locked");
      const raised = (after.coupleApp.decor.days || []).find((row) => String(row.dayId) === HALDI);
      eq(raised.needsInput, false, "the raised question is cleared by the finalise");
      const state = (await call("GET", `/wedding/${id}/decor`, { as: AS_BRIDE })).data;
      eq(state.days.find((day) => day.id === HALDI).decorStatus, "finalised", "and the day reads finalised");
    }

    console.log("FINALISING TWICE changes nothing (§ 06.3, and the unique index):");
    {
      const again = await call("POST", `/decor/${id}/finalise`, { as: AS_BRIDE, body: { tier: "signature" } });
      eq(again.status, 200, "the second finalise is a 200, not an error");
      ok(again.data.alreadyFinalised === true, "…and it says it has already happened");
      eq(again.data.committed, committed, "the commitment did not double");

      const payments = await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE });
      eq(payments.data.length, 6, "still six payment rows — not twelve");

      const budget = await call("GET", `/wedding/${id}/budget`, { as: AS_BRIDE });
      eq(budget.data.lines.length, 2, "still two budget lines");
    }

    console.log("TWO CONCURRENT FINALISES — the index, as MongoDB enforces it:");
    {
      const [a, b] = await Promise.all([
        call("POST", `/decor/${id}/finalise`, { as: AS_BRIDE, body: { tier: "signature" } }),
        call("POST", `/decor/${id}/finalise`, { as: AS_BRIDE, body: { tier: "signature" } }),
      ]);
      ok(a.status === 200 && b.status === 200, "both answer");
      const rows = await Payment.find({ "coupleApp.weddingId": event._id }).lean();
      eq(rows.length, 6, "and there are STILL exactly six rows — the unique sparse index is what makes that true");
      eq(new Set(rows.map((row) => row.coupleApp.sourceKey)).size, 6, "six distinct source keys");
    }

    console.log("A price that moved while they were reading it:");
    {
      const stale = await call("POST", `/decor/${id}/finalise`, { as: AS_BRIDE, body: { tier: "signature", total: 999 } });
      eq(stale.status, 409, "a shown total that does not match is a 409");
      eq(stale.data.error, "price_changed", "…named, so the screen can say what happened");
      eq(stale.data.now, committed, "and it names the real figure");
    }

    /* ── § 3.2.3 · the budget estimator ─────────────────────────────────── */

    console.log("The estimate reads the SERVER's headcount and the Event's dates:");
    {
      const headcount = await call("GET", `/wedding/${id}/guests/headcount`, { as: AS_BRIDE });
      eq(headcount.data.headcount, 7, "the guest list says seven people (4 + 2 + 1; the 'no' subtracts nothing)");

      const built = await call("POST", `/wedding/${id}/budget/estimate`, {
        as: AS_BRIDE,
        body: {
          events: ["haldi", "wedding", "reception"],
          venue: "banquet", decor: "signature", catering: "gold",
          rooms: 35, services: ["photo", "makeup", "invites"],
          // HOSTILE: none of these may reach a variable.
          headcount: 9999, estimate: 1, days: 1,
        },
      });
      eq(built.status, 200, "POST /wedding/:id/budget/estimate answers");
      eq(built.data.seats, 7, "the seats are the SERVER's seven, not the body's 9,999");
      eq(built.data.days, 2, "and the days are the Event's two DISTINCT DATES, not the body's 1");
      eq(
        built.data.categories.find((row) => row.id === "catering").amount,
        1400 * 7 * 3,
        "catering is ₹1,400 × 7 seats × 3 functions"
      );
      ok(built.data.estimate > 1, "and the stored estimate is the server's, not the body's ₹1");

      const budget = await call("GET", `/wedding/${id}/budget`, { as: AS_BRIDE });
      eq(budget.data.estimate, built.data.estimate, "GET /wedding/:id/budget returns the stored one");
      ok(!("headcount" in budget.data.answers), "and `headcount` was never even stored");

      const target = await call("PUT", `/wedding/${id}/budget/target`, { as: AS_BRIDE, body: { target: 1840000 } });
      eq(target.status, 200, "PUT /wedding/:id/budget/target answers");
      eq((await call("GET", `/wedding/${id}/budget`, { as: AS_BRIDE })).data.target, 1840000, "and it sticks");
      eq(
        (await call("PUT", `/wedding/${id}/budget/target`, { as: AS_BRIDE, body: { target: -5 } })).status,
        422,
        "a negative budget is refused"
      );
    }

    /* ── § 3.2.1 · the venue shortlist and its reactions ────────────────── */

    console.log("A venue reaction lands on the VENUE TEAM's own field:");
    {
      const venue = await Venue.create({
        name: `${TAG} Taj West End`, slug: `${TAG}-taj`, locality: "Race Course Road", status: "published",
        spaces: [{ name: "Lawn", capacitySeated: 600, isBookable: true }],
        pricing: { tiers: [{ hours: 12, price: 240000 }, { hours: 24, price: 320000 }] },
      });
      created.venues.push(venue._id);
      await VenueShortlist.create({
        crmEnquiryId: String(leadId), coupleName: "Ananya & Vikram",
        items: [{ venue: venue._id, status: "presented", notes: "Heritage banyans and low golden light by six." }],
      });

      const list = await call("GET", `/wedding/${id}/venues`, { as: AS_BRIDE });
      eq(list.status, 200, "GET /wedding/:id/venues answers");
      eq(list.data.shortlist.length, 1, "the shortlist is the venue team's own row");
      eq(list.data.shortlist[0].id, String(venue._id), "keyed by the VENUE id, which is what the client reacts with");
      eq(list.data.shortlist[0].capacity, 600, "with the seated capacity off its spaces");
      eq(list.data.shortlist[0].priceLow, 240000, "the cheapest tier");
      eq(list.data.shortlist[0].priceHigh, 320000, "and the dearest");
      eq(list.data.shortlist[0].note, "Heritage banyans and low golden light by six.", "and the planner's own words");
      eq(list.data.shortlist[0].reaction, "", "nothing reacted yet");

      const react = await call("POST", `/venues/${venue._id}/react`, { as: AS_BRIDE, body: { reaction: "pass" } });
      eq(react.status, 200, "POST /venues/:id/react answers");
      eq(react.data.reaction, "pass", "and answers in the COUPLE's vocabulary");

      const stored = await VenueShortlist.findOne({ crmEnquiryId: String(leadId) }).lean();
      eq(stored.items[0].reaction, "no", "…while the VENUE TEAM's field holds \"no\", which is its enum's word");
      eq(stored.items[0].status, "reacted", "and the row moves to reacted on their board");

      eq(
        (await call("POST", `/venues/${venue._id}/react`, { as: AS_BRIDE, body: { reaction: "adore" } })).status,
        422,
        "a reaction outside the three is refused rather than stored"
      );
      eq(
        (await call("POST", `/venues/${venue._id}/react`, { as: AS_AUNTIE, body: { reaction: "love" } })).status,
        403,
        "and a viewer cannot react at all"
      );
    }

    /* ── § 06.3 · store draft → THE ONE QUOTE PIPELINE ──────────────────── */

    console.log("A sent store draft becomes a QuoteRequest on the SAME queue:");
    {
      const category = await Category.create({ name: `${TAG} Mandap`, order: 1, status: true });
      created.categories.push(category._id);
      const product = await Decor.create({
        name: `${TAG} Floral cascade mandap`, category: `${TAG} Mandap`, unit: "piece",
        image: "/x.webp", thumbnail: "/x.webp", rating: 5, tags: [],
        productVisibility: true, productAvailability: true,
        // The catalogue sorts by bestSellerOrder and caps at 300. On a dev
        // database carrying real stock this fixture would otherwise fall off
        // the end of the page and the assertions below would fail for a reason
        // that has nothing to do with the endpoint.
        bestSellerOrder: -1,
        productTypes: [{ name: "Natural", sellingPrice: 180000 }, { name: "Artificial", sellingPrice: 145000 }],
        productVariation: { occassion: ["Wedding"] },
      });
      created.decors.push(product._id);

      const catalogue = await call("GET", `/wedding/${id}/store/catalogue`, { as: AS_BRIDE });
      eq(catalogue.status, 200, "GET /wedding/:id/store/catalogue answers");
      const mine = catalogue.data.products.find((row) => row.id === String(product._id));
      ok(mine, "the real catalogue product is on it");
      eq(mine.from, 145000, "at its CHEAPEST tier — a starting price");
      ok(catalogue.data.categories.some((row) => row.id === mine.cat), "and its category is a tab");

      const added = await call("POST", `/wedding/${id}/store/draft/items`, { as: AS_BRIDE, body: { productId: String(product._id) } });
      eq(added.status, 201, "POST …/store/draft/items answers 201");
      eq(added.data.draft.items.length, 1, "one item in the draft");
      eq(added.data.draft.items[0].from, 145000, "priced from the CATALOGUE, not from the request");

      // A hostile body cannot name its own price.
      await call("POST", `/wedding/${id}/store/draft/items`, { as: AS_BRIDE, body: { productId: String(product._id), from: 1, name: "Free mandap" } });
      const draft = await call("GET", `/wedding/${id}/store/draft`, { as: AS_BRIDE });
      eq(draft.data.items.length, 1, "adding the same product twice does not duplicate it");
      eq(draft.data.items[0].from, 145000, "and its price is still the catalogue's");
      eq(draft.data.items[0].name, mine.name, "as is its name");

      const sent = await call("POST", `/wedding/${id}/store/draft/send`, { as: AS_BRIDE, body: { name: "Our picks" } });
      eq(sent.status, 200, "POST …/store/draft/send answers");
      eq(sent.data.status, "sent", "the draft is sent");

      const request = await QuoteRequest.findById(sent.data.quoteRequestId).lean();
      ok(request, "a QuoteRequest exists — the SAME model the concierge path uses");
      eq(String(request.leadId), String(leadId), "with the lead resolved");
      eq(String(request.userId), String(bride._id), "and the couple's own account");
      eq(request.status, "pending", "sitting pending on the Store/CS queue");
      eq(request.itemCount, 1, "with the item count");
      eq(request.payload.source, "couple-app-store", "the payload says which door it came in by");
      eq(request.payload.items[0].productId, String(product._id), "and carries the couple's picks verbatim");
      eq(request.payload.events.length, 3, "plus the Event's three functions (§ 06.3 'Events')");

      const empty = await call("POST", `/wedding/${id}/store/draft/send`, { as: AS_BRIDE, body: {} });
      eq(empty.status, 200, "sending again raises a NEW request rather than editing the queued one");
      const all = await QuoteRequest.find({ userId: bride._id }).lean();
      eq(all.length, 2, "…so the team's queue has two, and neither was mutated behind them");

      const removed = await call("DELETE", `/wedding/${id}/store/draft/items/${product._id}`, { as: AS_BRIDE });
      eq(removed.status, 200, "DELETE …/store/draft/items/:itemId answers");
      eq(removed.data.draft.items.length, 0, "and the draft is empty again");
      eq(
        (await call("DELETE", `/wedding/${id}/store/draft/items/${product._id}`, { as: AS_BRIDE })).status,
        404,
        "removing it twice is a 404, not a silent success"
      );
    }

    /* ── § 3.5 · the makeup round ───────────────────────────────────────── */

    console.log("The makeup brief is the ROUND — one Bidding document, not a copy of one:");
    {
      const brief = await call("PUT", `/wedding/${id}/makeup/brief`, {
        as: AS_BRIDE,
        body: { date: "2026-12-14", functions: ["haldi", "wedding", "mehndi"], budgetLow: 55000, budgetHigh: 30000, people: 3, looks: "Bridal for the muhurtham" },
      });
      eq(brief.status, 200, "PUT /wedding/:id/makeup/brief answers");
      eq(brief.data.brief.functions.join(","), "haldi,wedding", "a function this wedding does not have is dropped");
      eq(brief.data.brief.budgetLow, 30000, "and the budget band is ordered");

      const stored = await Event.findById(event._id).lean();
      const round = await Bidding.findById(stored.coupleApp.makeup.bidding).lean();
      created.biddings.push(round._id);
      ok(round, "the round is a real Bidding document");
      eq(String(round.user), String(bride._id), "owned by the couple's own account");
      eq(round.requirements.category, "Makeup", "and categorised so the vendor app can find it");
      eq(round.events[0].looks, "Bridal for the muhurtham", "with the brief on it");

      eq(
        (await call("PUT", `/wedding/${id}/makeup/brief`, { as: AS_BRIDE, body: { looks: "anything" } })).status,
        422,
        "a brief with no budget is refused — an artist cannot bid against a blank"
      );
      eq(
        (await call("PUT", `/wedding/${id}/makeup/brief`, { as: AS_AUNTIE, body: { budgetLow: 1 } })).status,
        403,
        "and a viewer cannot post one"
      );
    }

    console.log("ACCEPTING A BID — one winner, three losers, one retainer:");
    {
      const stored = await Event.findById(event._id).lean();
      const roundId = stored.coupleApp.makeup.bidding;

      const vendors = await Vendor.create([
        { name: `${TAG} Aisha`, businessName: "Aisha Khan", phone: `${TAG}-1`, email: `${TAG}1@x.com`, gender: "female", category: "Makeup", rating: 5, profileVerified: true, profileVisibility: true, biddingStatus: true, prices: { bridal: 35000 } },
        { name: `${TAG} Nisha`, businessName: "Nisha Rao", phone: `${TAG}-2`, email: `${TAG}2@x.com`, gender: "female", category: "Makeup", rating: 5, profileVerified: true, profileVisibility: true, biddingStatus: true, prices: { bridal: 28000 } },
        { name: `${TAG} Tara`, businessName: "Tara Menon", phone: `${TAG}-3`, email: `${TAG}3@x.com`, gender: "female", category: "Makeup", rating: 4, profileVerified: true, profileVisibility: true, biddingStatus: true, prices: { bridal: 26000 } },
      ]);
      vendors.forEach((vendor) => created.vendors.push(vendor._id));
      const bids = await BiddingBid.create([
        { bidding: roundId, vendor: vendors[0]._id, bid: 42000, vendor_notes: "I would start at half past four." },
        { bidding: roundId, vendor: vendors[1]._id, bid: 34000, vendor_notes: "Natural glam." },
        { bidding: roundId, vendor: vendors[2]._id, bid: 28000, vendor_notes: "I am newer and price accordingly." },
      ]);

      const read = await call("GET", `/wedding/${id}/makeup`, { as: AS_BRIDE });
      eq(read.status, 200, "GET /wedding/:id/makeup answers");
      eq(read.data.bids.length, 3, "three comparable bids");
      eq(read.data.bids[0].amount, 42000, "with their prices");
      eq(read.data.bids[0].name, "Aisha Khan", "and the artists' business names");
      eq(read.data.trial, null, "no trial yet");

      const paymentsBefore = (await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE })).data.length;

      const accept = await call("POST", `/makeup-bids/${bids[0]._id}/accept`, { as: AS_BRIDE, body: { weddingId: id } });
      eq(accept.status, 200, "POST /makeup-bids/:id/accept answers");
      ok(accept.data.alreadyAccepted === false, "the first accept is not 'already'");
      eq(accept.data.rejected, 2, "and it marks BOTH losing bids");
      eq(accept.data.retainer.amount, 10500, "the retainer is 25% of the bid — the SAME schedule décor uses");

      const after = await BiddingBid.find({ bidding: roundId }).lean();
      eq(after.filter((row) => row.status.userAccepted).length, 1, "exactly one accepted bid");
      eq(after.filter((row) => row.status.userRejected).length, 2, "and exactly two rejected — nobody is left in silence");
      const closed = await Bidding.findById(roundId).lean();
      ok(closed.status.finalized, "the round is closed, so it stops taking bids on a booked wedding");

      const booking = await BiddingBooking.findOne({ user: bride._id }).lean();
      ok(booking, "a BiddingBooking holds the trial — the model that already means 'booked this vendor'");
      eq(booking.events[0].status, "requested", "requested, with no date: nobody has picked a time yet");

      const payments = (await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE })).data;
      eq(payments.length, paymentsBefore + 3, "the artist's schedule is THREE more rows on the SAME payment list");
      const retainer = payments.find((row) => row.amount === 10500);
      ok(retainer, "the retainer is one of them");
      eq(retainer.vendor, "Aisha Khan", "billed to the artist");

      const budget = await call("GET", `/wedding/${id}/budget`, { as: AS_BRIDE });
      eq(budget.data.committed, committed + 42000, "and the bid is committed to the budget alongside the décor");
      eq(budget.data.lines.length, 3, "as a third line");
      eq(budget.data.lines.filter((line) => line.source === "makeup").length, 1, "…marked makeup, not décor");

      const again = await call("POST", `/makeup-bids/${bids[0]._id}/accept`, { as: AS_BRIDE, body: { weddingId: id } });
      eq(again.status, 200, "accepting the same bid twice is a 200");
      ok(again.data.alreadyAccepted === true, "…and says it has already happened");
      eq(
        (await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE })).data.length,
        paymentsBefore + 3,
        "with no extra payment rows"
      );

      const other = await call("POST", `/makeup-bids/${bids[1]._id}/accept`, { as: AS_BRIDE, body: { weddingId: id } });
      eq(other.status, 409, "accepting a DIFFERENT bid afterwards is a 409");
      eq(other.data.error, "bid_already_accepted", "…named");

      eq(
        (await call("POST", `/makeup-bids/${bids[2]._id}/accept`, { as: AS_AUNTIE, body: { weddingId: id } })).status,
        403,
        "and a viewer cannot book anybody"
      );
    }

    console.log("The activity feed carries the decisions, and not the browsing:");
    {
      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id }).lean();
      const actions = logs.map((row) => row.action);
      ok(actions.includes("decor.finalised"), "the finalise is in the feed");
      ok(actions.includes("decor.tier_selected"), "so is the tier choice");
      ok(actions.includes("store.draft_sent"), "and the store draft going out");
      ok(actions.includes("makeup.bid_accepted"), "and the artist being booked");
      ok(actions.includes("venue.reaction"), "and the venue reaction");
      ok(actions.includes("budget.target_set"), "and the budget they committed to");
      ok(!actions.includes("decor.hearted"), "…but NOT every heart — four of those would crowd out the rest");
      eq(logs[0].actorId, null, "ActivityLog.actorId is an Admin ref, so a partner stays null");
      ok(logs.every((row) => row.meta.actorType === "couple"), "and rides in meta.actorType instead");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Payment.deleteMany({ "coupleApp.weddingId": { $in: created.events } }),
      Guest.deleteMany({ weddingId: { $in: created.events } }),
      SharedMember.deleteMany({ weddingId: { $in: created.events } }),
      ActivityLog.deleteMany({ entityType: "wedding", entityId: { $in: created.events.map(String) } }),
      VenueShortlist.deleteMany({ coupleName: "Ananya & Vikram" }),
      QuoteRequest.deleteMany({ userId: { $in: created.users } }),
      PlanSnapshot.deleteMany({ leadId: { $in: created.events } }),
      BiddingBid.deleteMany({ bidding: { $in: created.biddings } }),
      BiddingBooking.deleteMany({ user: { $in: created.users } }),
      Bidding.deleteMany({ _id: { $in: created.biddings } }),
      Vendor.deleteMany({ _id: { $in: created.vendors } }),
      Decor.deleteMany({ _id: { $in: created.decors } }),
      Category.deleteMany({ _id: { $in: created.categories } }),
      Venue.deleteMany({ _id: { $in: created.venues } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server) server.close();
    process.exit(fail ? 1 : 0);
  }
})();
