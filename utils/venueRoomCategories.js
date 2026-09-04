/**
 * utils/venueRoomCategories.js — the room categories a booking can allocate
 * from, and the validator the confirm wizard's rooms step runs through.
 *
 * BOOKING 3, founder ruling: wedding resorts run ONE EVENT AT A TIME. Rooms
 * come with the event — no availability question, no hold, no block, no
 * refusal. The allocation is a RECORD (how many of each category the couple
 * gets), so the only validation is arithmetic: a count may not exceed the
 * category's total, because the ceiling is a fact about the property, not a
 * booking-state question. Deliberately NOT wired to the held-nights path.
 *
 * Categories come from the venue's OPERATIONAL roomTypes (top-level — never
 * the derived accommodation.roomTypes projection) with each total counted
 * from the venue's ACTIVE real rooms. Untyped rooms (typeRef null) form one
 * "Rooms" category so a venue that never set up types can still record.
 */

/** @returns [{ typeRef: string|null, name: string, total: number }] */
function roomCategories(venue) {
  const rooms = ((venue && venue.rooms) || []).filter((r) => r && r.isActive !== false);
  const types = (venue && venue.roomTypes) || [];
  const out = [];
  for (const t of types) {
    const total = rooms.filter((r) => String(r.typeRef || "") === String(t._id)).length;
    if (total > 0) out.push({ typeRef: String(t._id), name: t.name, total });
  }
  const untyped = rooms.filter((r) => !r.typeRef).length;
  if (untyped > 0) out.push({ typeRef: null, name: types.length ? "Other rooms" : "Rooms", total: untyped });
  return out;
}

/**
 * Validate + snapshot the wizard's rooms payload.
 * body: { mode: "all" } | { mode: "counts", counts: [{ typeRef, count }] }
 * @returns {{ok:true, value:object|null} | {ok:false, message:string}}
 */
function checkRoomsAllocation(body, venue) {
  if (body === undefined || body === null) return { ok: true, value: null }; // skipped — record nothing
  const categories = roomCategories(venue);
  if (!categories.length) {
    return { ok: false, message: "This venue has no rooms set up — add rooms in the Rooms page, or skip this step." };
  }
  const mode = body.mode;
  if (mode === "all") {
    return {
      ok: true,
      value: { mode: "all", items: categories.map((c) => ({ typeRef: c.typeRef, name: c.name, count: c.total, total: c.total })), recordedAt: new Date() },
    };
  }
  if (mode !== "counts") return { ok: false, message: 'roomsAllocation.mode must be "all" or "counts"' };
  const rows = Array.isArray(body.counts) ? body.counts : [];
  const items = [];
  for (const row of rows) {
    const cat = categories.find((c) => String(c.typeRef) === String(row && row.typeRef));
    if (!cat) return { ok: false, message: "That room category is not on this venue — pick from the list shown." };
    const count = Math.round(Number(row.count));
    if (!Number.isFinite(count) || count < 0) return { ok: false, message: `${cat.name}: the room count must be 0 or more.` };
    if (count > cat.total) {
      return { ok: false, message: `${cat.name}: the venue has ${cat.total} — ${count} cannot be allocated. Lower the count or pick "all rooms".` };
    }
    if (count > 0) items.push({ typeRef: cat.typeRef, name: cat.name, count, total: cat.total });
  }
  if (!items.length) return { ok: true, value: null }; // all zeros = nothing recorded
  return { ok: true, value: { mode: "counts", items, recordedAt: new Date() } };
}

module.exports = { roomCategories, checkRoomsAllocation };
