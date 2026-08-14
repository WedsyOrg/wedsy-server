/**
 * utils/venueCoupleName.js — the ONE place VenueEnquiry.coupleName is computed.
 *
 * ── WHY THIS IS NOT A REFACTOR ───────────────────────────────────────────────
 * `coupleName` is read in ~60 files: the leads list, search, DEDUP, the lead
 * header, WhatsApp sends, quote/invoice/contract PDFs, the couple-facing site,
 * the OS venue department, bookings, allotments, the day view, the demand map.
 * The tidy change — delete it, compose a name from contacts at every read —
 * would have touched every one of those and broken most of them, because
 * several are Mongo-level (sort, regex search, `.select()`) and cannot call a
 * JavaScript helper at all.
 *
 * So the field STAYS, exactly as it is, a stored String. What changes is only
 * WHO WRITES IT. Every consumer is untouched by construction.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *   1. A manual name always wins. If a human typed something here, that is the
 *      name — "The Mehra Wedding" beats anything we can assemble. Recorded by
 *      the `coupleNameManual` flag, and it is sticky: once set, derivation
 *      never touches the row again until the override is explicitly cleared.
 *   2. Otherwise, bride + groom if both relations exist ("Priya & Arjun").
 *   3. Otherwise, whichever single one exists.
 *   4. Otherwise the primary contact's name.
 *   5. Otherwise whatever the lead was already called — NEVER "".
 *
 * Step 5 is load-bearing. A lead with no usable contacts must keep its existing
 * name rather than be blanked, because a blank name is what makes a row
 * unfindable in the list, unsearchable, and anonymous in a WhatsApp thread.
 * Derivation is allowed to improve a name; it is never allowed to remove one.
 *
 * ── CORPORATE ────────────────────────────────────────────────────────────────
 * There is no bride and no groom, so steps 2-3 never fire and the name falls
 * through to the primary contact or the existing name — which is exactly right:
 * a corporate lead is called by its company/event name, and that is what was
 * typed into the form.
 */
const AMP = " & ";

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/** First contact with this relation that actually has a name. */
function named(contacts, relation) {
  const hit = (contacts || []).find((c) => c && c.relation === relation && clean(c.name));
  return hit ? clean(hit.name) : "";
}

/**
 * Compute the name a lead SHOULD have, ignoring the manual override.
 * Returns "" only when there is genuinely nothing to say, so callers can tell
 * "no derivation available" from "derived to empty".
 */
function deriveCoupleName(contacts) {
  const bride = named(contacts, "bride");
  const groom = named(contacts, "groom");
  // Bride first — it is how these are written and said aloud in the market
  // this serves, and a stable order matters more than which one wins.
  if (bride && groom) return `${bride}${AMP}${groom}`;
  if (bride) return bride;
  if (groom) return groom;

  const primary = (contacts || []).find((c) => c && c.isPrimary && clean(c.name));
  if (primary) return clean(primary.name);

  const anyNamed = (contacts || []).find((c) => c && clean(c.name));
  return anyNamed ? clean(anyNamed.name) : "";
}

/**
 * Apply the rule to a lead document, in place. Returns the name it settled on.
 *
 * Call this after ANY write that could change contacts or the name. It is
 * idempotent and safe to call when nothing changed.
 *
 * @param {object} enquiry  a mongoose doc or plain object
 * @param {object} [opts]
 * @param {boolean} [opts.force]  recompute even if the override is set
 *                                (used only by the migration's --apply path)
 */
function applyCoupleName(enquiry, opts = {}) {
  if (!enquiry) return "";
  const current = clean(enquiry.coupleName);

  // Rule 1 — a human's name is final.
  if (enquiry.coupleNameManual === true && !opts.force) return current;

  const derived = deriveCoupleName(enquiry.contacts);
  // Rule 5 — never blank an existing name.
  const next = derived || current || clean(enquiry.name);
  if (next && next !== current) enquiry.coupleName = next;
  return clean(enquiry.coupleName);
}

/**
 * Record that a human typed the name. Setting a non-empty name locks it;
 * clearing it unlocks and hands the row back to the derivation, which is how
 * "actually, just use the couple's names" is expressed.
 */
function setManualCoupleName(enquiry, raw) {
  const v = clean(raw);
  if (v) {
    enquiry.coupleName = v;
    enquiry.coupleNameManual = true;
  } else {
    enquiry.coupleNameManual = false;
    applyCoupleName(enquiry);
  }
  return clean(enquiry.coupleName);
}

module.exports = { deriveCoupleName, applyCoupleName, setManualCoupleName };
