/**
 * utils/venuePricingIntel.js — turning "quote strong" into a number.
 *
 * The calendar note can already say a date is a major muhurat on a contested
 * Saturday. What it cannot say is what that is WORTH, and "price accordingly"
 * is not advice — it is the shape of advice. This composes the three things
 * the product already knows into one line that names a figure.
 *
 *   1. COMPARABLES — what this venue actually got for similar dates. Confirmed
 *      bookings, matched on the signals that move price: auspicious, weekend,
 *      block length. Real money, already banked, at this venue.
 *   2. THE COMPETING TABLE — what other live enquiries for this date have been
 *      quoted. Scoped exactly like utils/venueContention: the AGGREGATE is
 *      venue-wide because that is the whole value, while names and per-lead
 *      figures never leave the requester's scope.
 *   3. THE DATE'S OWN SIGNALS — reused from utils/weddingCalendar and
 *      utils/venueContention, never recomputed here.
 *
 * ── HONESTY ABOUT SAMPLE SIZE ───────────────────────────────────────────────
 * A range invented from one booking is worse than no range, because an owner
 * will quote against it. The count is always stated, and below MIN_COMPARABLES
 * the advice says plainly that there is not enough history rather than
 * producing a confident-sounding number. Venues that opened last month are the
 * common case, not the edge case.
 *
 * ── NO AI CALL ──────────────────────────────────────────────────────────────
 * Template-composed, same discipline as utils/venueCalendarNote: it runs inside
 * a lead read, must be identical for identical inputs, and must never
 * editorialise. The same banned-phrase rule applies — business terms only, and
 * tradition NEVER appears as a customer type.
 */
const VenueBooking = require("../models/VenueBooking");
const VenueEnquiry = require("../models/VenueEnquiry");
const { leadDays, blockHours, blockBucket } = require("./venueContention");
const { resolveBlock, resolveRange } = require("./weddingCalendar");
const { scopedLeadFilter } = require("./venueLeadScope");

