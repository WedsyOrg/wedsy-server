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

module.exports = { VENUE_ROLES, CAPABILITIES, ROLE_CAPABILITIES, roleHasCapability };
