/**
 * COUPLE APP § 06.3 / § 07.1 M4 — REGISTRY → WALLET → PAYMENTS, AGAINST A REAL
 * DATABASE AND OVER REAL HTTP.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container and
 * none on the machine this milestone was built on — so treat it as unverified
 * until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-registry-money.int.test.js
 *
 * ⚠ THE TRANSACTION ASSERTIONS NEED A REPLICA SET. Against a standalone mongod
 * the endpoints take the ordered fallback and the `atomic: true` assertions
 * below will fail — correctly, because the property they name is genuinely not
 * available there. Run it against a dev Atlas cluster (or a local one-node
 * replica set) if you want them green.
 *
 * ── WHAT IT PROVES THAT THE PURE TESTS CANNOT ──────────────────────────────
 *
 *   1. § 07.1's DEFINITION OF DONE for this milestone: a guest contributes on
 *      the public route and the money is the offset on the couple's very next
 *      payment, WITH NO MANUAL STEP. That is one test, and it is the one that
 *      matters most.
 *   2. That the Contribution and its WalletTxn credit really are one write —
 *      asserted by reading both collections back and by the `atomic: true` the
 *      endpoint reports.
 *   3. THE RACE, AS MONGODB EXECUTES IT. Two "pay in full" requests fired
 *      CONCURRENTLY at the same gift: exactly one 200 and exactly one 409, one
 *      Contribution, one credit, and `funded` equal to the price — never twice
 *      it. A pure test can only assert the decision; this asserts the
 *      conditional update.
 *   4. That the offset CANNOT be client-supplied over the wire: a POST carrying
 *      `walletApplied: 999999` moves exactly what the server computed.
 *   5. That a guest's phone number is absent from the RAW HTTP TEXT of the
 *      public registry, not merely from its parsed JSON.
 *   6. That RequirePayout refuses a real SharedMember with payments at "edit",
 *      over HTTP, with a real token.
 *
 * The rate limiters are NOT exercised: their window is an hour, and a test that
 * either waits or reaches into the limiter's private store proves something
 * about the test rather than about the endpoint.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const Website = require("../models/Website");
const RegistryItem = require("../models/RegistryItem");
const RegistryFund = require("../models/RegistryFund");
const Contribution = require("../models/Contribution");
const WalletTxn = require("../models/WalletTxn");
const Payment = require("../models/Payment");
const SharedMember = require("../models/SharedMember");
const ActivityLog = require("../models/ActivityLog");

const TAG = `couplemoney-${Date.now()}`;
const SLUG = `${TAG}-ananya-vikram`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [] };

const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
app.use("/", require("../routes/coupleApp-money").itemRoutes);
app.use("/", require("../routes/coupleApp-people").itemRoutes);
app.use("/", require("../routes/coupleApp-website").itemRoutes);

let base = "";
const token = (id) => jwt.sign({ _id: String(id) }, process.env.JWT_SECRET);

/** Returns the RAW TEXT as well as the parsed body — the withholding is asserted on both. */
const call = async (method, path, { as, body, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: res.status, data, text, headers: res.headers };
};

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await Promise.all([Website.syncIndexes(), Payment.syncIndexes()]);

    server = http.createServer(app).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const auntie = await User.create({ name: `${TAG}-auntie`, phone: `${TAG}-a` });
    created.users.push(bride._id, auntie._id);

    const event = await Event.create({
      user: bride._id, name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Vikram", eventDate: "2026-12-11",
      eventDays: [{ name: "Wedding", date: "2026-12-11", time: "07:40", venue: "The Tamarind Tree" }],
      coupleApp: {
        city: "Bengaluru",
        partners: [{ user: bride._id, name: "Ananya Sharma", role: "bride" }, { name: "Vikram Reddy", role: "groom" }],
      },
    });
    created.events.push(event._id);
    const id = String(event._id);
    const AS_BRIDE = token(bride._id);
    const AS_AUNTIE = token(auntie._id);

    // A shared member with EVERY section at edit. She may do everything on the
    // registry and on payments, and may not move a rupee.
    await SharedMember.create({
      weddingId: event._id, user: auntie._id, name: "Sunita", relation: "Bride's mother",
      acceptedAt: new Date(), revokedAt: null,
      access: { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit" },
    });

    // The wedding needs a public address for the registry link to resolve on.
    await Website.create({ weddingId: event._id, slug: SLUG, paletteId: "p3", fontId: "f2" });

    /* ───────────────────────────────────────────────── the couple's registry */

    console.log("The couple builds a registry:");
    let itemId = "";
    let fundId = "";
    {
      const empty = await call("GET", `/wedding/${id}/registry`, { as: AS_BRIDE });
      eq(empty.status, 200, "GET /wedding/:id/registry answers");
      eq(empty.data.items.length, 0, "with nothing on it yet");
      eq(empty.data.intro, "", "and no note");

      const item = await call("POST", `/wedding/${id}/registry/items`, {
        as: AS_BRIDE,
        body: { title: "Copper cookware", price: 24000, image: "https://shop.example.com/c.jpg", sourceUrl: "https://shop.example.com/c", source: "shop.example.com", pinned: true },
      });
      eq(item.status, 201, "POST .../registry/items creates");
      ok(Boolean(item.data.id), "and answers with an `id`, which is what api.addRegistryItem reads");
      eq(item.data.funded, 0, "nothing given yet");
      eq(item.data.remaining, 24000, "and the whole price left");
      itemId = item.data.id;

      const fund = await call("POST", `/wedding/${id}/registry/funds`, { as: AS_BRIDE, body: { title: "Kyoto honeymoon", target: 80000 } });
      eq(fund.status, 201, "POST .../registry/funds creates");
      fundId = fund.data.id;

      const note = await call("PATCH", `/wedding/${id}/registry`, { as: AS_BRIDE, body: { intro: "Your being there is the gift." } });
      eq(note.status, 200, "PATCH /wedding/:id/registry saves the note");
      eq(note.data.intro, "Your being there is the gift.", "and gives it back");

      const patched = await call("PATCH", `/registry-items/${itemId}`, { as: AS_BRIDE, body: { price: 26000 } });
      eq(patched.status, 200, "PATCH /registry-items/:id at the CLIENT'S OWN ROOT PATH");
      eq(patched.data.price, 26000, "and the price moves");
      eq(patched.data.funded, 0, "while `funded` does not — a rename can never reset the money");
    }

    console.log("A second wedding's gift cannot be touched from this one:");
    {
      const other = await Event.create({ user: auntie._id, name: `${TAG} other`, brideName: "B", groomName: "C", eventDate: "2027-01-01" });
      created.events.push(other._id);
      const theirs = await RegistryItem.create({ weddingId: other._id, title: "Not yours", price: 100 });
      const res = await call("PATCH", `/registry-items/${theirs._id}`, { as: AS_BRIDE, body: { price: 1 } });
      eq(res.status, 403, "the bride is refused on the OTHER wedding, not on the row");
      eq((await RegistryItem.findById(theirs._id)).price, 100, "and nothing changed");
    }

    /* ─────────────────────────────────────────────────── the public registry */

    console.log("The public registry, and what it withholds:");
    {
      const res = await call("GET", `/registry/${SLUG}`);
      eq(res.status, 200, "GET /registry/:slug answers with no token at all");
      eq(res.data.slug, SLUG, "with the slug");
      eq(res.data.paletteId, "p3", "and the couple's palette");
      eq(res.data.items.length, 1, "the gift is there");
      eq(res.data.funds.length, 1, "and the fund");
      eq(res.data.intro, "Your being there is the gift.", "and the note");
      ok(res.headers.get("x-robots-tag") !== null, "a link-only registry carries X-Robots-Tag");

      eq((await call("GET", `/registry/${TAG}-nobody`)).status, 404, "an unknown slug is a real 404");

      // The registry resolves even though the website was never published —
      // § 05.1, "works on its own — no website needed".
      eq((await Website.findOne({ slug: SLUG })).publishedAt, null, "this website has never been published");
      eq(res.data.items[0].title, "Copper cookware", "and its registry serves anyway");
    }

    /* ──────────────────────────── § 07.1 M4 — the chain, with no manual step */

    console.log("§ 07.1 M4 — a guest's gift becomes the next payment's offset:");
    let contributionId = "";
    {
      const gift = await call("POST", `/registry/${SLUG}/contribute`, {
        body: { itemId, amount: 999, mode: "part", guest: { name: "Meera Iyer", phone: "+91 98450 11223", note: "So happy for you both" } },
      });
      eq(gift.status, 200, "a guest chips in on the public route");
      eq(gift.data.ok, true, "and it is accepted");
      eq(gift.data.amount, 999, "for what they typed");
      eq(gift.data.walletCredited, 999, "and the server confirms the wallet was credited");
      eq(gift.data.atomic, true, "IN ONE TRANSACTION (needs a replica set — see the header)");
      contributionId = gift.data.contributionId;

      // Both documents exist, and they point at each other.
      const con = await Contribution.findById(contributionId).lean();
      eq(con.status, "settled", "the Contribution is settled");
      ok(Boolean(con.walletTxn), "and carries its credit's id — a null here is money the couple cannot see");
      const credit = await WalletTxn.findById(con.walletTxn).lean();
      eq(credit.type, "credit", "the credit is a credit");
      eq(credit.amount, 999, "for the same rupees");
      eq(String(credit.contribution), contributionId, "and points back at the gift");

      eq((await RegistryItem.findById(itemId)).funded, 999, "the gift's running total moved in the same act");

      // NO MANUAL STEP between here and the offset.
      const w = await call("GET", `/wedding/${id}/wallet`, { as: AS_BRIDE });
      eq(w.status, 200, "the couple opens their wallet");
      eq(w.data.balance, 999, "and the gift is in it");
      eq(w.data.spendable, 999, "all of it spendable");
      eq(w.data.transactions.length, 1, "as one readable line");
      ok(String(w.data.transactions[0].label).indexOf("Meera") !== -1, "labelled with who gave it (WalletTxn.label — a contract addition)");
    }

    console.log("...and the Pay modal offers exactly that, computed by the server:");
    let paymentId = "";
    {
      const payment = await Payment.create({
        user: bride._id, amount: 150000, amountPaid: 0, amountDue: 150000, paymentFor: "event", event: event._id, status: "created",
        coupleApp: { weddingId: event._id, label: "Venue hold — The Tamarind Tree", vendor: "The Tamarind Tree", ref: "WD-2026-0518", dueDate: new Date("2026-09-20"), sourceKey: `${TAG}-venue` },
      });
      paymentId = String(payment._id);

      const list = await call("GET", `/wedding/${id}/payments`, { as: AS_BRIDE });
      eq(list.status, 200, "GET /wedding/:id/payments answers");
      ok(Array.isArray(list.data), "with a BARE ARRAY, as api.payments() reads it");
      eq(list.data[0].label, "Venue hold — The Tamarind Tree", "carrying the couple's own label");
      eq(list.data[0].status, "due", "and the couple-facing status");

      // THE OFFSET CANNOT BE CLIENT-SUPPLIED. This body tries.
      const paid = await call("POST", `/payments/${paymentId}/pay`, {
        as: AS_BRIDE,
        body: { method: "upi", useWallet: true, walletApplied: 999999, amount: 1, gatewayAmount: 0 },
      });
      eq(paid.status, 200, "the pay call is accepted");
      eq(paid.data.walletApplied, 999, "AND THE OFFSET IS THE SERVER'S 999, not the client's 999999");
      eq(paid.data.gatewayAmount, 149001, "the gateway is asked for the rest");
      eq(paid.data.fullyCovered, false, "the row is not covered");
      ok(paid.data.intent !== null, "so a gateway intent comes back");
      eq(paid.data.intent.provider, "razorpay", "naming the provider");
      eq(paid.data.intent.amount, 149001, "for the remainder only");

      eq((await Payment.findById(paymentId)).coupleApp.walletApplied, 999, "and the row records what the wallet covered");
      const reserved = await WalletTxn.findOne({ payment: paymentId }).lean();
      eq(reserved.type, "debit", "a debit was written");
      eq(reserved.status, "pending", "PENDING — reserved while the gateway is asked, not spent");
      const after = await call("GET", `/wedding/${id}/wallet`, { as: AS_BRIDE });
      eq(after.data.balance, 999, "the balance still shows the money");
      eq(after.data.spendable, 0, "but none of it is spendable twice");
    }

    console.log("A payment the WALLET COVERS OUTRIGHT is settled here, with no gateway:");
    {
      await call("POST", `/registry/${SLUG}/contribute`, {
        body: { fundId, amount: 5000, mode: "part", guest: { name: "Rohan Das", phone: "+919900112233" } },
      });
      const small = await Payment.create({
        user: bride._id, amount: 3000, amountPaid: 0, amountDue: 3000, paymentFor: "event", event: event._id, status: "created",
        coupleApp: { weddingId: event._id, label: "Trial booking", vendor: "Aisha", dueDate: new Date("2026-10-01"), sourceKey: `${TAG}-trial` },
      });
      const res = await call("POST", `/payments/${small._id}/pay`, { as: AS_BRIDE, body: { method: "upi", useWallet: true } });
      eq(res.data.fullyCovered, true, "the wallet covers it");
      eq(res.data.walletApplied, 3000, "for exactly the bill");
      eq(res.data.gatewayAmount, 0, "with nothing for the gateway");
      eq(res.data.intent, null, "AND NO INTENT AT ALL — the gateway is not involved");
      eq((await Payment.findById(small._id)).status, "paid", "the payment is settled");
      const debit = await WalletTxn.findOne({ payment: small._id }).lean();
      eq(debit.status, "settled", "and the debit is settled, not reserved");
    }

    /* ───────────────────────────────────────────────────────────── the race */

    console.log("THE RACE — two guests take the same gift in full, at the same moment:");
    {
      const lamp = await RegistryItem.create({ weddingId: event._id, title: "Brass lamp", price: 12000, funded: 0 });
      const body = (name) => ({ itemId: String(lamp._id), amount: 12000, mode: "full", guest: { name } });
      const [a, b] = await Promise.all([
        call("POST", `/registry/${SLUG}/contribute`, { body: body("First Guest") }),
        call("POST", `/registry/${SLUG}/contribute`, { body: body("Second Guest") }),
      ]);
      const statuses = [a.status, b.status].sort().join(",");
      eq(statuses, "200,409", "EXACTLY ONE succeeds and exactly one is told they were beaten");
      const loser = a.status === 409 ? a : b;
      eq(loser.data.error, "already_funded", "with the code the client renders");
      eq(loser.data.price, 12000, "and the numbers to say why");

      eq((await RegistryItem.findById(lamp._id)).funded, 12000, "the gift is funded ONCE, not twice");
      eq(await Contribution.countDocuments({ item: lamp._id }), 1, "one Contribution");
      eq(await WalletTxn.countDocuments({ weddingId: event._id, type: "credit", amount: 12000 }), 1, "one credit");
    }

    console.log("An over-generous chip-in is refused with what is left:");
    {
      const remaining = await call("POST", `/registry/${SLUG}/contribute`, {
        body: { itemId, amount: 99000, mode: "part", guest: { name: "Too Generous" } },
      });
      eq(remaining.status, 422, "422, not a silent over-fund");
      ok(String(remaining.data.fields.amount).indexOf("25,001") !== -1, "and it names what is actually left");
    }

    /* ───────────────────────────────────────────────────── privacy over HTTP */

    console.log("No guest's phone number reaches another guest — asserted on the RAW TEXT:");
    {
      const res = await call("GET", `/registry/${SLUG}`);
      ok(res.text.indexOf("9845011223") === -1, "the number is not in the response text, in any encoding");
      ok(res.text.indexOf("Meera") === -1, "nor the name");
      ok(res.text.indexOf("So happy for you both") === -1, "nor the private note");
      ok(res.text.indexOf("thanked") === -1, "nor whether they have been thanked");
      eq(res.data.items[0].funded, 999, "and yet the progress bar still has its number");

      const couple = await call("GET", `/wedding/${id}/registry`, { as: AS_BRIDE });
      ok(couple.text.indexOf("Meera Iyer") !== -1, "while the COUPLE's own read does carry the giver");
      eq(couple.data.pending, 3, "with a thank-you count");
    }

    console.log("Thanking a person, not a line item:");
    {
      const res = await call("PATCH", `/contributions/${contributionId}`, { as: AS_BRIDE, body: { thanked: true } });
      eq(res.status, 200, "PATCH /contributions/:id");
      eq(res.data.thanked, true, "marks them thanked");
      ok(Boolean((await Contribution.findById(contributionId)).thankedAt), "and stamps when");
    }

    /* ─────────────────────────────────────────────────────────── the payouts */

    console.log("§ 06.4 — a member with payments at EDIT may look, and may not move money:");
    {
      eq((await call("GET", `/wedding/${id}/payments`, { as: AS_AUNTIE })).status, 200, "she reads the payments");
      eq((await call("GET", `/wedding/${id}/registry`, { as: AS_AUNTIE })).status, 200, "and the registry");
      eq((await call("GET", `/wedding/${id}/wallet`, { as: AS_AUNTIE })).status, 200, "and the wallet, holding both sections");
      eq((await call("POST", `/wedding/${id}/registry/items`, { as: AS_AUNTIE, body: { title: "A gift", price: 100 } })).status, 201, "and may add a gift");

      const claim = await call("POST", `/wedding/${id}/wallet/claim`, { as: AS_AUNTIE, body: { amount: 100 } });
      eq(claim.status, 403, "SHE MAY NOT CLAIM");
      eq(claim.data.error, "forbidden_payout", "with the payout's own code");
      const pay = await call("POST", `/payments/${paymentId}/pay`, { as: AS_AUNTIE, body: { method: "upi", useWallet: true } });
      eq(pay.status, 403, "AND SHE MAY NOT PAY");
      eq(pay.data.error, "forbidden_payout", "with the payout's own code");
    }

    console.log("The couple claims to their bank:");
    {
      const before = await call("GET", `/wedding/${id}/wallet`, { as: AS_BRIDE });
      const spendable = before.data.spendable;
      const tooMuch = await call("POST", `/wedding/${id}/wallet/claim`, { as: AS_BRIDE, body: { amount: spendable + 1 } });
      eq(tooMuch.status, 422, "more than is there is a 422");

      const res = await call("POST", `/wedding/${id}/wallet/claim`, { as: AS_BRIDE, body: { amount: spendable } });
      eq(res.status, 200, "and the rest is accepted");
      eq(res.data.claim.status, "pending", "sitting pending for 2–3 working days");
      eq(res.data.wallet.spendable, 0, "with nothing left to claim twice");
      eq((await call("POST", `/wedding/${id}/wallet/claim`, { as: AS_BRIDE })).status, 422, "and a second claim is refused while the first is in flight");
    }

    console.log("A gift money has arrived against is archived, never deleted:");
    {
      const res = await call("DELETE", `/registry-items/${itemId}`, { as: AS_BRIDE });
      eq(res.status, 200, "DELETE /registry-items/:id");
      eq(res.data.archived, true, "archives it");
      eq(res.data.removed, false, "rather than removing it");
      ok(Boolean((await RegistryItem.findById(itemId)).archivedAt), "the row survives, so Meera's thank-you still has a gift");
      eq(await Contribution.countDocuments({ item: itemId }), 1, "and her contribution still points at something");
    }

    console.log("An activity row for every gift that arrived:");
    {
      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id, action: "registry.gift_received" }).lean();
      ok(logs.length >= 3, "the guests' gifts are in the feed");
      eq(logs[0].actorId, null, "with a null actorId — ActivityLog.actorId is an Admin ref and a guest is not one");
      eq(logs[0].meta.actorType, "guest", "the guest rides in meta.actorType");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Contribution.deleteMany({ weddingId: { $in: created.events } }),
      WalletTxn.deleteMany({ weddingId: { $in: created.events } }),
      RegistryItem.deleteMany({ weddingId: { $in: created.events } }),
      RegistryFund.deleteMany({ weddingId: { $in: created.events } }),
      Payment.deleteMany({ "coupleApp.weddingId": { $in: created.events } }),
      SharedMember.deleteMany({ weddingId: { $in: created.events } }),
      Website.deleteMany({ weddingId: { $in: created.events } }),
      ActivityLog.deleteMany({ entityType: "wedding", entityId: { $in: created.events.map(String) } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server) server.close();
    process.exit(fail ? 1 : 0);
  }
})();