// Below this, we say "not enough history" instead of quoting a range. Three is
// the smallest number from which a median means anything at all.
const MIN_COMPARABLES = 3;
// How far back a booking still tells you something about today's rate card.
const COMPARABLE_LOOKBACK_DAYS = 540; // ~18 months, so a full season repeats

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
/** ₹7,20,000 → "₹7.2L" — how these numbers are actually said out loud. */
function shortINR(n) {
  const v = Number(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(v % 10000000 === 0 ? 0 : 1)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(v % 100000 === 0 ? 0 : 1)}L`;
  if (v >= 1000) return `₹${Math.round(v / 1000)}k`;
  return inr(v);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * The signals that make two dates comparable. Deliberately coarse: matching on
 * anything finer produces zero comparables at a venue with fifty bookings, and
 * a precise answer about nothing is worth less than a rough answer about
 * something.
 */
function signatureOf({ auspicious, isWeekend, bucket }) {
  return { auspicious: Boolean(auspicious), isWeekend: Boolean(isWeekend), bucket: bucket || "24h" };
}

function sameShape(a, b) {
  return a.auspicious === b.auspicious && a.isWeekend === b.isWeekend && a.bucket === b.bucket;
}

/**
 * Confirmed bookings whose date shape matches this lead's, with what they went
 * for. Two queries: the bookings, then the calendar picture for their dates.
 */
async function comparableBookings({ venue, targetSignature, excludeEnquiryId, now = new Date() }) {
  const since = new Date(now.getTime() - COMPARABLE_LOOKBACK_DAYS * 86400000);
  const bookings = await VenueBooking.find({
    venue: venue._id,
    status: { $ne: "cancelled" },
    totalValue: { $gt: 0 },
    createdAt: { $gte: since },
    ...(excludeEnquiryId ? { enquiry: { $ne: excludeEnquiryId } } : {}),
  })
    .select("days totalValue enquiry createdAt")
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  if (!bookings.length) return { rows: [], scanned: 0 };

  // ONE calendar resolve across the whole span rather than one per booking —
  // three queries total however many bookings came back, which is the same
  // discipline utils/weddingCalendar sets for itself.
  const allKeys = bookings
    .flatMap((b) => (b.days || []).map((d) => (d.date ? new Date(d.date).toISOString().slice(0, 10) : null)))
    .filter(Boolean)
    .sort();
  if (!allKeys.length) return { rows: [], scanned: bookings.length };
  const days = await resolveRange({
    venue,
    from: allKeys[0],
    to: allKeys[allKeys.length - 1],
    fillEmptyDays: true,
  });

  const rows = [];
  for (const b of bookings) {
    const keys = (b.days || []).map((d) => (d.date ? new Date(d.date).toISOString().slice(0, 10) : null)).filter(Boolean);
    if (!keys.length) continue;
    const first = days.get(keys[0]);
    if (!first) continue;
    // Block length from the booking's own day count — bookings do not carry a
    // check-in/check-out pair, so days ARE the block here.
    const bucket = blockBucket(Math.max(24, (keys.length - 1) * 24 || 24));
    const sig = signatureOf({
      auspicious: Boolean(first.auspicious),
      isWeekend: keys.some((k) => days.get(k) && days.get(k).isWeekend),
      bucket,
    });
    if (!sameShape(sig, targetSignature)) continue;
    rows.push({ amount: b.totalValue, date: keys[0], days: keys.length });
  }
  return { rows, scanned: bookings.length };
}

/**
 * What the OTHER live enquiries for these dates have been quoted.
 *
 * Same split as utils/venueContention, and for the same reason: the aggregate
 * is the entire value of the feature ("three others are in the room and the
 * middle of them is at ₹7L"), while names and per-lead figures stay inside the
 * requester's scope. A scoped member gets the count and the median and nothing
 * that identifies anyone.
 */
async function competingQuotes({ venueOwner, venueMember, venueId, dayKeys, excludeId }) {
  if (!dayKeys.length) return { count: 0, median: 0, high: 0, named: [], scoped: false, hiddenCount: 0 };
  const { leadsOnDays } = require("./venueContention");
  const all = await leadsOnDays(venueId, dayKeys, excludeId);
  const quoted = all.filter((l) => Number(l.estimatedValue) > 0);
  const amounts = quoted.map((l) => Number(l.estimatedValue));

  // Which of them may this requester actually open?
  let visibleIds = new Set();
  if (quoted.length) {
    const filter = await scopedLeadFilter(venueOwner, venueMember, venueId, {
      _id: { $in: quoted.map((l) => l._id) },
    });
    const visible = await VenueEnquiry.find(filter).select("_id").lean();
    visibleIds = new Set(visible.map((v) => String(v._id)));
  }
  const named = quoted
    .filter((l) => visibleIds.has(String(l._id)))
    .map((l) => ({ _id: l._id, name: l.coupleName || l.name || "Lead", amount: Number(l.estimatedValue), stage: l.stage }));

  return {
    count: quoted.length,
    // AGGREGATES ONLY. The raw per-lead amounts are deliberately NOT returned:
    // handing back the list would let a scoped member reconstruct what each
    // invisible competitor was quoted just by sorting it, which is exactly the
    // per-lead figure the scope boundary exists to withhold. median and high
    // are computed here and the array is dropped on the floor.
    median: median(amounts),
    high: amounts.length ? Math.max(...amounts) : 0,
    named,
    // TRUE when there are quoted competitors this requester cannot open.
    scoped: named.length < quoted.length,
    hiddenCount: quoted.length - named.length,
  };
}

// ── the advice line ─────────────────────────────────────────────────────────

/**
 * Compose ONE line. Templates only; never a model call.
 *
 * Priority: a real comparable range beats everything, because it is the only
 * input that is actual money this venue actually got. Competing quotes come
 * second. The date's own signals are the fallback — better than nothing, but
 * they describe demand rather than price.
 */
function composeAdvice(s) {
  const parts = [];

  if (s.comparables.enough) {
    const c = s.comparables;
    parts.push(
      `${c.count} comparable ${c.count === 1 ? "booking" : "bookings"} at this venue went for ${shortINR(c.low)}–${shortINR(c.high)}, middle ${shortINR(c.median)}.`
    );
  } else if (s.comparables.count > 0) {
    // Honest about the sample rather than dressing it up as a range.
    parts.push(
      `Only ${s.comparables.count} comparable ${s.comparables.count === 1 ? "booking" : "bookings"} on record — not enough to call a range yet.`
    );
  } else {
    parts.push("No comparable bookings on record for a date like this yet.");
  }

  if (s.competing.count > 0) {
    parts.push(
      `${s.competing.count} other ${s.competing.count === 1 ? "enquiry has" : "enquiries have"} been quoted for this date, middle ${shortINR(s.competing.median)}.`
    );
  }

  // What the date itself argues for — demand language, never a price claim.
  const push = [];
  if (s.date.auspicious) push.push(s.date.tier === "major" ? "a major muhurat date" : "an auspicious date");
  if (s.date.isWeekend) push.push("a weekend");
  if (s.date.blockBucket && s.date.blockBucket !== "24h") push.push(`a ${s.date.blockBucket} block`);
  if (push.length && (s.comparables.enough || s.competing.count > 0)) {
    parts.push(`This is ${push.join(", ")} — the top of that range is defensible.`);
  } else if (push.length) {
    parts.push(`This is ${push.join(", ")}, so there is room above your usual number.`);
  }

  // The one place a concrete instruction is warranted.
  if (s.currentQuote > 0 && s.comparables.enough && s.currentQuote < s.comparables.median) {
    parts.push(`Your current quote of ${shortINR(s.currentQuote)} sits below that middle.`);
  }

  return parts.join(" ");
}

/**
 * The whole picture for one lead.
 * @returns {{ advice: string, signals: object }} — prose AND structure, so the
 * UI styles from facts and a wording change needs no server round-trip.
 */
async function pricingIntelForLead({ venue, lead, venueOwner, venueMember }) {
  const dayKeys = leadDays(lead);
  const hours = blockHours(lead);
  const bucket = blockBucket(hours);

  let dateSignals = { auspicious: false, tier: null, isWeekend: false, blackout: null, blockBucket: bucket };
  if (dayKeys.length) {
    const block = await resolveBlock({ venue, dayKeys });
    const first = block && block.days[0];
    dateSignals = {
      auspicious: Boolean(block && block.auspiciousDays.length),
      tier: block && block.auspiciousDays[0] ? block.auspiciousDays[0].auspicious.tier : null,
      isWeekend: Boolean(block && block.weekendDays.length),
      blackout: block && block.blackoutDays[0] ? block.blackoutDays[0].blackout.name : null,
      blockBucket: bucket,
      weekday: first ? first.weekday : null,
    };
  }

  const targetSignature = signatureOf({
    auspicious: dateSignals.auspicious,
    isWeekend: dateSignals.isWeekend,
    bucket,
  });

  const [{ rows, scanned }, competing] = await Promise.all([
    dayKeys.length
      ? comparableBookings({ venue, targetSignature, excludeEnquiryId: lead._id })
      : Promise.resolve({ rows: [], scanned: 0 }),
    dayKeys.length
      ? competingQuotes({ venueOwner, venueMember, venueId: venue._id, dayKeys, excludeId: lead._id })
      : Promise.resolve({ count: 0, median: 0, high: 0, named: [], scoped: false, hiddenCount: 0 }),
  ]);

  const amounts = rows.map((r) => r.amount);
  const comparables = {
    count: rows.length,
    scanned,
    enough: rows.length >= MIN_COMPARABLES,
    low: amounts.length ? Math.min(...amounts) : 0,
    high: amounts.length ? Math.max(...amounts) : 0,
    median: median(amounts),
    // The matching rule, echoed so the UI can say WHY these are comparable
    // rather than presenting a number from nowhere.
    matchedOn: targetSignature,
  };

  const signals = {
    currentQuote: Number(lead.estimatedValue) || 0,
    budget: lead.budget || "",
    date: dateSignals,
    comparables,
    competing,
    minComparables: MIN_COMPARABLES,
  };

  return { advice: composeAdvice(signals), signals };
}

module.exports = {
  MIN_COMPARABLES,
  COMPARABLE_LOOKBACK_DAYS,
  shortINR,
  median,
  signatureOf,
  sameShape,
  comparableBookings,
  competingQuotes,
  composeAdvice,
  pricingIntelForLead,
};
