/* THE REGISTRY, THE WALLET AND THE PAY FLOW — every rule that is arithmetic or
 * shape, and none that is a database call (§ 05.1, § 05.4, § 06.2, § 06.3).
 *
 * PURE. Plain objects in, plain objects out, no mongoose, no express, no clock
 * except one that can be passed in. That is what lets the three things this
 * milestone can actually get wrong be tested without a database:
 *
 *   1. THE OFFSET. `payBody` below is the ONLY door a Pay request comes
 *      through, and it emits exactly two keys — `method` and `useWallet`. A
 *      client that posts `walletApplied: 999999` has posted a field that is
 *      dropped before any code that could read it. The arithmetic itself is
 *      CoupleWalletService.applyWallet, which has no parameter an amount could
 *      arrive in; this file's job is to make sure nothing else does either.
 *
 *   2. THE WITHHOLDING. `publicRegistryPayload` is the one function that builds
 *      the body a stranger receives, and the one function that can withhold —
 *      so there is no second path that could forget. A guest's NAME, PHONE
 *      NUMBER and NOTE are the couple's to read and no other guest's, and the
 *      only figure that crosses is the total.
 *
 *   3. THE SPENDABLE BALANCE. See `spendable()` — the one place this milestone
 *      knowingly computes a figure CoupleWalletService does not, and why.
 *
 * Everything about SIGNS and TOTALS is delegated to services/CoupleWalletService:
 * this file imports `money`, `balance`, `isSettled` and `signOf` and never
 * re-derives them. The ledger has one arithmetic.
 */

const wallet = require("./CoupleWalletService");
const { CONTRIBUTION_MODE } = require("../utils/coupleEnums");

const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_INTRO = 2000;
const MAX_URL = 2000;
const MAX_NAME = 120;
const MAX_PHONE = 30;
/* A ceiling on one gift. Not a business limit — a typo limit: a guest who means
 * ₹5,000 and holds the zero key should be asked, not charged. */
const MAX_AMOUNT = 5000000;

/* ── small shared helpers ─────────────────────────────────────────────────── */

const str = (value, max) => String(value === undefined || value === null ? "" : value).trim().slice(0, max);
const id = (value) => (value === undefined || value === null ? null : String(value));
/** Rupees, through the ledger's own coercion so nothing here rounds differently. */
const rupees = wallet.money;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/* ── refusal bodies (§ 3 of docs/couple-app-api.md — unchanged shapes) ─────── */

const validation = (fields, message) => ({
  status: 422,
  body: { error: "validation", fields: fields || {}, message: message || "Please check the highlighted fields." },
});

const notFound = (message) => ({ status: 404, body: { error: "not_found", message: message || "We could not find that." } });

/** § 05.1's race: somebody took the whole gift while this guest was typing. */
const alreadyFunded = (gift) => ({
  status: 409,
  body: {
    error: "already_funded",
    funded: rupees(gift && (gift.funded !== undefined ? gift.funded : gift.raised)),
    price: rupees(gift && (gift.price !== undefined ? gift.price : gift.target)),
    message: "Someone got there first — this one has just been taken in full.",
  },
});

/* ── the couple's registry ────────────────────────────────────────────────── */

/**
 * A contribution as the COUPLE reads it (the Thank-yous tab, § 05.1).
 *
 * This is the only shaping function that emits a guest's name, phone or note,
 * and it is never reached from the public payload — `publicContribution` below
 * is a different function on purpose, not this one with a flag.
 */
const coupleContribution = (row) => ({
  id: id(row && row._id),
  guestName: (row && row.guestName) || "",
  guestPhone: (row && row.guestPhone) || "",
  note: (row && row.note) || "",
  amount: rupees(row && row.amount),
  mode: (row && row.mode) || "part",
  status: (row && row.status) || "settled",
  thanked: Boolean(row && row.thanked),
  thankedAt: (row && row.thankedAt) || null,
  createdAt: (row && row.createdAt) || null,
});

/**
 * A contribution as a STRANGER reads it: an amount, and nothing else at all.
 *
 * wedsy-user's components/registry/GuestRegistry.js derives a gift's progress
 * bar with `(row.contributions || []).reduce((n, c) => n + rupees(c.amount))`.
 * Handing it the real rows would put every other guest's NAME, PHONE NUMBER and
 * private note on a page anyone with the link can open. Handing it nothing
 * would draw every progress bar at zero.
 *
 * So the public payload carries the TOTAL, as one anonymous row: no id, no
 * name, no phone, no note, no date, and no per-gift granularity that could be
 * matched against a guest list. `funded`/`raised` carry the same number beside
 * it, so a client that reads either gets the same answer.
 */
