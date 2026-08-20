/**
 * THE PAYMENT-METHOD VOCABULARY, in one place.
 *
 * A token IS a payment. It was being described differently from every other
 * payment anyway: the confirm path took `tokenMode` as free text and then
 * pattern-matched it against the milestone enum —
 *
 *     ["bank_transfer","cash","cheque","upi","card"].includes(
 *       mode.toLowerCase().replace(/\s+/g, "_")) ? ... : ""
 *
 * — so anything outside the list ("Gpay", "paytm", "NEFT") fell through to the
 * empty string and the owner's answer was thrown away without a word. The
 * booking then showed a token with no method against it, which is the one
 * detail anyone asks about later.
 *
 * Keeping the list here, next to the normaliser that enforces it, is what
 * stops the controller's copy and the schema's copy drifting apart — they
 * already had, which is how "other" could be offered by a UI that the schema
 * would then reject.
 */

/** Must stay identical to the paidMode enum in models/VenueBooking.js. */
const PAYMENT_MODES = ["bank_transfer", "cash", "cheque", "upi", "card", "other"];

/**
 * Accepts what a human or an older client might send ("Bank Transfer", "UPI",
 * "bank transfer") and returns the stored form, or null if it is not a method
 * we know. Null is a REFUSAL, not a default — silently returning "" is exactly
 * the bug this replaces.
 *
 * An empty/absent value is legitimate (no method stated) and returns "".
 */
function normaliseMode(value) {
  if (value === undefined || value === null) return "";
  const v = String(value).trim().toLowerCase().replace(/\s+/g, "_");
  if (!v) return "";
  return PAYMENT_MODES.includes(v) ? v : null;
}

/**
 * How each mode is written for a human. The STORED value is the enum key;
 * anything a person reads goes through here, so a token does not end up
 * labelled "Token — received (upi)" or "(bank_transfer)".
 */
const MODE_LABEL = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  upi: "UPI",
  card: "Card",
  other: "Other",
};

/** `other` reads as the name the owner gave it — "(Other)" says nothing. */
function modeLabel(mode, other) {
  if (!mode) return "";
  if (mode === "other") return (other || "").trim() || "Other";
  return MODE_LABEL[mode] || mode;
}

module.exports = { PAYMENT_MODES, MODE_LABEL, normaliseMode, modeLabel };
