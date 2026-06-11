// Lead visibility cutoff (settings-driven LISTING filter — additive, no deletion).
// Pre-cutoff Atlas leads stop appearing in lists/dashboards but remain in the DB,
// openable by direct id and findable by the dedup phone-lookup.
//
// Visible when ANY of:
//   - imported (importedAt set) — imports always show regardless of createdAt
//   - created on/after the cutoff
//   - re-enquired on/after the cutoff (a hidden old lead that comes back to life)
//
// NEVER apply this to: GET /enquiry/:_id (direct fetch), the intake dedup lookup
// (LeadIntakeService.findExistingByNormalizedPhone), or any write path.
const SettingsService = require("../services/SettingsService");

// Pure: Mongo condition for a given cutoff. null/invalid cutoff → {} (feature off).
const visibilityFilter = (cutoff) => {
  if (!cutoff) return {};
  const d = new Date(cutoff);
  if (Number.isNaN(d.getTime())) return {};
  return {
    $or: [
      { importedAt: { $exists: true, $ne: null } },
      { createdAt: { $gte: d } },
      { reEnquiredAt: { $gte: d } },
    ],
  };
};

// Reads the setting (cached 60s in SettingsService) and returns the condition.
const currentVisibilityFilter = async () =>
  visibilityFilter(await SettingsService.get("leads.visibilityCutoff"));

module.exports = { visibilityFilter, currentVisibilityFilter };
