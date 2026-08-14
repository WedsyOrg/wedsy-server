/**
 * utils/venueCalendarNote.js — the calendar signals, said out loud.
 *
 * ONE note, composed from templates. No AI call: this runs inside the lead read
 * on every open, it must be identical for the same inputs, and a model that
 * occasionally editorialises about communities is exactly the failure this file
 * is written to prevent.
 *
 * ── THE LANGUAGE RULE, which is not negotiable ───────────────────────────────
 * Speak in BUSINESS terms: booking days, demand, competition, pricing, closing.
 * Tradition appears ONLY as neutral calendar fact — "auspicious for North
 * Indian and Kannada weddings" — because that is what the panchang says about
 * the DATE. It must never appear as a customer preference: never "prefer the
 * North Indian enquiry", never "this couple's community books bigger", never
 * anything that ranks people. Where the note ranks, it ranks BLOCK LENGTH and
 * STAGE, which are facts about the deal, not about who is asking.
 *
 * ── WHY IT COMPOSES INSTEAD OF STACKING ──────────────────────────────────────
 * The signals used to render as separate boxes — a tips list, a contention
 * strip, a month-demand line. Three boxes saying related things about one date
 * is a flags dump: the owner reads the first, skims the second and stops. One
 * note that says "this is a 2-day block on an auspicious Saturday, four others
 * want it, two of them for the full 48 hours — quote strong and put a deadline
 * on it" is a colleague talking. So the composer builds at most three clauses —
 * WHAT the date is, WHAT the demand is, WHAT to do — and drops any it has
 * nothing true to say for.
 *
 * ── SILENCE IS A VALID OUTPUT ────────────────────────────────────────────────
 * If nothing meaningful applies, `text` is "". A note that appears on every
 * lead teaches an owner to stop reading notes.
 *
 * Returns { text, signals } — the composed string AND the structured facts, so
 * the UI can style tone off the signals and a future wording change never needs
 * a server round-trip.
 */
const { labelList, parentsOf, coversBoth } = require("./weddingTraditions");
const { cleanEventType, isCorporate, showsAuspicious, blackoutSense } = require("./venueEventType");

const DAY = 86400000;
// The window where an unclaimed date is worth chasing rather than waiting on —
// carried over from the client-side tip this note replaces.
const CLOSE_SOON_MIN_DAYS = 56;
const CLOSE_SOON_MAX_DAYS = 70;
// How far either side of the block a holiday still helps guests travel.
const HOLIDAY_ADJACENT_DAYS = 2;

