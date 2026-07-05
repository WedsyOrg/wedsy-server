// One venue role vocabulary, shared by VenueOwner.role and VenueTeamMember.role.
// No "admin" here — that collides with the platform Admin; listing-only is "marketing"
// and listing+availability is "listing_manager".
const VENUE_ROLES = ["owner", "manager", "sales", "listing_manager", "marketing"];

// Capability tokens used by the route-level role gate.
const CAPABILITIES = {
  LEADS: "leads", // manual add, import, sheets sync, stage moves, assign, comm log
  LISTING: "listing", // listing/content editing
  AVAILABILITY: "availability", // calendar / blocked dates
  TEAM: "team", // invite / list / deactivate members
  BILLING: "billing", // billing + owner-management (e.g. granting the owner role)
};

// role -> capabilities. (Confirmed matrix: marketing = listing only.)
const ROLE_CAPABILITIES = {
  owner: ["leads", "listing", "availability", "team", "billing"],
  manager: ["leads", "listing", "availability", "team"],
  sales: ["leads"],
  listing_manager: ["listing", "availability"],
  marketing: ["listing"],
};

function roleHasCapability(role, capability) {
  // Missing role → legacy single-owner token; treat as owner (full access).
  const caps = ROLE_CAPABILITIES[role || "owner"] || [];
  return caps.includes(capability);
}

// ───────────────────────── RBAC v2 (D5) ─────────────────────────
// Owner-editable capability bundles. The vocabulary below is the v2 enum;
// the legacy tokens above stay valid on old routes via CAPABILITY_ALIASES.
const CAPABILITIES_V2 = [
  "leads",
  "bookings_money",
  "documents",
  "rooms_checkin",
  "listing",
  "availability",
  "team",
  "insights",
  "chats",
];

// Legacy route tokens ↔ v2 tokens. Checked in BOTH directions so a route
// written against either vocabulary resolves against either a bundle or the
// legacy static map. "billing" was the money/owner-management token pre-v2.
const CAPABILITY_ALIASES = { billing: "bookings_money", bookings_money: "billing" };

// The four seeded starter bundles (+ the system Owner role, which always has
// every capability). Names are user-facing and unique per venue.
const DEFAULT_ROLE_BUNDLES = [
  { name: "Manager", capabilities: CAPABILITIES_V2.filter((c) => c !== "team") },
  { name: "Sales", capabilities: ["leads", "insights", "chats"] },
  { name: "Front Desk", capabilities: ["rooms_checkin"] },
  { name: "Accounts", capabilities: ["bookings_money", "documents"] },
];

// Legacy 5-enum → bundle-name mapping for the additive migration.
// owner/manager/sales map onto the system/default bundles by name; the two
// listing-flavoured legacy roles get capability-preserving CUSTOM bundles so
// no existing member gains or loses listing access silently.
const LEGACY_ROLE_TO_BUNDLE = {
  owner: "Owner",
  manager: "Manager",
  sales: "Sales",
  listing_manager: "Listing Manager",
  marketing: "Marketing",
};
const LEGACY_CUSTOM_BUNDLES = [
  { name: "Listing Manager", capabilities: ["listing", "availability"] },
  { name: "Marketing", capabilities: ["listing"] },
];

module.exports = {
  VENUE_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  roleHasCapability,
  CAPABILITIES_V2,
  CAPABILITY_ALIASES,
  DEFAULT_ROLE_BUNDLES,
  LEGACY_ROLE_TO_BUNDLE,
  LEGACY_CUSTOM_BUNDLES,
};
