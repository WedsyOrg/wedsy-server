// COUPLE APP § 06.4 — THE PERMISSION MATRIX. Run: node tests/couple-permissions.test.js
// PURE unit tests (NO DATABASE). Walks the WHOLE matrix — 2 caller kinds ×
// 6 sections × 3 held levels × 2 required levels — because § 06.4 says the
// server enforces this on EVERY endpoint and "hiding UI is a convenience, not
// a control". A hole here is a cousin reading the couple's venue prices.
//
// The last block is the one that matters most: `edit` on payments must never
// imply the ability to initiate a payout, and it is asserted to be
// STRUCTURALLY impossible — not merely refused.
const p = require("../services/CouplePermissions");
const { SECTION, ACCESS_LEVEL } = require("../utils/coupleEnums");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const partner = { userId: "u1", weddingId: "w1", role: "partner", member: null };
const member = (access, extra = {}) => ({
  userId: "u2", weddingId: "w1", role: "member",
  member: { acceptedAt: new Date("2026-07-02"), revokedAt: null, access, ...extra },
});
const ALL_EDIT = SECTION.reduce((a, s) => ({ ...a, [s]: "edit" }), {});

console.log("Both partners are full (§ 06.4):");
{
  let all = true;
  SECTION.forEach((section) => {
    if (!p.can(partner, section, "view") || !p.can(partner, section, "edit")) all = false;
  });
  ok(all, "a partner may view and edit every one of the six sections");
  eq(p.levelFor(partner, "payments"), "edit", "and holds edit everywhere");
}

console.log("The whole matrix for a shared member:");
{
  let wrong = 0;
  const rank = { none: 0, view: 1, edit: 2 };
  SECTION.forEach((section) => {
    ACCESS_LEVEL.forEach((held) => {
      const caller = member({ ...ALL_EDIT, [section]: held });
      ["view", "edit"].forEach((required) => {
        const expected = rank[held] >= rank[required];
        if (p.can(caller, section, required) !== expected) wrong += 1;
      });
    });
  });
  eq(wrong, 0, `all ${SECTION.length * ACCESS_LEVEL.length * 2} (section × held × required) combinations rank correctly`);
}

console.log("Sections are independent:");
{
  const caller = member({ guests: "edit", website: "none", decor: "none", registry: "none", payments: "none", tasks: "none" });
  ok(p.can(caller, "guests", "edit"), "edit on the guest list");
  ok(!p.can(caller, "website", "view"), "does not open the website");
  ok(!p.can(caller, "payments", "view"), "and certainly not the payments");
}

console.log("Fail-closed:");
{
  const caller = member(ALL_EDIT);
  ok(!p.can(caller, "budget", "view"), "an UNKNOWN section is refused, not waved through");
  ok(!p.can(caller, "guests", "admin"), "an unknown LEVEL is refused");
  ok(!p.can(caller, "guests", "none"), "'none' is never something to be granted");
  ok(!p.can(null, "guests", "view"), "a missing caller is refused");
  ok(!p.can({ role: "member", member: null }, "guests", "view"), "a member row that did not load is refused");
  ok(!p.can(member({}), "guests", "view"), "an empty access map grants nothing");
  ok(!p.can(member({ guests: "EDIT" }), "guests", "edit"), "a value outside the enum grants nothing (no case-folding surprise)");
  eq(p.levelFor(member({ guests: "boss" }), "guests"), "none", "and reports as none");
}

console.log("Invitations that are not access:");
{
  ok(!p.can(member(ALL_EDIT, { acceptedAt: null }), "guests", "view"), "an invitation never opened is NOT access");
  ok(!p.can(member(ALL_EDIT, { revokedAt: new Date() }), "guests", "view"), "a revoked member stops resolving immediately");
  ok(p.isActiveMember({ acceptedAt: new Date(), revokedAt: null }), "an accepted, un-revoked member is active");
  ok(!p.isActiveMember(null), "a missing row is not active");
}

console.log("PAYOUTS — structurally impossible, not merely refused:");
{
  ok(p.canInitiatePayout(partner), "a partner may move money");
  ok(!p.canInitiatePayout(member(ALL_EDIT)), "a shared member with EVERY section at edit may NOT");
  ok(!p.canInitiatePayout(member({ ...ALL_EDIT, payments: "edit" })), "payments:edit specifically does not imply it (§ 06.4)");
  ok(!p.canInitiatePayout(null), "nor does an absent caller");
  // Structure, not policy: there is no section to grant and no key to set.
  ok(SECTION.indexOf("payouts") === -1, "'payouts' is not one of the six grantable sections");
  ok(SECTION.indexOf("payout") === -1 && SECTION.indexOf("wallet") === -1, "and there is no near-miss section that could stand in for one");
  const SharedMember = require("../models/SharedMember");
  const accessPaths = Object.keys(SharedMember.schema.path("access").schema.paths);
  eq(accessPaths.length, 6, "SharedMember.access has exactly six keys");
  ok(accessPaths.every((key) => SECTION.indexOf(key) !== -1), "and every one of them is a section — there is no seventh key a payout could hide in");
  eq(p.canInitiatePayout.length, 1, "canInitiatePayout reads only the caller — it takes no section and no level");
}

console.log("Refusal bodies the client can render:");
{
  const d = p.denial("payments", "view", "none");
  eq(d.error, "forbidden", "a section refusal is 'forbidden'");
  eq(d.section, "payments", "and names the section, so the screen can say WHICH door is shut");
  ok(Boolean(d.message), "with a message");
  const pd = p.payoutDenial();
  eq(pd.error, "forbidden_payout", "a payout refusal has its own error, so the client can word it properly");
  ok(pd.message.indexOf("Only the couple") === 0, "and says only the couple can move money");
}

console.log("The access map the client renders (but never decides from):");
{
  const map = p.accessMap(member({ guests: "edit", website: "view", decor: "none", registry: "none", payments: "none", tasks: "view" }));
  eq(Object.keys(map).length, 6, "six sections");
  eq(map.guests, "edit", "guests");
  eq(map.payments, "none", "payments");
  eq(p.accessMap(partner).payments, "edit", "a partner's map is edit throughout");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
