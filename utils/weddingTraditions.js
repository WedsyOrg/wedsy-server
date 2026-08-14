/**
 * utils/weddingTraditions.js — the community-calendar axis.
 *
 * TRADITION IS NOT REGION, and the two must never be collapsed. Region is a
 * PLACE (where the venue is, which state's holidays its guests get). Tradition
 * is a COMMUNITY CALENDAR (whose panchang says the date is auspicious). The
 * same Bangalore venue serves North Indian and South Indian weddings on the
 * same lawn, so a Bangalore-region date can be auspicious for one tradition,
 * both, or neither. Storing them as one field would make that unrepresentable.
 *
 * TWO LEVELS, ONE ENUM. The top level (north_indian / south_indian) is what the
 * seed data actually distinguishes today. The sub-values exist NOW so finer
 * data — a date that is auspicious for Tamil but not Telugu weddings — can be
 * entered later without a migration. A sub-value implies its parent: a row
 * tagged `tamil` answers yes to "auspicious for South Indian weddings",
 * because it is one.
 *
 * EMPTY MEANS UNSPECIFIED, AND UNSPECIFIED APPLIES TO EVERYONE. Same shape as
 * region=null meaning national: a row with no traditions is a date somebody
 * recorded without saying whose calendar it came from, and the honest reading
 * of that is "it applies unless we learn otherwise" — not "it applies to
 * nobody", which would silently drop the broader-list dates the seed carries.
 */

const PARENTS = ["north_indian", "south_indian"];

// child → parent. Every child resolves to exactly one parent.
const TRADITION_PARENT = {
  punjabi: "north_indian",
  gujarati: "north_indian",
  marwari: "north_indian",
  delhi: "north_indian",
  kannada: "south_indian",
  tamil: "south_indian",
  telugu: "south_indian",
  malayali: "south_indian",
};

const TRADITIONS = [...PARENTS, ...Object.keys(TRADITION_PARENT)];

const TRADITION_LABEL = {
  north_indian: "North Indian",
  south_indian: "South Indian",
  punjabi: "Punjabi",
  gujarati: "Gujarati",
  marwari: "Marwari",
  delhi: "Delhi",
  kannada: "Kannada",
  tamil: "Tamil",
  telugu: "Telugu",
  malayali: "Malayali",
};

/** Is this a known tradition token? */
function isTradition(t) {
  return typeof t === "string" && TRADITIONS.includes(t);
}

/** Keep only valid tokens, de-duplicated, order preserved. */
function cleanTraditions(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(list.filter(isTradition))];
}

/**
 * A tradition plus everything it implies — itself and its parent. Used to
 * answer "does this row cover north_indian?" when the row says "punjabi".
 */
function expand(t) {
  const parent = TRADITION_PARENT[t];
  return parent ? [t, parent] : [t];
}

/** The full implied set for a list of traditions. */
function expandAll(list) {
  const out = new Set();
  for (const t of cleanTraditions(list)) for (const x of expand(t)) out.add(x);
  return out;
}

/**
 * Does a row tagged `rowTraditions` apply to a reader asking about `asking`?
 *
 * An EMPTY row applies to everyone (unspecified — see the header). An empty
 * ASK matches everything, which is what a venue that serves all communities
 * wants by default.
 */
function traditionsMatch(rowTraditions, asking) {
  const row = cleanTraditions(rowTraditions);
  const ask = cleanTraditions(asking);
  if (row.length === 0) return true;
  if (ask.length === 0) return true;
  const rowSet = expandAll(row);
  const askSet = expandAll(ask);
  for (const a of askSet) if (rowSet.has(a)) return true;
  return false;
}

/**
 * The PARENT-level summary of a set of traditions — what owner-facing copy
 * says. "punjabi + tamil" reads as "North Indian and South Indian", because an
 * owner pricing a date thinks in those two blocks, not in eight.
 */
function parentsOf(list) {
  const out = new Set();
  for (const t of cleanTraditions(list)) {
    out.add(TRADITION_PARENT[t] || t);
  }
  return [...out];
}

/** "North Indian and South Indian" / "Kannada" — for prose, never for logic. */
function labelList(list, { specific = false } = {}) {
  const tokens = specific ? cleanTraditions(list) : parentsOf(list);
  const labels = tokens.map((t) => TRADITION_LABEL[t] || t);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** True when the set covers both top-level blocks. */
function coversBoth(list) {
  const p = parentsOf(list);
  return p.includes("north_indian") && p.includes("south_indian");
}

module.exports = {
  PARENTS,
  TRADITIONS,
  TRADITION_PARENT,
  TRADITION_LABEL,
  isTradition,
  cleanTraditions,
  expand,
  expandAll,
  traditionsMatch,
  parentsOf,
  labelList,
  coversBoth,
};
