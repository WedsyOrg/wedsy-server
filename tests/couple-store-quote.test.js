// COUPLE APP — THE WEDDING STORE, AND THE ONE PIPELINE A SENT DRAFT ENTERS.
// Run: node tests/couple-store-quote.test.js
// PURE unit tests (NO DATABASE).
//
// § 06.3 "Store draft → Décor drafts": "A sent store draft becomes a quote
// request and returns as a priced draft in the same Décor flow as concierge
// picks. Both paths converge on one Finalise."
//
// So the assertions here are about SHAPE and about ABSENCE:
//   · the payload is a QuoteRequest payload — the couple's picks verbatim,
//     plus the ids the Store/CS queue needs to open the wedding;
//   · nothing in it prices anything, invents a status vocabulary, or names a
//     second kind of order;
//   · the functions on it are the EVENT's (§ 06.3 "Events: defined once"),
//     not a list retyped into the store.
//
// It also reads the source files and asserts that the store path calls
// QuoteRequestService.ingest and creates no QuoteRequest by hand — in the
// manner of tests/couple-tasks-union.test.js and tests/objectid-strict.test.js.
const fs = require("fs");
const path = require("path");
const rules = require("../services/CouplePlanningRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const EVENT = {
  _id: "6500000000000000000000a1",
  leadId: "6500000000000000000000f9",
  eventDays: [
    { _id: "d1", name: "Haldi", date: "2026-12-12", venue: "Taj West End" },
    { _id: "d3", name: "Wedding", date: "2026-12-14", venue: "Taj West End" },
  ],
};

const DRAFT = {
  name: "Our picks",
  status: "building",
  items: [
    { _id: "i1", productId: "st1", name: "Floral cascade mandap", cat: "mandap", from: 145000 },
    { _id: "i2", productId: "st5", name: "Petal-path entrance", cat: "entrance", from: 42000 },
  ],
};

console.log("A catalogue product is shaped from the REAL décor catalogue:");
{
  const product = rules.shapeStoreProduct({
    _id: "6500000000000000000000d1",
    name: "Floral cascade mandap",
    category: "Photo booth",
    description: "Fresh roses, orchids and soft drapes falling to the floor.",
    thumbnail: "/thumb.webp",
    image: "/full.webp",
    productTypes: [
      { name: "Natural", sellingPrice: 180000 },
      { name: "Artificial", sellingPrice: 145000 },
      { name: "Broken", sellingPrice: 0 },
    ],
    productVariation: { occassion: ["Wedding", "Reception", "Corporate"] },
  });
  eq(product.id, "6500000000000000000000d1", "the id is the catalogue document's");
  eq(product.cat, "photo-booth", "the category is slugged, so it matches the tab's own id");
  eq(product.from, 145000, "`from` is the CHEAPEST priced tier — a starting price, as § 6.3 says");
  eq(product.photo, "/thumb.webp", "the thumbnail is preferred over the full image");
  eq(product.suits.join(","), "wedding,reception", "`suits` keeps only real function keys — 'Corporate' is dropped");
  eq(rules.shapeStoreProduct({ productTypes: [] }).from, 0, "a product with no priced tier starts at 0, never at NaN");
  eq(rules.shapeStoreProduct(null).name, "", "and a missing product shapes to empty rather than throwing");
}

console.log("The draft is § 06.1's StoreDraft, and its ids are what the client removes with:");
{
  const shaped = rules.shapeStoreDraft(DRAFT, EVENT._id);
  eq(shaped.status, "building", "status is building | sent | quoted — the model's own three");
  eq(shaped.items.length, 2, "two items");
  eq(shaped.items[0].id, "st1", "`id` is the PRODUCT id, because that is what api.removeStoreItem sends");
  eq(shaped.items[0].itemId, "i1", "and the row's own id rides alongside for the § 06.2 reading of the path");
  eq(rules.shapeStoreDraft({}, EVENT._id).items.length, 0, "an empty draft is an empty list, not a null");
  eq(rules.shapeStoreDraft(null, EVENT._id).status, "building", "and a wedding that has never opened the store still has one");
}