const publicContribution = (total) => ({ amount: rupees(total) });

/** One wishlist gift, for the couple. `funded` is the denormalised running total. */
const shapeItem = (item, contributions) => {
  const rows = Array.isArray(contributions) ? contributions : [];
  const price = rupees(item && item.price);
  const funded = rupees(item && item.funded);
  return {
    id: id(item && item._id),
    title: (item && item.title) || "",
    image: (item && item.image) || "",
    price,
    sourceUrl: (item && item.sourceUrl) || "",
    source: (item && item.source) || "",
    pinned: Boolean(item && item.pinned),
    funded,
    remaining: Math.max(0, price - funded),
    archivedAt: (item && item.archivedAt) || null,
    createdAt: (item && item.createdAt) || null,
    contributions: rows.map(coupleContribution),
  };
};

/** One cash fund. A fund is a GOAL, not a price: money past `target` is welcome. */
const shapeFund = (fund, contributions) => {
  const rows = Array.isArray(contributions) ? contributions : [];
  const target = rupees(fund && fund.target);
  const raised = rupees(fund && fund.raised);
  return {
    id: id(fund && fund._id),
    title: (fund && fund.title) || "",
    image: (fund && fund.image) || "",
    target,
    raised,
    funded: raised,          // the client's fundedOf() vocabulary, one word for both
    remaining: Math.max(0, target - raised),
    archivedAt: (fund && fund.archivedAt) || null,
    createdAt: (fund && fund.createdAt) || null,
    contributions: rows.map(coupleContribution),
  };
};

/** Group the contribution rows by the gift they were towards. */
const byGift = (contributions) => {
  const items = new Map();
  const funds = new Map();
  (Array.isArray(contributions) ? contributions : []).forEach((row) => {
    if (!row) return;
    const bucket = row.item ? items : row.fund ? funds : null;
    if (!bucket) return;
    const key = String(row.item || row.fund);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(row);
  });
  return { items, funds };
};

/**
 * GET /wedding/:id/registry — what the couple's screen reads.
 *
 * `components/plan/views/Registry.js` takes `items`, `funds` and `intro`;
 * `contributionRows()` in money/shared.js walks `item.contributions[]`, which
 * is why the rows are attached to their gift rather than sent as a fourth list.
 */
const couplePayload = ({ website, items = [], funds = [], contributions = [] } = {}) => {
  const grouped = byGift(contributions);
  const registry = (website && website.registry) || {};
  const settled = (Array.isArray(contributions) ? contributions : []).filter((row) => row && row.status === "settled");
  return {
    intro: registry.intro || "",
    layout: registry.layout === "list" ? "list" : "grid",
    slug: (website && website.slug) || "",
    items: items.map((item) => shapeItem(item, grouped.items.get(String(item._id)))),
    funds: funds.map((fund) => shapeFund(fund, grouped.funds.get(String(fund._id)))),
    // The Thank-yous tab's counters, server-side, so two screens cannot count
    // the same list differently.
    thanked: settled.filter((row) => row.thanked).length,
    pending: settled.filter((row) => !row.thanked).length,
  };
};

/* ── the public registry, and the withholding ─────────────────────────────── */

/** A gift as a stranger sees it: what it is, what it costs, how far it has got. */
const publicItem = (item) => ({
  id: id(item && item._id),
  title: (item && item.title) || "",
  image: (item && item.image) || "",
  price: rupees(item && item.price),
  funded: rupees(item && item.funded),
  remaining: Math.max(0, rupees(item && item.price) - rupees(item && item.funded)),
  pinned: Boolean(item && item.pinned),
  contributions: [publicContribution(item && item.funded)],
});

const publicFund = (fund) => ({
  id: id(fund && fund._id),
  title: (fund && fund.title) || "",
  image: (fund && fund.image) || "",
  target: rupees(fund && fund.target),
  raised: rupees(fund && fund.raised),
  funded: rupees(fund && fund.raised),
  remaining: Math.max(0, rupees(fund && fund.target) - rupees(fund && fund.raised)),
  contributions: [publicContribution(fund && fund.raised)],
});

