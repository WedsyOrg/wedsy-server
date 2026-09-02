/**
 * utils/venueBookingCharges.js — the venue's standing charges: the things it
 * bills beside the venue amount, defined once in Settings and picked from on
 * the Money tab.
 *
 * ── THE AMENITY PATTERN, WITH ONE RULED DIFFERENCE ──────────────────────────
 * Modelled the way roomAmenities is modelled (utils/venueRoomTypes): a seed
 * catalogue as a CONST — never a master list in the database — copied into the
 * venue's own list additively and idempotently, with whatever the owner adds
 * afterwards being THEIRS, never promoted anywhere.
 *
 * The difference is deletion, and it is a ruling, not a drift: a charge can be
 * DELETED from Settings even while quotes use it. Amenities RETIRE when in use
 * because types and rooms hold the amenity's KEY — a reference that must keep
 * resolving. A charge line holds a COPY: label, amount, treatment and flag are
 * written onto the line at pick time and nothing ever reads back through the
 * key. Deleting the setting can orphan nothing, so there is no isActive here
 * and no retirement path — and tests/venue-money-lines assert the field's
 * absence, so "making this consistent with amenities" fails a suite before it
 * ships. If you are adding retirement, first find what reference made it
 * necessary; there isn't one.
 *
 * ── WHAT A CHARGE CARRIES ───────────────────────────────────────────────────
 * label, defaultAmount, GST treatment, refundable — the same four facts a
 * quote line carries, because a charge IS a pre-filled line. The treatments:
 *   none — no GST on this line
 *   full — GST on the whole amount
 *   part — GST on `taxableAmount`, which must be less than the amount
 * A REFUNDABLE charge (the security deposit) is held and returned: it sits
 * inside the document total but never in revenue. A NON-refundable "deposit"
 * is an ordinary charge with a confusing name — nothing here treats it
 * specially, on purpose.
 */

const GST_TREATMENTS = ["none", "full", "part"];

/**
 * The starting set. Enough to prompt with — an owner adds their own beyond it.
 * Amounts are venue facts, so seeds carry none (0 = "set yours"); the security
 * deposit is the one refundable seed, which is the whole reason the flag exists.
 */
const DEFAULT_BOOKING_CHARGES = [
  { key: "cleaning_charge", label: "Cleaning charge", refundable: false },
  { key: "security_deposit", label: "Security deposit", refundable: true },
  { key: "generator_charges", label: "Generator charges", refundable: false },
  { key: "lighting_charge", label: "Lighting charge", refundable: false },
];

/** Machine key from a label. Same derivation as amenity keys: stable, lossy. */
function chargeKeyFor(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * Validate the money shape shared by a SETTINGS entry and a QUOTE LINE:
 * amount, treatment, taxableAmount, refundable. One implementation, because a
 * charge that saves must be a line that computes — the slab module's rule.
 *
 * @returns {{ ok: true, value: {amount, gstTreatment, taxableAmount, refundable} }
 *          | { ok: false, message: string }}
 */
function checkChargeMoney({ amount, gstTreatment, taxableAmount, refundable }, where) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return { ok: false, message: `${where}: amount must be a number ≥ 0` };
  const rupees = Math.round(amt);

  const treatment = String(gstTreatment || "none");
  if (!GST_TREATMENTS.includes(treatment)) {
    return { ok: false, message: `${where}: GST treatment must be one of ${GST_TREATMENTS.join(", ")}` };
  }
  // ── HELD MONEY IS NEVER TAXED ─────────────────────────────────────────────
  // The invariant says refundable is excluded from every GST base, but until
  // this guard nothing REFUSED a refundable line carrying a treatment — and
  // computeLineTotals taxes by treatment, so such a line would have taxed
  // held money. No UI can produce the combination; the API could. Closed at
  // the one validator both quote paths share (found by the document-system
  // build, which asserts the invariant on rendered bytes).
  if (refundable && treatment !== "none") {
    return { ok: false, message: `${where}: a refundable line is held, never taxed — its GST treatment must be "none"` };
  }

  let taxable = 0;
  if (treatment === "part") {
    const t = Number(taxableAmount);
    if (!Number.isFinite(t)) return { ok: false, message: `${where}: GST on part needs a taxable amount` };
    taxable = Math.round(t);
    // Strictly inside the amount: "part" of 0 is nothing, and a taxable amount
    // equal to the line is "full" — offering both spellings of the same fact
    // is how two rows that mean the same thing stop matching each other.
    if (taxable <= 0) return { ok: false, message: `${where}: the taxable amount must be more than 0` };
    if (taxable >= rupees) {
      return { ok: false, message: `${where}: the taxable amount must be less than the line's amount — use "full" for GST on all of it` };
    }
  } else if (taxableAmount !== undefined && taxableAmount !== null && Number(taxableAmount) !== 0) {
    return { ok: false, message: `${where}: a taxable amount only goes with GST on part` };
  }

  return { ok: true, value: { amount: rupees, gstTreatment: treatment, taxableAmount: taxable, refundable: Boolean(refundable) } };
}

/**
 * The list as every response carries it — one presenter so no endpoint can
 * return a differently-shaped row (the amenity lesson: five write endpoints
 * returned bare arrays and the screen lost its annotations on every write).
 * Creation order is kept: a list an owner has arranged should stay arranged.
 */
function presentCharges(venue) {
  return (venue.bookingCharges || []).map((c) => ({
    key: c.key,
    label: c.label,
    defaultAmount: c.defaultAmount || 0,
    gstTreatment: c.gstTreatment || "none",
    taxableAmount: c.taxableAmount || 0,
    refundable: Boolean(c.refundable),
  }));
}

/** Seed entries this venue has not added yet — the picker's suggestion row. */
function chargeSuggestions(venue) {
  const have = new Set((venue.bookingCharges || []).map((c) => String(c.key)));
  return DEFAULT_BOOKING_CHARGES.filter((d) => !have.has(d.key));
}

module.exports = {
  DEFAULT_BOOKING_CHARGES,
  GST_TREATMENTS,
  chargeKeyFor,
  checkChargeMoney,
  presentCharges,
  chargeSuggestions,
};