console.log("SENDING IT → a QuoteRequest payload, and nothing else:");
{
  const now = new Date("2026-09-10T00:00:00Z");
  const payload = rules.quoteRequestPayload({ weddingId: EVENT._id, draft: DRAFT, event: EVENT, now });

  eq(payload.source, "couple-app-store", "the payload says which door it came in by");
  eq(payload.weddingId, String(EVENT._id), "and carries the wedding, so the queue can open it");
  eq(payload.leadId, String(EVENT.leadId), "and the CRM lead, which is how QuoteRequestService resolves the owner");
  eq(payload.items.length, 2, "the couple's picks, verbatim");
  eq(payload.items[0].productId, "st1", "each one by its catalogue id");
  eq(payload.items[0].startingPrice, 145000, "with the STARTING price the couple was shown");
  eq(payload.draftName, "Our picks", "and the name they gave it");

  const text = JSON.stringify(payload).toLowerCase();
  ok(!text.includes("\"total\""), "NOTHING in the payload is a total — the team prices it, not this server");
  ok(!text.includes("quotedprice"), "nor a quoted price");
  ok(!text.includes("\"order\""), "and it is not an order — there is no store-order concept to open");
}

console.log("THE FUNCTIONS ON IT ARE THE EVENT'S (§ 06.3 'Events: defined once'):");
{
  const payload = rules.quoteRequestPayload({ weddingId: EVENT._id, draft: DRAFT, event: EVENT });
  eq(payload.events.length, 2, "both of the wedding's days");
  eq(payload.events[0].name, "Haldi", "by the name the Event holds");
  eq(payload.events[0].date, "2026-12-12", "with the Event's date");
  eq(payload.events[1].venue, "Taj West End", "and the Event's venue — none of it retyped into the store");
  eq(
    rules.quoteRequestPayload({ weddingId: EVENT._id, draft: DRAFT, event: { _id: "x" } }).events.length,
    0,
    "a wedding with no functions sends none, rather than inventing four"
  );
}

console.log("Hostile bodies reach nothing:");
{
  const payload = rules.quoteRequestPayload({
    weddingId: EVENT._id,
    event: EVENT,
    draft: { ...DRAFT, name: "x".repeat(500), items: [{ productId: "st1", name: "Mandap", cat: "mandap", from: -99 }] },
  });
  eq(payload.draftName.length, 200, "a 500-character draft name is capped at 200");
  eq(payload.items[0].startingPrice, 0, "a negative price becomes 0, never a credit");
}

console.log("What `POST …/draft/items` accepts:");
{
  eq(rules.storeItemFrom({ productId: "st1" }), "st1", "a product id");
  eq(rules.storeItemFrom({ id: "st1" }), "st1", "or the client's own `id` key");
  let threw = null;
  try { rules.storeItemFrom({}); } catch (error) { threw = error; }
  ok(threw && threw.status === 422, "and nothing at all is a 422");
  ok(threw && threw.extra && threw.extra.fields.productId, "which names the field");
}

console.log("SOURCE-LEVEL: the send path uses the ONE pipeline (§ 06.3):");
{
  const store = read("services/CoupleStoreService.js");
  ok(store.includes("QuoteRequestService.ingest("), "CoupleStoreService calls QuoteRequestService.ingest");
  ok(
    !/QuoteRequest\.create\(|new QuoteRequest\(/.test(store),
    "and NEVER creates a QuoteRequest by hand — the one door raises the notification, the lane entry and the activity echo"
  );
  ok(
    !/require\(["'][^"']*models\/QuoteRequest/.test(store),
    "it does not even import the model — there is nothing here to write a second kind of row with"
  );
  ok(
    store.includes("§ 06.3") && store.includes("CONVERGENCE"),
    "and the call site carries the marked comment naming § 06.3"
  );

  const decor = read("services/CoupleDecorService.js");
  ok(
    decor.includes("finaliseService.plan(") && !/const\s+defaultSchedule|0\.25|0\.5/.test(decor),
    "and the finalise both paths converge on holds no schedule of its own"
  );
}

console.log("SOURCE-LEVEL: the store never prices anything:");
{
  const store = read("services/CoupleStoreService.js");
  ok(!/sellingPrice|costPrice|discount/.test(store), "no price field is read or written in the store service");
  ok(!/\*\s*quantity|\* qty/.test(store), "and nothing is multiplied out into a total");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