/**
 * GET /registry/:slug — the ONE place the guest's body is built, and the ONE
 * place it can be withheld.
 *
 * ── WHAT IS NEVER IN IT, ON ANY BRANCH ────────────────────────────────────
 * `privacy.password` (the bcrypt hash), any guest's name, phone or note, any
 * contribution id or date, the couple's `thanked` counters, the wedding's
 * guest list, its budget, its payments, or the wallet balance. None of those
 * is stripped afterwards — none of them is ever put in the object.
 *
 * ── PUBLISHED IS NOT REQUIRED ─────────────────────────────────────────────
 * § 05.1: the registry "works on its own — no website needed". So unlike
 * CoupleWebsiteRules.publicPayload this function does NOT withhold on
 * `publishedAt: null`. A registry link resolves on a Website document that has
 * never been published.
 *
 * ── THE PASSWORD IS ─────────────────────────────────────────────────────────
 * When the couple has put a password on their wedding and this request has not
 * proved it, the gifts are withheld and the shell comes back — the same
 * fail-closed discipline as the site. It is ONE condition, in ONE place
 * (`locked`), because it is a product decision someone may want to reverse:
 * see the note in docs/couple-app-api.md § Money.
 *
 * @param {object}  opts.website   the Website document (plain), hash included or not
 * @param {object}  opts.event     the Event document (plain)
 * @param {boolean} opts.unlocked  has this request proved the password?
 * @param {Function} opts.privacyOf  CoupleWebsiteRules.publicPrivacy — injected so
 *                                   the `passwordRequired`-not-the-hash rule has
 *                                   exactly one implementation on this server
 * @param {Function} opts.partnersOf CoupleWebsiteRules.publicPartners, likewise
 */
const publicRegistryPayload = ({
  website,
  event,
  items = [],
  funds = [],
  intro = "",
  unlocked = false,
  gated = false,
  privacyOf,
  partnersOf,
} = {}) => {
  const site = website || {};
  const locked = Boolean(gated) && !unlocked;

  const privacy = typeof privacyOf === "function"
    ? privacyOf(site)
    : { linkOnly: Boolean(site.privacy && site.privacy.linkOnly), passwordRequired: Boolean(gated) };

  const shell = {
    slug: site.slug || "",
    paletteId: site.paletteId || "p1",
    fontId: site.fontId || "f1",
    privacy,
    wedding: {
      city: (event && event.coupleApp && event.coupleApp.city) || "",
      weddingDate: (event && event.eventDate) || "",
      partners: typeof partnersOf === "function" ? partnersOf(event) : [],
    },
  };

  // THE WITHHOLDING. No `items` key, no `funds` key, no `intro` key — not
  // emptied, not nulled: never put in the object.
  if (locked) return shell;

  return {
    ...shell,
    intro: str(intro, MAX_INTRO),
    items: items.map(publicItem),
    funds: funds.map(publicFund),
  };
};

/* ── validation: what the couple may write ────────────────────────────────── */

/** A registry photograph or a source link. http(s) only — never `javascript:`. */
const safeUrl = (raw, max) => {
  const value = str(raw, max || MAX_URL);
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  return value;
};

/** POST /wedding/:id/registry/items — the fields, and why each is refused. */
const itemFields = (body) => {
  const input = isPlainObject(body) ? body : {};
  const fields = {};
  const title = str(input.title, MAX_TITLE);
  if (!title) fields.title = "Give the gift a name.";
  const price = rupees(input.price);
  if (input.price !== undefined && input.price !== null && String(input.price).trim() !== "" && price === 0 && Number(input.price) !== 0) {
    fields.price = "That is not an amount.";
  }
  if (price > MAX_AMOUNT) fields.price = "That is more than we can list — please check the amount.";
  if (Object.keys(fields).length) return validation(fields);
  return {
    ok: true,
    doc: {
      title,
      image: safeUrl(input.image, MAX_URL),
      // Zero is legitimate: § 05.1's "Add & set a price" is a gift with no
      // price yet, not a gift that is free.
      price,
      sourceUrl: safeUrl(input.sourceUrl, MAX_URL),
      source: str(input.source, MAX_TITLE),
      pinned: input.pinned === true,
    },
  };
};

/** POST /wedding/:id/registry/funds. A target of 0 is a fund with no goal yet. */
const fundFields = (body) => {
  const input = isPlainObject(body) ? body : {};
  const fields = {};
  const title = str(input.title, MAX_TITLE);
  if (!title) fields.title = "Give the fund a name.";
  const target = rupees(input.target);
  if (target > MAX_AMOUNT) fields.target = "That is more than we can list — please check the amount.";
  if (Object.keys(fields).length) return validation(fields);
  return { ok: true, doc: { title, image: safeUrl(input.image, MAX_URL), target } };
};

