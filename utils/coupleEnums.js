/* COUPLE-APP ENUMS — the values § 06.2 asks to be "shared verbatim between
 * client and server".
 *
 * They live in ONE file for the same reason utils/phone.js does: an enum
 * hand-copied into eight schemas is eight places to forget when a seventh
 * palette ships. Every couple-app model below requires its lists from here,
 * and the couple-app services validate against the same arrays — so a value
 * the client can send and a value a document can hold cannot drift apart.
 *
 * The client's copies are lib/plan/seed/members.js (SECTIONS, LEVELS,
 * RELATIONS) and the § 06.1 table. Changing a list here is a contract change.
 */

// § 06.1 — a guest has replied yes, replied no, or has not replied.
const RSVP_STATUS = ["pending", "yes", "no"];

// Whose guest they are. Drives the Guests filter and the website tally.
const SIDE = ["bride", "groom"];

// The five functions a wedding can have. An Event.eventDays[] row maps onto
// one of these; anything else is a custom day and carries key "".
const EVENT_KEY = ["haldi", "mehndi", "sangeet", "wedding", "reception"];

// Where a day's décor has got to. "finalised" is terminal (§ 06.2: the
// finalise is irreversible).
const DECOR_STATE = ["none", "drafted", "needs_input", "priced", "finalised"];

// § 06.4 — what a SharedMember may do in one section.
const ACCESS_LEVEL = ["none", "view", "edit"];

// The six sections family sharing is cut into. NOT a permission list: there
// is deliberately no "payouts" section here — see services/CouplePermissions.
const SECTION = ["guests", "website", "decor", "registry", "payments", "tasks"];

// The couple-facing status of a payment ROW. The stored Payment.status enum
// is the gateway's (created/attempted/paid/…); this is what the screen shows.
const PAYMENT_STATUS = ["due", "paid"];

// § 05.1 group gifting — a guest takes the whole gift or chips in.
const CONTRIBUTION_MODE = ["full", "part"];

// A wallet row. § 06.1 names credit and claim; "debit" is the third real
// movement (the balance applied as an offset in the Pay flow) and "reversal"
// is a declined claim coming back. Documented in docs/couple-app-api.md.
const WALLET_TXN_TYPE = ["credit", "claim", "debit", "reversal"];

const WALLET_TXN_STATUS = ["pending", "settled", "failed"];

// § 04 — the website builder's fixed sets.
const THEME_ID = ["tp1", "tp2", "tp3", "tp4", "tp5", "tp6"];
const PALETTE_ID = ["p1", "p2", "p3", "p4", "p5", "p6"];
const FONT_ID = ["f1", "f2", "f3", "f4"];

// § 05.5 — the 17 relation presets, verbatim from the client's
// lib/plan/seed/members.js. Stored as free text with these as the presets:
// a couple whose person is not on the list must still be able to invite them.
const RELATIONS = [
  "Bride", "Groom",
  "Bride's mother", "Bride's father", "Groom's mother", "Groom's father",
  "Bride's sister", "Bride's brother", "Groom's sister", "Groom's brother",
  "Maid of honour", "Best man", "Bridesmaid", "Groomsman",
  "Cousin", "Friend", "Wedding planner (personal)",
];

// § 05.5 — a new member starts with everything closed except the guest list.
const DEFAULT_ACCESS = {
  guests: "view", website: "none", decor: "none",
  registry: "none", payments: "none", tasks: "none",
};

module.exports = {
  RSVP_STATUS, SIDE, EVENT_KEY, DECOR_STATE, ACCESS_LEVEL, SECTION,
  PAYMENT_STATUS, CONTRIBUTION_MODE, WALLET_TXN_TYPE, WALLET_TXN_STATUS,
  THEME_ID, PALETTE_ID, FONT_ID, RELATIONS, DEFAULT_ACCESS,
};
