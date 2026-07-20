// P0 — SHARED PRICE UTIL test. Run: node tests/event-decor-pricing.test.js
// PURE unit tests (no DB): pathway quantity multiplier, platform/flooring
// legs, variant price modifiers, negative (discount) add-ons, zero-dim
// flooring, NaN guards, the ES/TS split, and the FILTERED grand total the
// legacy summary got wrong.
const { lineTotal, dayTotal, eventTotals } = require("../utils/eventDecorPricing");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

// ── lineTotal ──
eq(lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage" }), 1000, "bare item = decorPrice");
eq(lineTotal({ quantity: 2, decorPrice: 1000, category: "Stage" }), 2000, "quantity multiplies the base");
eq(lineTotal({ quantity: 1, decorPrice: 1000, priceModifier: 250, category: "Stage" }), 1250, "variant modifier adds");
eq(lineTotal({ quantity: 1, decorPrice: 1000, priceModifier: -300, category: "Stage" }), 700, "negative modifier (cheaper tier) subtracts");

// platform leg: L×B×rate
eq(
  lineTotal({ quantity: 1, decorPrice: 0, category: "Stage", platform: true, platformRate: 50, dimensions: { length: 10, breadth: 4, height: 2 } }),
  10 * 4 * 50,
  "platform = L×B×platformRate"
);
eq(
  lineTotal({ quantity: 1, decorPrice: 0, category: "Stage", platform: false, platformRate: 50, dimensions: { length: 10, breadth: 4 } }),
  0,
  "no platform → no platform leg even with a rate snapshotted"
);

// flooring leg: (L+H)×(B+H)×rate
eq(
  lineTotal({ quantity: 1, decorPrice: 0, category: "Stage", flooringRate: 6, dimensions: { length: 10, breadth: 4, height: 2 } }),
  (10 + 2) * (4 + 2) * 6,
  "flooring = (L+H)×(B+H)×flooringRate"
);
eq(
  lineTotal({ quantity: 1, decorPrice: 500, category: "Stage", flooringRate: 6, dimensions: { length: 0, breadth: 0, height: 0 } }),
  500,
  "zero-dim flooring contributes nothing"
);

// pathway multiplier hits BOTH legs
eq(
  lineTotal({
    quantity: 3, decorPrice: 1000, category: "Pathway", platform: true, platformRate: 50,
    flooringRate: 6, dimensions: { length: 2, breadth: 2, height: 0 },
  }),
  3 * 1000 + 2 * 2 * 50 * 3 + (2 + 0) * (2 + 0) * 6 * 3,
  "Pathway: qty multiplies base AND platform AND flooring legs"
);
eq(
  lineTotal({
    quantity: 3, decorPrice: 1000, category: "Stage", platform: true, platformRate: 50,
    dimensions: { length: 2, breadth: 2 },
  }),
  3 * 1000 + 2 * 2 * 50,
  "non-Pathway: qty multiplies ONLY the base"
);

// add-ons, incl. negative (discount) rows
eq(
  lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage", addOns: [{ price: 300 }, { price: -150 }] }),
  1150,
  "add-ons sum; negatives (discount add-ons) subtract"
);

// NaN guards
eq(lineTotal({ quantity: "2", decorPrice: "1000", category: "Stage" }), 2000, "numeric strings coerce");
eq(lineTotal({ quantity: undefined, decorPrice: 1000, category: "Stage" }), 0, "missing quantity → 0 (guarded, not NaN)");
eq(lineTotal({ quantity: 1, decorPrice: "abc", priceModifier: null, category: "Stage", addOns: [{ price: "x" }] }), 0, "garbage operands → 0, never NaN");
ok(Number.isFinite(lineTotal({})), "empty item is finite");

// ── dayTotal: the ES/TS filter ──
const day = {
  decorItems: [{ price: 1000 }, { price: 500 }],
  packages: [{ price: 2000 }],
  customItems: [
    { name: "DJ", price: 800, includeInTotalSummary: false },
    { name: "Transport", price: 999, includeInTotalSummary: true }, // event-level
  ],
  mandatoryItems: [
    { title: "Genset", price: 400, itemRequired: true, includeInTotalSummary: false },
    { title: "Genset XL", price: 777, itemRequired: true, includeInTotalSummary: true }, // event-level
    { title: "Offer only", price: 555, itemRequired: false, includeInTotalSummary: false }, // not taken → excluded
  ],
};
const dt = dayTotal(day);
eq(dt.decorItems, 1500, "day decor sum");
eq(dt.packages, 2000, "day package sum");
eq(dt.customItems, 800, "day custom EXCLUDES includeInTotalSummary rows");
eq(dt.mandatoryItems, 400, "day mandatory = itemRequired && !ES/TS only");
eq(dt.total, 1500 + 2000 + 800 + 400, "day total is the filtered sum");

// ── eventTotals: itemization + the filtered grand (the legacy-bug case) ──
const event = { eventDays: [{ _id: "d1", name: "Sangeet", date: "2026-11-20", ...day }] };
const et = eventTotals(event);
eq(et.days.length, 1, "one day row");
eq(et.days[0].total, 4700, "day row rides dayTotal");
eq(et.eventLevelItems.length, 2, "ES/TS items itemized at event level");
ok(et.eventLevelItems.some((i) => i.kind === "custom" && i.name === "Transport" && i.price === 999), "custom ES/TS row present");
ok(et.eventLevelItems.some((i) => i.kind === "mandatory" && i.name === "Genset XL" && i.price === 777), "required mandatory ES/TS row present");
ok(!et.eventLevelItems.some((i) => i.name === "Offer only"), "un-required mandatory NEVER appears anywhere");
eq(et.eventLevelTotal, 999 + 777, "event-level total");
eq(et.grandTotal, 4700 + 999 + 777, "grand = filtered days + event-level");
// The legacy (buggy) unfiltered sum would have been:
const legacy = 1500 + 2000 + (800 + 999) + (400 + 777 + 555);
ok(et.grandTotal !== legacy, `the filtered grand differs from the legacy unfiltered sum (${et.grandTotal} vs legacy ${legacy})`);

eq(eventTotals({}).grandTotal, 0, "empty event → 0, no crash");

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