/**
 * PATCH /registry-items/:id and PATCH /registry-funds/:id.
 *
 * A key that was not sent is not touched — a partial patch may only change what
 * it names. `funded`, `raised`, `weddingId`, `archivedAt` and `createdBy` have
 * no branch here at all: the running totals move in the contribution's
 * transaction and nowhere else, which is what keeps them agreeing with the
 * money that produced them.
 */
const patchGift = (body, kind) => {
  const input = isPlainObject(body) ? body : {};
  const set = {};
  const fields = {};

  if (input.title !== undefined) {
    const title = str(input.title, MAX_TITLE);
    if (!title) fields.title = "A gift needs a name.";
    else set.title = title;
  }
  if (input.image !== undefined) set.image = safeUrl(input.image, MAX_URL);
  if (input.sourceUrl !== undefined && kind === "item") set.sourceUrl = safeUrl(input.sourceUrl, MAX_URL);
  if (input.source !== undefined && kind === "item") set.source = str(input.source, MAX_TITLE);

  const amountKey = kind === "fund" ? "target" : "price";
  if (input[amountKey] !== undefined) {
    const value = rupees(input[amountKey]);
    if (value > MAX_AMOUNT) fields[amountKey] = "That is more than we can list — please check the amount.";
    else set[amountKey] = value;
  }
  if (kind === "item" && input.pinned !== undefined) set.pinned = input.pinned === true;

  if (Object.keys(fields).length) return validation(fields);
  if (!Object.keys(set).length) return validation({}, "There was nothing to change.");
  return { ok: true, set };
};

/** PATCH /wedding/:id/registry { intro } — § 05.1's "A note from the couple". */
const introPatch = (body) => {
  const input = isPlainObject(body) ? body : {};
  if (input.intro === undefined && input.layout === undefined) {
    return validation({ intro: "There was nothing to save." });
  }
  const set = {};
  if (input.intro !== undefined) set["registry.intro"] = str(input.intro, MAX_INTRO);
  if (input.layout !== undefined) set["registry.layout"] = input.layout === "list" ? "list" : "grid";
  return { ok: true, set };
};

/** PATCH /contributions/:id { thanked } — the couple thanks PEOPLE, not rows. */
const thankedPatch = (body, now) => {
  const input = isPlainObject(body) ? body : {};
  if (input.thanked === undefined) return validation({ thanked: "Say whether they have been thanked." });
  const thanked = input.thanked === true;
  return { ok: true, set: { thanked, thankedAt: thanked ? now || new Date() : null } };
};

/**
 * A DELETE that must not orphan money.
 *
 * Once a guest has given against a gift, their Contribution points at it and
 * the row must survive: `archivedAt` retires it from the wishlist and leaves
 * the thank-you readable. A gift nobody has given towards is simply removed.
 */
const removalOf = (gift) => {
  const received = rupees(gift && (gift.funded !== undefined ? gift.funded : gift.raised));
  return received > 0 ? "archive" : "delete";
};

/* ── the reserve decision (the race, as arithmetic) ───────────────────────── */

/**
 * "Pay in full", judged against ONE snapshot of a gift.
 *
 * This is the whole 409 race, as a pure function. The service calls it twice:
 * once on the row it read (so a hopeless request is refused before anything is
 * touched), and once on the PRE-IMAGE the conditional update actually matched —
 * which is the only honest source for "what was left". The arithmetic itself is
 * CoupleWalletService.contributionAmount; nothing is re-derived here.
 *
 * @returns {{ok:true, price:number, amount:number} | {ok:false, refusal:object}}
 */
const fullReserve = (gift) => {
  const price = rupees(gift && gift.price);
  if (price <= 0) {
    return {
      ok: false,
      refusal: validation({ amount: "This gift does not have a price yet — chip in whatever you like instead." }),
    };
  }
  const amount = wallet.contributionAmount(gift, "full");
  // Zero left means somebody got there first. Not an error to retry: a 409 the
  // client renders as "this one has just been taken in full".
  if (amount <= 0) return { ok: false, refusal: alreadyFunded(gift) };
  return { ok: true, price, amount };
};