const STAGE_LABEL = {
  new: "new",
  contacted: "contacted",
  site_visit_scheduled: "site visit booked",
  site_visit_done: "site visit done",
  proposal_sent: "proposal sent",
  negotiating: "in negotiation",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "26 Nov" — short, because the note names dates mid-sentence. */
function shortDate(key) {
  if (!key) return "";
  const [y, m, d] = String(key).split("-").map(Number);
  if (!y || !m || !d) return key;
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

/**
 * "2-day block" / "single-day", derived from HOURS rather than from calendar
 * days touched.
 *
 * These differ and the difference matters. A 21st-06:00 → 23rd-06:00 booking is
 * 48 hours — two days — but it touches three calendar squares, so counting days
 * called it a "3-day block" and overstated what the couple asked for. Hours are
 * also the same source the competitor split uses ("2 want 24h, 1 wants 48h"),
 * so the two halves of one sentence now measure the same thing.
 */
function blockPhrase(hours) {
  if (!hours || hours <= 24) return "single-day";
  if (hours <= 36) return "36-hour block";
  return `${Math.round(hours / 24)}-day block`;
}

function pluralEnquiries(n) {
  return n === 1 ? "1 other enquiry" : `${n} other enquiries`;
}

/** "2 want 24h, 1 wants 36h, 3 want 48h" — never a bare crowd. */
function blocksPhrase(blocks) {
  if (!blocks || !blocks.buckets || !blocks.buckets.length) return "";
  return blocks.buckets
    .map((b) => `${b.count} want${b.count === 1 ? "s" : ""} ${b.bucket}`)
    .join(", ");
}

/**
 * The calendar headline. Priority order matters: a blackout is the single most
 * decisive thing that can be true about a date, so it wins outright — telling
 * an owner to "quote strong" for a date inside Chaturmas would be actively
 * wrong.
 */
function leadClause(s) {
  const when = `${shortDate(s.date)}${s.weekday ? ` (${s.weekday})` : ""}`;

  // ── blackout ──
  // THE INVERSION. The same stored fact means opposite things by event type: a
  // wedding cannot happen in Chaturmas, and a corporate booking does not care —
  // which makes the empty season the single best reason to chase this lead.
  // Suppressing it for corporate would have been the easy wrong answer.
  if (s.blackout) {
    const who = s.blackout.traditionParents.length ? labelList(s.blackout.traditionParents) : "Hindu";
    const window = s.blackout.window ? ` (${s.blackout.window})` : "";
    if (s.blackoutSense === "positive") {
      return `${when} sits in ${s.blackout.name}${window} — the quiet season for weddings. Corporate bookings are exactly what fills these dates.`;
    }
    // "Almost no North Indian weddings happen" — NOT "no Hindu weddings happen
    // for North Indian weddings", which is what naive concatenation produced.
    return `${when} falls inside ${s.blackout.name}${window}. Almost no ${who} weddings happen in this stretch.`;
  }

  // ── auspicious ──
  if (s.auspicious) {
    const who = s.auspicious.traditionParents.length ? labelList(s.auspicious.traditionParents) : "";
    const both = coversBoth(s.auspicious.traditionParents);
    // On a weekend the WEEKDAY carries the demand signal, so it goes into the
    // phrase itself ("an auspicious Saturday") rather than being bolted on as a
    // second sentence about weekends.
    const strength = s.auspicious.tier === "major" ? "a major muhurat" : "an auspicious";
    const head = s.isWeekend && s.weekday
      ? `${strength} ${s.weekday} (${shortDate(s.date)})`
      : `${strength} date, ${when}`;
    const shape = s.isMultiDay ? `a ${blockPhrase(s.blockHours)} on ` : "";
    // "in the North Indian calendar", not "auspicious for North Indian
    // weddings" — the head already said auspicious, and naming the CALENDAR
    // keeps this unambiguously a fact about the date rather than about people.
    const audience = both
      ? " in both the North and South Indian calendars"
      : who
        ? ` in the ${who} calendar`
        : "";
    return `This is ${shape}${head}${audience}.`;
  }

  // ── weekend, the milder version of the same signal ──
  if (s.isWeekend) {
    const shape = s.isMultiDay ? `a ${blockPhrase(s.blockHours)} over ` : "";
    return `This is ${shape}${shape ? "" : "a "}weekend date, ${when}.`;
  }

  // ── a multi-day weekday block is still worth naming ──
  if (s.isMultiDay) {
    return `This is a ${blockPhrase(s.blockHours)} starting ${when}.`;
  }
  return "";
}

/**
 * What the demand actually looks like. Contention first (real competitors),
 * then the sole-enquiry case, then approximate month demand.
 */
function demandClause(s) {
  if (s.blackout) {
    if (s.blackoutSense === "positive") {
      // For corporate the empty calendar is the ARGUMENT, not the warning.
      if (s.contention && s.contention.count > 0) {
        const n = s.contention.count;
        return `${pluralEnquiries(n)} ${n === 1 ? "wants" : "want"} this date even in the off-season — it is not as open as it looks.`;
      }
      return "The date is wide open and competing weddings will not appear.";
    }
    // Inside a blackout the useful demand statement is the ABSENCE of it —
    // and if there somehow is competition, that is worth saying plainly too.
    if (s.contention && s.contention.count > 0) {
      const n = s.contention.count;
      return `${pluralEnquiries(n)} ${n === 1 ? "still wants" : "still want"} this date, which is unusual for this stretch.`;
    }
    return "Few enquiries will come for this date.";
  }

  if (s.contention && s.contention.count > 0) {
    const c = s.contention;
    const split = blocksPhrase(c.blocks);
    const furthest = c.topStage ? `, furthest along ${STAGE_LABEL[c.topStage] || c.topStage}` : "";
    // The block split is the whole point of saying the number at all.
    if (split) {
      return `${pluralEnquiries(c.count)} want ${shortDate(c.date)} — ${split}${furthest}.`;
    }
    return `${pluralEnquiries(c.count)} want ${shortDate(c.date)}${furthest}.`;
  }

  if (s.soleEnquiry) {
    // "the couple" is wrong on a conference booking, and getting it wrong is
    // exactly the kind of small tell that says this product was not built for
    // what the reader is doing.
    return `Only enquiry for this date so far — the ${isCorporate(s.eventType) ? "client" : "couple"} has the leverage here.`;
  }

  if (s.approximateDemand && s.approximateDemand.count > 0) {
    const n = s.approximateDemand.count;
    return `${n} other ${n === 1 ? "enquiry is" : "enquiries are"} looking at ${s.approximateDemand.monthLabel} without fixed dates yet.`;
  }
  return "";
}

/** What to do about it. At most one action — a list of advice is not advice. */
function actionClause(s) {
  if (s.blackout) {
    if (s.isBooked) return "";
    return s.blackoutSense === "positive"
      // Already the corporate lead the wedding-side note would have told them
      // to go and find — so the advice is about rate, not repurposing.
      ? "Off-season capacity is worth filling — there is room to be competitive on rate and still win the date."
      : "Worth closing this one, or pitching the date for a corporate event.";
  }

  const hot = s.auspicious || (s.contention && s.contention.count >= 2);
  if (s.contention && s.contention.count > 0) {
    const bigger = s.contention.blocks && s.contention.blocks.buckets.some((b) => b.bucket === "48h" || b.bucket === "48h+");
    if (bigger && s.ownBlock === "24h") {
      return "Someone else wants a longer block for the same date — worth knowing before you discount this one.";
    }
    return hot
      ? "Expect competition — quote strong and put a deadline on the hold."
      : "Worth putting a deadline on the quote.";
  }

  // Sole AND close: the two facts reinforce each other, so they compose into
  // one instruction rather than the sole branch silently swallowing the other.
  if (s.soleEnquiry && s.closeAndOpen) {
    return "The date is close, still open and uncontested — few new enquiries arrive this late, so chase this one.";
  }
  if (s.soleEnquiry && s.auspicious) {
    return "Nobody else is asking yet, so there is room to close it properly rather than rush — but an auspicious date rarely stays quiet.";
  }
  if (s.soleEnquiry) {
    return "Worth closing while it is uncontested.";
  }
  if (s.closeAndOpen) {
    return "The date is close and still open — few new enquiries arrive this late, so chase this one.";
  }
  if (s.auspicious) {
    return "Expect competing enquiries and price accordingly.";
  }
  if (s.isWeekend) {
    return "Weekend dates move faster than weekdays — don't leave the quote open too long.";
  }
  return "";
}

/** Guest-travel colour. Additive, never the headline. */
function holidayClause(s) {
  if (s.blackout) return "";
  if (s.holidayOnBlock) {
    const h = s.holidayOnBlock;
    return `${h.name} falls in this block${h.region ? ` (${h.region})` : ""} — guests travel more easily around a public holiday.`;
  }
  if (s.adjacentHoliday) {
    const h = s.adjacentHoliday;
    return `${h.name} is ${h.offset === 1 ? "the day" : `${h.offset} days`} ${h.side} this block${h.region ? ` (${h.region})` : ""} — easier for guests to travel.`;
  }
  return "";
}

/** The no-dates case: the month's shape is the useful demand context. */
function undecidedNote(s) {
  const parts = [];
  const label = s.approximateDemand ? s.approximateDemand.monthLabel : s.monthLabel;
  if (!label) return "";

  if (s.monthBlackout) {
    parts.push(
      s.blackoutSense === "positive"
        ? `${label} falls largely inside ${s.monthBlackout.name} — the quiet season for weddings, so the calendar is open and the rate has room.`
        : `${label} falls largely inside ${s.monthBlackout.name} — almost no Hindu weddings happen then, so this one may be worth steering to another month.`
    );
  } else if (s.monthAuspiciousCount > 0 && showsAuspicious(s.eventType)) {
    const both = coversBoth(s.monthTraditionParents);
    const n = s.monthAuspiciousCount;
    // Says exactly what was counted. "Most of them" would be a claim about
    // individual dates that nothing here actually measured.
    const spread = both
      ? " across both the North and South Indian calendars"
      : s.monthTraditionParents.length
        ? ` in the ${labelList(s.monthTraditionParents)} calendar`
        : "";
    parts.push(`${label} has ${n} auspicious date${n === 1 ? "" : "s"}${spread}.`);
    if (both) parts.push("A month drawing both traditions tends to fill early, and often with multi-day bookings.");
  } else {
    parts.push(`No auspicious dates recorded in ${label}.`);
  }

  if (s.approximateDemand && s.approximateDemand.count > 0) {
    const n = s.approximateDemand.count;
    parts.push(`${n} other ${n === 1 ? "enquiry is" : "enquiries are"} looking at the same month.`);
  }
  parts.push("Worth pinning the dates down — nothing can be held until they are.");
  return parts.join(" ");
}

/**
 * Compose the note.
 *
 * @param {object} input
 * @param {object|null} input.block       utils/weddingCalendar.resolveBlock output
 * @param {object|null} input.contention  utils/venueContention.contentionForLead output
 * @param {object|null} input.approximateDemand { month, count }
 * @param {object|null} input.monthPicture for undecided leads: resolveRange over the named month
 * @param {boolean} input.hasHold
 * @param {boolean} input.isBooked
 * @param {Date|string|null} input.checkIn
 * @param {Date} [input.now]
 * @returns {{ text: string, signals: object }}
 */
function composeCalendarNote(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const block = input.block || null;
  const contention = input.contention || null;

  // ── build the signal set ──
  const days = block ? block.days : [];
  const first = days[0] || null;
  // Block length in HOURS. Prefer the caller's explicit value, then what
  // contention already computed for this lead; fall back to calendar days only
  // when neither is available (a check-in with no check-out is 24h).
  const hours =
    input.blockHours != null
      ? input.blockHours
      : contention && contention.ownBlockHours != null
        ? contention.ownBlockHours
        : days.length
          ? Math.max(24, (days.length - 1) * 24)
          : null;
  const auspiciousDay = (block && block.auspiciousDays[0]) || null;
  const blackoutDay = (block && block.blackoutDays[0]) || null;

  const holidayOnBlockDay = (block && block.holidayDays[0]) || null;
  const holidayOnBlock = holidayOnBlockDay ? holidayOnBlockDay.holidays[0] : null;

  // A holiday just outside the block still helps guests travel.
  let adjacentHoliday = null;
  if (!holidayOnBlock && input.adjacentHolidays && input.adjacentHolidays.length && first) {
    const firstMs = Date.parse(`${first.date}T00:00:00Z`);
    const lastMs = Date.parse(`${days[days.length - 1].date}T00:00:00Z`);
    let best = null;
    for (const h of input.adjacentHolidays) {
      const hMs = Date.parse(`${h.date}T00:00:00Z`);
      const before = Math.round((firstMs - hMs) / DAY);
      const after = Math.round((hMs - lastMs) / DAY);
      const offset = before > 0 ? before : after;
      const side = before > 0 ? "before" : "after";
      if (offset > 0 && offset <= HOLIDAY_ADJACENT_DAYS && (!best || offset < best.offset)) {
        best = { name: h.name, region: h.region, offset, side };
      }
    }
    adjacentHoliday = best;
  }

  const checkIn = input.checkIn ? new Date(input.checkIn) : null;
  const daysOut = checkIn && !Number.isNaN(checkIn.getTime())
    ? Math.round((checkIn.getTime() - now.getTime()) / DAY)
    : null;

  const monthPicture = input.monthPicture || null;
  const monthDays = monthPicture ? [...monthPicture.values()] : [];
  const monthAuspicious = monthDays.filter((d) => d.auspicious);
  const monthBlackoutDay = monthDays.find((d) => d.blackout) || null;

  // BUILD A — the event type decides how the wedding-specific layer is read.
  const eventType = cleanEventType(input.eventType);

  const signals = {
    eventType,
    // A conference is not scheduled off a panchang. Telling an owner a
    // corporate date is "a major muhurat — expect competition" is worse than
    // silence: it is confidently wrong about who they are competing with.
    blackoutSense: blackoutSense(eventType),
    hasDates: Boolean(block && days.length),
    date: first ? first.date : null,
    weekday: first ? first.weekday : null,
    isWeekend: block ? block.weekendDays.length > 0 : false,
    blockNights: block ? block.nights : 0,
    // Hours, not calendar squares — see blockPhrase for why they differ.
    blockHours: hours,
    isMultiDay: hours != null && hours > 24,
    ownBlock: contention ? contention.ownBlock : null,
    auspicious: auspiciousDay && showsAuspicious(eventType)
      ? {
          tier: auspiciousDay.auspicious.tier,
          traditions: auspiciousDay.auspicious.traditions,
          traditionParents: auspiciousDay.auspicious.traditionParents,
          verified: auspiciousDay.auspicious.verified,
        }
      : null,
    blackout: blackoutDay
      ? {
          name: blackoutDay.blackout.name,
          traditionParents: blackoutDay.blackout.traditionParents,
          window: blackoutDay.blackout.window || "",
          verified: blackoutDay.blackout.verified,
        }
      : null,
    holidayOnBlock,
    adjacentHoliday,
    contention:
      contention && contention.count > 0
        ? { count: contention.count, topStage: contention.topStage, date: contention.date, blocks: contention.blocks }
        : null,
    soleEnquiry: Boolean(contention && contention.sole),
    approximateDemand: input.approximateDemand
      ? { ...input.approximateDemand, monthLabel: monthLabelOf(input.approximateDemand.month) }
      : null,
    closeAndOpen:
      daysOut !== null &&
      !input.hasHold &&
      !input.isBooked &&
      daysOut >= CLOSE_SOON_MIN_DAYS &&
      daysOut <= CLOSE_SOON_MAX_DAYS,
    daysOut,
    isBooked: Boolean(input.isBooked),
    hasHold: Boolean(input.hasHold),
    // Everything the note says rests on data a human has not checked yet.
    unverified: Boolean(
      (auspiciousDay && showsAuspicious(eventType) && !auspiciousDay.auspicious.verified) ||
        (blackoutDay && !blackoutDay.blackout.verified)
    ),
    // undecided-lead context
    monthLabel: monthLabelOf(input.approximateDemand && input.approximateDemand.month),
    monthAuspiciousCount: monthAuspicious.length,
    monthTraditionParents: parentsOf(monthAuspicious.flatMap((d) => d.auspicious.traditions)),
    monthBlackout: monthBlackoutDay ? { name: monthBlackoutDay.blackout.name } : null,
  };

  // ── compose ──
  let text = "";
  if (!signals.hasDates) {
    text = undecidedNote(signals);
  } else {
    const parts = [leadClause(signals), demandClause(signals), holidayClause(signals), actionClause(signals)]
      .map((p) => (p || "").trim())
      .filter(Boolean);
    text = parts.join(" ");
  }

  return { text: text.trim(), signals };
}

function monthLabelOf(monthKey) {
  if (!monthKey) return "";
  const [y, m] = String(monthKey).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return "";
  return `${MONTHS[m - 1]} ${y}`;
}

module.exports = {
  composeCalendarNote,
  // exported for tests + reuse
  shortDate,
  blockPhrase,
  blocksPhrase,
  monthLabelOf,
  leadClause,
  demandClause,
  actionClause,
  holidayClause,
  undecidedNote,
  CLOSE_SOON_MIN_DAYS,
  CLOSE_SOON_MAX_DAYS,
  HOLIDAY_ADJACENT_DAYS,
};
