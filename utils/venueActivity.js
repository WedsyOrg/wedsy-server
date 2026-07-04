/**
 * utils/venueActivity.js — D10 write-path helpers for the activity spine.
 * Fire-and-forget by design: a logging failure must never break the mutation
 * it observes. The OS-side feed is MB-V2; data accrues from these hooks now.
 */
const VenueActivity = require("../models/VenueActivity");
let VenueTeamMember;
try { VenueTeamMember = require("../models/VenueTeamMember"); } catch (_) {}

// Severity by the first segment of the $set path (D10):
// listing identity / pricing / policy / rename / status → high;
// photos & free-text notes → low; everything else normal.
const HIGH_PREFIXES = ["name", "pricing", "policyDoc", "policies", "status"];
const LOW_PREFIXES = ["photos", "coverPhoto", "notes"];

function severityFor(path) {
  const head = String(path).split(".")[0];
  if (HIGH_PREFIXES.includes(head)) return "high";
  if (LOW_PREFIXES.includes(head)) return "low";
  return "normal";
}

function snap(v) {
  if (v === undefined) return "";
  try {
    return String(JSON.stringify(v)).slice(0, 1000);
  } catch {
    return String(v).slice(0, 1000);
  }
}

// Read the old value at a dotted path off the loaded venue doc.
function valueAt(doc, path) {
  let cur = doc && typeof doc.toObject === "function" ? doc.toObject() : doc;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Resolve the actor descriptor from a request (owner/member/admin) — used by
// controllers; system callers build {type:"system", name:"…"} directly.
async function actorFromReq(req) {
  if (req.admin) return { type: "wedsy_team", id: req.admin._id, name: "Wedsy admin" };
  if (!req.venueOwner) return { type: "system", name: "system" };
  if (!req.venueOwner.memberId) return { type: "venue_team", id: req.venueOwner.venueOwnerId, name: "Owner" };
  let name = "team member";
  if (VenueTeamMember) {
    const m = await VenueTeamMember.findById(req.venueOwner.memberId).select("name").lean();
    if (m && m.name) name = m.name;
  }
  return { type: "venue_team", id: req.venueOwner.memberId, name };
}

// Diff a venue update ($set paths vs the pre-update doc) into activity rows.
function entriesForVenueUpdate(venueId, oldVenue, $set, actor) {
  const entries = [];
  for (const [path, newVal] of Object.entries($set || {})) {
    const oldVal = valueAt(oldVenue, path);
    const oldSnap = snap(oldVal);
    const newSnap = snap(newVal);
    if (oldSnap === newSnap) continue; // no-op writes don't pollute the trail
    entries.push({
      venue: venueId,
      actorType: actor.type,
      actorId: actor.id || undefined,
      actorName: actor.name || "",
      action: path === "name" ? "venue_renamed" : "listing_updated",
      entity: String(path).split(".")[0],
      field: path,
      old: oldSnap,
      new: newSnap,
      severity: severityFor(path),
    });
  }
  return entries;
}

// Append rows; never throws to the caller.
async function logActivity(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  try {
    await VenueActivity.insertMany(list, { ordered: false });
  } catch (err) {
    console.warn(`[venueActivity] log failed (ignored): ${err.message}`);
  }
}

module.exports = { severityFor, entriesForVenueUpdate, actorFromReq, logActivity, snap };