/**
 * "Chip in part", judged against one snapshot.
 *
 * A PRICED item may not be over-funded — the couple asked for one lamp, not
 * one and a half. An item with no price yet is an open-ended ask and has no
 * ceiling to break. A FUND never reaches this function: § 06.1 is explicit
 * that money past a fund's target is still welcome, so a fund is not capped at
 * all.
 */
const partReserve = (gift, asked) => {
  const amount = rupees(asked);
  if (amount <= 0) return { ok: false, refusal: validation({ amount: "How much would you like to give?" }) };

  const price = rupees(gift && gift.price);
  if (price <= 0) return { ok: true, amount, capped: false };

  const funded = rupees(gift && gift.funded);
  const remaining = Math.max(0, price - funded);
  if (remaining <= 0) return { ok: false, refusal: alreadyFunded(gift) };
  if (amount > remaining) {
    const shown = `₹${remaining.toLocaleString("en-IN")}`;
    return {
      ok: false,
      refusal: validation({ amount: `Only ${shown} is left on this one.` }, "That is more than is left on this gift."),
    };
  }
  return { ok: true, amount, capped: true };
};

/* ── validation: what a GUEST may send ────────────────────────────────────── */

/**
 * POST /registry/:slug/contribute.
 *
 * Note what is NOT trusted here: the amount for `mode: "full"`. It is validated
 * for shape and then thrown away — CoupleWalletService.contributionAmount
 * re-derives it from the gift's own price and its own running total, so two
 * guests choosing "in full" at the same moment cannot both succeed.
 */
const contributionFields = (body) => {
  const input = isPlainObject(body) ? body : {};
  const guest = isPlainObject(input.guest) ? input.guest : {};
  const fields = {};

  const itemId = id(input.itemId) || "";
  const fundId = id(input.fundId) || "";
  if (!itemId && !fundId) fields.gift = "Choose something to give towards.";
  if (itemId && fundId) fields.gift = "Choose one gift, not two.";

  const mode = CONTRIBUTION_MODE.indexOf(input.mode) === -1 ? "" : input.mode;
  if (!mode) fields.mode = "Choose whether you are giving in full or chipping in.";
  // A fund has no "in full": it is a goal, and every gift towards it is a part.
  const effectiveMode = fundId ? "part" : mode;

  const name = str(guest.name, MAX_NAME);
  if (!name) fields.name = "Please leave your name, so they know who to thank.";

  const phone = str(guest.phone, MAX_PHONE);
  if (phone && !/^[+0-9][0-9 ()-]{5,}$/.test(phone)) fields.phone = "That does not look like a phone number.";

  const asked = rupees(input.amount);
  if (effectiveMode === "part") {
    if (asked <= 0) fields.amount = "How much would you like to give?";
    else if (asked > MAX_AMOUNT) fields.amount = "That is a very large amount — please check it.";
  }

  if (Object.keys(fields).length) return validation(fields);

  return {
    ok: true,
    gift: { itemId, fundId, giftType: itemId ? "item" : "fund" },
    mode: effectiveMode,
    asked,
    guest: { name, phone, note: str(guest.note, MAX_NOTE) },
  };
};

/* ── the wallet ───────────────────────────────────────────────────────────── */

/**
 * Money that is out of the door but has not landed: a claim on its way to the
 * bank, or a debit reserved against a payment intent that has not settled.
 *
 * ── WHY THIS EXISTS, HONESTLY ─────────────────────────────────────────────
 * CoupleWalletService.balance() counts SETTLED rows only, and
 * CoupleWalletService.claimWrite() writes a claim as `pending`. Read together,
 * a pending claim does not reduce the balance — so a couple could request the
 * same ₹50,000 twice while the first request is still in flight, and the
 * ledger would agree with both.
 *
 * This function does not change the ledger's arithmetic and does not
 * reimplement it: `balance` is still balance, and every amount here goes
 * through the ledger's own `money`. It computes a second, narrower figure —
 * what is SPENDABLE right now — and that is the number handed to `claimWrite`
 * and to `applyWallet`. The balance the couple is shown is still `balance()`.
 */
const pendingOutflow = (txns) =>
  (Array.isArray(txns) ? txns : []).reduce((total, txn) => {
    if (!txn || txn.status !== "pending") return total;
    return wallet.signOf(txn) < 0 ? total + rupees(txn.amount) : total;
  }, 0);

const spendable = (txns) => Math.max(0, wallet.balance(txns) - pendingOutflow(txns));

