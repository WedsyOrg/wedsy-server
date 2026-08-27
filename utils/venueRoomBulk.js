/**
 * utils/venueRoomBulk.js — expand a bulk room request into names, and say what
 * would collide, without touching the database.
 *
 * Separated from the controller so the PREVIEW and the APPLY are the same
 * computation. If they were two code paths, the preview an owner approves and
 * the batch that runs could disagree — which is exactly the kind of difference
 * nobody notices until a room is missing.
 */

const MAX_BATCH = 200;

/** Trim + casefold, matching how addRoom collides a single name. */
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

/**
 * A range like 101→110, or 007→012 with the padding kept.
 *
 * `from` is read as a STRING first so "007" can carry its own width. Reading it
 * as a number would silently produce 7, 8, 9, 10 for a venue whose rooms are
 * genuinely called 007 and 008.
 */
function expandRange({ prefix = "", from, to, suffix = "", pad }) {
  const rawFrom = String(from == null ? "" : from).trim();
  const rawTo = String(to == null ? "" : to).trim();
  if (!/^\d+$/.test(rawFrom) || !/^\d+$/.test(rawTo)) {
    return { error: "Give a numeric range, like 101 to 110." };
  }
  const start = Number(rawFrom);
  const end = Number(rawTo);
  if (end < start) return { error: `The range runs backwards: ${rawFrom} to ${rawTo}.` };
  const count = end - start + 1;
  if (count > MAX_BATCH) {
    return { error: `That is ${count} rooms in one go. Do it in batches of ${MAX_BATCH} or fewer.` };
  }
  const width = pad != null ? Number(pad) : (rawFrom.length > 1 && rawFrom.startsWith("0") ? rawFrom.length : 0);
  const names = [];
  for (let n = start; n <= end; n += 1) {
    const digits = width ? String(n).padStart(width, "0") : String(n);
    names.push(`${prefix}${digits}${suffix}`.trim());
  }
  return { names };
}

/** An explicit list — "Lakeview Cottage, Rose Cottage" or a JSON array. */
function expandList(raw) {
  const items = Array.isArray(raw) ? raw : String(raw || "").split(/[\n,]/);
  const names = items.map((s) => String(s).trim()).filter(Boolean);
  if (!names.length) return { error: "No room names given." };
  if (names.length > MAX_BATCH) {
    return { error: `That is ${names.length} rooms in one go. Do it in batches of ${MAX_BATCH} or fewer.` };
  }
  return { names };
}

function expand(body) {
  if (body.names !== undefined) return expandList(body.names);
  if (body.from !== undefined || body.to !== undefined) return expandRange(body);
  return { error: "Give either a range (from/to) or a list of names." };
}

/**
 * Classify every requested name against what the venue already holds and
 * against the rest of the batch.
 *
 * Collides against INACTIVE rooms too. A deactivated "105" still owns that
 * name; creating a second one leaves the venue with two rooms called 105, one
 * of them invisible — and the owner reasonably reading "105" on a runsheet has
 * no way to know which.
 */
/**
 * ── WHERE A CLASHING ROOM ACTUALLY IS ────────────────────────────────────────
 * "201 already exists" is the START of the owner's question, not the end of it.
 * The obvious next one is "then where is it, and how do I get it where I
 * want it?" — and this plan used to answer neither, because it only ever
 * reported the NAME.
 *
 * Each skip now carries the clash's id and its placement, so the screen can say
 * "201 is already in Block A, with no floor" and offer to MOVE it here instead
 * of dead-ending. That is the whole of the founder's Crown Estate case: four
 * rooms bulk-created with the floor left at its default, rendering under a bare
 * strip, refusing to be added to First with a message that told the owner
 * nothing they could act on.
 *
 * `alreadyHere` is true when the clash is already exactly where this batch is
 * trying to put it — then there is nothing to move and the screen should say
 * "they're already here" rather than offer a no-op.
 */
function whereIs(venue, room) {
  const blocks = venue.blocks || [];
  const b = blocks.find((x) => String(x._id) === String(room.blockRef || ""));
  if (!b) return { blockRef: null, floorRef: null, label: "not placed anywhere yet" };
  const f = (b.floors || []).find((x) => String(x._id) === String(room.floorRef || ""));
  if (f) return { blockRef: String(b._id), floorRef: String(f._id), label: `${b.name} · ${f.name}` };
  return { blockRef: String(b._id), floorRef: null, label: `${b.name}, on no floor` };
}

function planBulk(venue, names, target = {}) {
  const taken = new Map();
  for (const r of venue.rooms || []) {
    taken.set(norm(r.name), r);
  }
  const create = [];
  const skip = [];
  const seen = new Set();
  const tBlock = target.blockRef ? String(target.blockRef) : null;
  const tFloor = target.floorRef ? String(target.floorRef) : null;
  for (const name of names) {
    const key = norm(name);
    if (!key) continue;
    const clash = taken.get(key);
    if (clash) {
      const at = whereIs(venue, clash);
      const alreadyHere = at.blockRef === tBlock && at.floorRef === tFloor;
      skip.push({
        name,
        reason: clash.isActive === false ? "exists_inactive" : "exists",
        message: clash.isActive === false
          ? `"${clash.name}" already exists but is switched off.`
          : `"${clash.name}" already exists.`,
        // What the screen needs to offer a MOVE rather than a dead end.
        roomId: String(clash._id),
        isActive: clash.isActive !== false,
        at,
        alreadyHere,
      });
      continue;
    }
    if (seen.has(key)) {
      skip.push({ name, reason: "duplicate_in_batch", message: `"${name}" is listed twice in this batch.` });
      continue;
    }
    seen.add(key);
    create.push(name);
  }
  return { create, skip };
}

module.exports = { MAX_BATCH, expand, expandRange, expandList, planBulk, whereIs, norm };
