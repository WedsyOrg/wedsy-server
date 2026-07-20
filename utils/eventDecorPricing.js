// P0 — THE SHARED PRICE UTIL. The single pricing truth for event decor items.
// (Named eventDecorPricing — utils/eventPricing.js was already taken by the
// vendor-bidding payload normalizer, unrelated.)
// PURE functions over stored docs — no queries, no config reads: every rate
// (platformRate / flooringRate / decorPrice / priceModifier) is the item's
// SNAPSHOT taken at write time, never live config, so old items never reprice
// themselves.
//
//   lineTotal(item) = qty × (decorPrice + priceModifier)
//                   + (platform ? L×B×platformRate : 0) × pathwayMult
//                   + (L+H)×(B+H)×flooringRate × pathwayMult
//                   + Σ addOns[].price          (negatives allowed — discounts)
//     pathwayMult = category === "Pathway" ? quantity : 1
//
//   dayTotal(day)  = Σ decorItems.price + Σ packages.price
//                  + Σ customItems.price     where !includeInTotalSummary
//                  + Σ mandatoryItems.price  where itemRequired && !includeInTotalSummary
//
//   eventTotals(event) = per-day rows + the ES/TS items (includeInTotalSummary)
//     itemized at EVENT level + the grand total. This is the FILTERED
//     definition — the legacy summary added every custom/mandatory price
//     regardless of itemRequired/includeInTotalSummary (the known bug; not
//     ported).
//
// Every operand is NaN-guarded: missing / non-numeric → 0.

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const lineTotal = (item = {}) => {
  const qty = n(item.quantity);
  const dims = item.dimensions || {};
  const L = n(dims.length);
  const B = n(dims.breadth);
  const H = n(dims.height);
  const pathwayMult = item.category === "Pathway" ? qty : 1;

  const base = qty * (n(item.decorPrice) + n(item.priceModifier));
  const platformLeg = (item.platform ? L * B * n(item.platformRate) : 0) * pathwayMult;
  const flooringLeg = (L + H) * (B + H) * n(item.flooringRate) * pathwayMult;
  const addOnsLeg = (Array.isArray(item.addOns) ? item.addOns : []).reduce((s, a) => s + n(a && a.price), 0);

  return Math.round(base + platformLeg + flooringLeg + addOnsLeg);
};

// A day's own total — ES/TS items (includeInTotalSummary) deliberately NOT
// here; they itemize at event level via eventTotals.
const dayTotal = (day = {}) => {
  const decor = (day.decorItems || []).reduce((s, i) => s + n(i && i.price), 0);
  const packages = (day.packages || []).reduce((s, p) => s + n(p && p.price), 0);
  const custom = (day.customItems || []).reduce(
    (s, c) => s + (c && !c.includeInTotalSummary ? n(c.price) : 0),
    0
  );
  const mandatory = (day.mandatoryItems || []).reduce(
    (s, mi) => s + (mi && mi.itemRequired && !mi.includeInTotalSummary ? n(mi.price) : 0),
    0
  );
  return {
    decorItems: Math.round(decor),
    packages: Math.round(packages),
    customItems: Math.round(custom),
    mandatoryItems: Math.round(mandatory),
    total: Math.round(decor + packages + custom + mandatory),
  };
};

// The whole event: per-day rows, event-level (ES/TS) items itemized, grand.
// Event-level membership: customItems with includeInTotalSummary; mandatory
// items with itemRequired && includeInTotalSummary (an un-required mandatory
// item is an OFFER, priced nowhere until taken).
const eventTotals = (event = {}) => {
  const days = (event.eventDays || []).map((d) => ({
    dayId: d && d._id ? String(d._id) : "",
    name: (d && d.name) || "",
    date: (d && d.date) || "",
    ...dayTotal(d),
  }));

  const eventLevelItems = [];
  for (const d of event.eventDays || []) {
    const dayId = d && d._id ? String(d._id) : "";
    for (const c of (d && d.customItems) || []) {
      if (c && c.includeInTotalSummary) {
        eventLevelItems.push({ dayId, kind: "custom", name: c.name || "", price: Math.round(n(c.price)) });
      }
    }
    for (const mi of (d && d.mandatoryItems) || []) {
      if (mi && mi.itemRequired && mi.includeInTotalSummary) {
        eventLevelItems.push({ dayId, kind: "mandatory", name: mi.title || "", price: Math.round(n(mi.price)) });
      }
    }
  }

  const daysTotal = days.reduce((s, d) => s + d.total, 0);
  const eventLevelTotal = eventLevelItems.reduce((s, i) => s + i.price, 0);

  return {
    days,
    eventLevelItems,
    eventLevelTotal: Math.round(eventLevelTotal),
    grandTotal: Math.round(daysTotal + eventLevelTotal),
  };
};

module.exports = { lineTotal, dayTotal, eventTotals };