/** One ledger line, as § 05.1's wallet strip reads it. */
const shapeTxn = (txn) => ({
  id: id(txn && txn._id),
  type: (txn && txn.type) || "credit",
  amount: rupees(txn && txn.amount),
  status: (txn && txn.status) || "settled",
  label: (txn && txn.label) || "",
  ref: (txn && txn.ref) || "",
  createdAt: (txn && txn.createdAt) || null,
  settledAt: (txn && txn.settledAt) || null,
});

/**
 * GET /wedding/:id/wallet.
 *
 * Every figure is derived from the rows in this call. There is no stored
 * balance to disagree with them.
 */
const walletPayload = (txns) => {
  const rows = Array.isArray(txns) ? txns : [];
  let credited = 0;
  let claimed = 0;
  rows.forEach((txn) => {
    if (!wallet.isSettled(txn)) return;
    const sign = wallet.signOf(txn);
    if (sign > 0) credited += rupees(txn.amount);
    else if (sign < 0) claimed += rupees(txn.amount);
  });
  return {
    balance: wallet.balance(rows),
    spendable: spendable(rows),
    credited,
    claimed,
    pending: pendingOutflow(rows),
    transactions: rows.map(shapeTxn),
  };
};

/* ── payments ─────────────────────────────────────────────────────────────── */

/** What is still owed on a row. `amountDue` when it is kept; the difference otherwise. */
const outstanding = (payment) => {
  const row = payment || {};
  const total = rupees(row.amount);
  const paid = rupees(row.amountPaid);
  const due = row.amountDue === undefined || row.amountDue === null ? total - paid : rupees(row.amountDue);
  return Math.max(0, Math.min(total, due));
};

/** § 06.1's couple-facing PaymentStatus — "due" | "paid" — over the gateway's own enum. */
const paymentState = (payment) => {
  const row = payment || {};
  if (row.status === "paid") return "paid";
  return outstanding(row) <= 0 && rupees(row.amountPaid) > 0 ? "paid" : "due";
};

/** GET /wedding/:id/payments — one row, in the client's vocabulary. */
const shapePayment = (payment) => {
  const row = payment || {};
  const couple = row.coupleApp || {};
  return {
    id: id(row._id),
    label: couple.label || "Payment",
    vendor: couple.vendor || "",
    ref: couple.ref || row.razporPayId || "",
    amount: rupees(row.amount),
    outstanding: outstanding(row),
    dueDate: couple.dueDate || null,
    status: paymentState(row),
    paidAt: row.status === "paid" ? row.updatedAt || null : null,
    method: row.paymentMethod && row.paymentMethod !== "default" ? row.paymentMethod : "",
    walletApplied: rupees(couple.walletApplied),
  };
};

/**
 * THE PAY BODY, AND THE REASON THIS FUNCTION EXISTS.
 *
 * § 06.2's contract is `{ method, useWallet }`. This emits those two keys and
 * NOTHING ELSE — an `amount`, a `walletApplied` or a `gatewayAmount` in the
 * request body reaches no variable, because there is no variable for it. The
 * offset is then computed by CoupleWalletService.applyWallet, whose signature
 * has no parameter one could arrive in either.
 *
 * `useWallet` is compared with `=== true`: the string "false" is truthy in
 * JavaScript and would otherwise spend the couple's gift money because a form
 * serialised a checkbox as text.
 */
const METHODS = ["upi", "card", "netbanking", "emi"];

const payBody = (body) => {
  const input = isPlainObject(body) ? body : {};
  const method = String(input.method === undefined || input.method === null ? "" : input.method).trim().toLowerCase();
  return {
    method: METHODS.indexOf(method) === -1 ? "upi" : method,
    useWallet: input.useWallet === true,
  };
};

module.exports = {
  // limits
  MAX_TITLE, MAX_NOTE, MAX_INTRO, MAX_URL, MAX_AMOUNT, METHODS,
  // refusals
  validation, notFound, alreadyFunded,
  // shaping — couple
  coupleContribution, shapeItem, shapeFund, byGift, couplePayload,
  // shaping — public
  publicContribution, publicItem, publicFund, publicRegistryPayload,
  // validation
  safeUrl, itemFields, fundFields, patchGift, introPatch, thankedPatch, removalOf,
  contributionFields, fullReserve, partReserve,
  // wallet
  pendingOutflow, spendable, shapeTxn, walletPayload,
  // payments
  outstanding, paymentState, shapePayment, payBody,
};
