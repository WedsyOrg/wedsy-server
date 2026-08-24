/**
 * utils/venuePaymentEntries.js — turning a milestone's money into a LIST.
 *
 * ── THE TRAP THIS EXISTS TO CLOSE ───────────────────────────────────────────
 * utils/venuePaymentStatus reads a row's entries when it has any, and falls
 * back to the legacy `paidAmount` scalar only when it has none. That fallback
 * is what lets the migration be a cleanup rather than a prerequisite.
 *
 * But it has a sharp edge: the moment a row gains its FIRST entry, the legacy
 * scalar stops being read. So recording a ₹10,000 payment against an
 * un-migrated row that already held ₹50,000 would take the row from ₹50,000
 * received to ₹10,000 — money vanishing at the exact moment somebody records
 * more of it, which is the worst possible time for it to happen.
 *
 * So nothing may push an entry onto a row without converting it first, and
 * both the writer and the migration go through the SAME function here rather
 * than each doing "roughly that" — the two drifting is how the migration ends
 * up producing a different history than the live path.
 */

/**
 * Convert a legacy row IN PLACE so its money lives in `entries`. Idempotent:
 * a row that already has entries, or one that never had any money, is left
 * exactly as it is and reports false.
 *
 * The legacy scalar is zeroed rather than deleted — see the schema note. It is
 * no longer read once entries exist, and keeping the field present means an
 * older process reading the document still sees a coherent (if stale) number
 * instead of `undefined`.
 *
 * @returns {boolean} whether it converted anything
 */
function convertLegacyRow(row, { now = new Date() } = {}) {
  if (!row) return false;
  const entries = row.entries || [];
  if (entries.length > 0) return false;
  const legacy = Math.round(Number(row.paidAmount) || 0);
  if (legacy <= 0) return false;

  const entry = {
    amount: legacy,
    // The date the money arrived if the row remembers one. Falling back to
    // `now` would date every historical payment to the migration run, which
    // would make the payment history a lie in a way nobody could later undo.
    date: row.paidAt || null,
    method: row.paidMode || "",
    methodOther: row.paidModeOther || "",
    reference: row.paidReference || "",
    note: row.paidNote || "",
    proofUrl: "",
    // Approved, and accurately so rather than merely conveniently: with zero
    // team members on production, every one of these was recorded by an owner,
    // and an owner's own entry is auto-approved under the S3 rules too.
    status: "approved",
    recordedBy: row.recordedBy || null,
    recordedByName: row.recordedByName || "",
    approvedByName: row.recordedByName || "",
    approvedAt: row.paidAt || now,
  };
  if (!entry.date) entry.date = row.dueDate || now;

  if (typeof row.entries === "object" && typeof row.entries.push === "function") row.entries.push(entry);
  else row.entries = [entry];
  row.paidAmount = 0;
  return true;
}

/**
 * Add a payment to a milestone, converting it first if it is still legacy.
 * Returns the entry as stored.
 */
function addEntry(row, entry) {
  convertLegacyRow(row);
  const next = {
    amount: Math.round(Number(entry.amount) || 0),
    date: entry.date || new Date(),
    method: entry.method || "",
    methodOther: entry.methodOther || "",
    reference: entry.reference || "",
    note: entry.note || "",
    proofUrl: entry.proofUrl || "",
    status: entry.status || "approved",
    recordedBy: entry.recordedBy || null,
    recordedByName: entry.recordedByName || "",
  };
  if (next.status === "approved") {
    next.approvedBy = entry.approvedBy || entry.recordedBy || null;
    next.approvedByName = entry.approvedByName || entry.recordedByName || "";
    next.approvedAt = entry.approvedAt || new Date();
  }
  if (typeof row.entries === "object" && typeof row.entries.push === "function") row.entries.push(next);
  else row.entries = [next];
  return next;
}

module.exports = { convertLegacyRow, addEntry };
