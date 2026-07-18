// LOST IS TERMINAL — the ONE shared exclusion every work surface routes
// through. Definition: lost-terminal = (stage "lost" OR isLost) AND NOT
// lostStatus "pending". A pending-approval lead stays LIVE everywhere until
// the manager approves; approval writes { lostStatus:"approved", isLost:true,
// stage:"lost" } atomically (EnquiryService.decideDisqualification), which is
// what makes the flat (no-$or) mongo form below exact:
//   • pending leads never carry stage "lost"/isLost (request only stamps
//     lostStatus + audit fields) → the pending exception is automatic;
//   • legacy isLost:true docs (old bulk mark-lost, lostStatus "none") are
//     terminal by the isLost leg;
//   • lostStatus "approved" is excluded as a belt for any doc where the
//     approve write half-landed.
// The in-memory predicate below is the EXACT boolean definition — use it when
// the docs are already in hand (row decoration, openness checks).
const notLostFilter = () => ({
  stage: { $ne: "lost" },
  isLost: { $ne: true },
  lostStatus: { $ne: "approved" },
});

const isTerminalLost = (lead) =>
  !!lead &&
  (lead.stage === "lost" || lead.isLost === true || lead.lostStatus === "approved") &&
  lead.lostStatus !== "pending";

module.exports = { notLostFilter, isTerminalLost };
