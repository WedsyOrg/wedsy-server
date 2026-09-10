// COUPLE APP § 05.5 / § 06.4 — THE FAMILY-SHARING ACCESS MAP.
// Run: node tests/couple-member-access.test.js
//
// PURE unit tests (NO DATABASE). Exactly six sections, exactly three levels,
// exactly seventeen relations, and FAIL CLOSED on anything else.
//
// This is the structural half of § 06.4. CouplePermissions answers "may they?"
// when the map is read back; this file is what decides whether a map is ever
// stored at all — and it is why "no seventh key" is a property of the code
// rather than a promise in a comment.
const rules = require("../services/CouplePeopleRules");
const { SECTION, ACCESS_LEVEL, RELATIONS, DEFAULT_ACCESS } = require("../utils/coupleEnums");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const keys = (o) => Object.keys(o).sort().join(",");

console.log("The lists themselves are the contract:");
{
  eq(SECTION.length, 6, "six sections, and only six");
  eq(SECTION.join(","), "guests,website,decor,registry,payments,tasks", "…these six, in the screen's own order");
  eq(ACCESS_LEVEL.length, 3, "three levels");
  eq(ACCESS_LEVEL.join(","), "none,view,edit", "…none, view, edit");
  eq(RELATIONS.length, 17, "seventeen relation presets (§ 05.5)");
  eq(SECTION.indexOf("payouts"), -1, "'payouts' is NOT a grantable section — there is nowhere to write it");
  eq(SECTION.indexOf("members"), -1, "nor is 'members' — inviting people is the couple's, structurally");
  eq(keys(DEFAULT_ACCESS), keys({ guests: 1, website: 1, decor: 1, registry: 1, payments: 1, tasks: 1 }),
     "the default map has the same six keys");
  eq(DEFAULT_ACCESS.guests, "view", "§ 05.5 — a new member starts with the guest list at View");
  eq(SECTION.filter((s) => DEFAULT_ACCESS[s] !== "none").length, 1, "…and everything else at None");
}

console.log("Six keys out, always:");
{
  const full = rules.accessMapFrom({ guests: "edit", website: "view", decor: "edit", registry: "view", payments: "edit", tasks: "view" });
  eq(keys(full), keys(DEFAULT_ACCESS), "a complete map comes back complete");
  eq(full.payments, "edit", "…with its values");
  eq(keys(rules.accessMapFrom({ guests: "edit" })), keys(DEFAULT_ACCESS), "a partial map still comes back with six keys");
  eq(rules.accessMapFrom({ guests: "edit" }).website, "none",
     "a key that was not sent is 'none' — a partial map can only ever REDUCE what a member holds");
  eq(keys(rules.accessMapFrom({})), keys(DEFAULT_ACCESS), "an empty map is six 'none's, not an error to work around");
  eq(SECTION.every((s) => rules.accessMapFrom({})[s] === "none"), true, "…all six of them");
}

console.log("THE SEVENTH KEY DOES NOT EXIST:");
{
  // § 06.4 — "`edit` on payments never implies the ability to initiate a
  // payout." Not a check a call site could forget: a caller who posts a payout
  // right has nowhere to put it.
  const sneaky = rules.accessMapFrom({
    guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit",
    payouts: "edit", members: "edit", admin: "edit", __proto__: "edit",
  });
  eq(keys(sneaky), keys(DEFAULT_ACCESS), "six keys, whatever was posted");
  eq(sneaky.payouts, undefined, "'payouts' is not carried through");
  eq(sneaky.members, undefined, "nor 'members'");
  eq(sneaky.admin, undefined, "nor anything else somebody invents");
  eq(Object.keys(sneaky).length, 6, "the map is six long, exactly");
}

console.log("An unknown LEVEL is 'none' — fail closed:");
{
  eq(rules.accessMapFrom({ guests: "admin" }).guests, "none", "a level nobody defined is none");
  eq(rules.accessMapFrom({ guests: "EDIT" }).guests, "none", "…including the right word in the wrong case");
  eq(rules.accessMapFrom({ guests: true }).guests, "none", "a boolean is none");
  eq(rules.accessMapFrom({ guests: 2 }).guests, "none", "a number is none");
  eq(rules.accessMapFrom({ guests: null }).guests, "none", "null is none");
  eq(rules.accessMapFrom({ guests: { $ne: "none" } }).guests, "none", "an object is none");
  eq(rules.accessMapFrom({ guests: ["edit"] }).guests, "none", "an array is none");
}

console.log("A map that is not a map at all:");
{
  eq(rules.accessMapFrom(null).guests, "view", "null falls back to the § 05.5 default");
  eq(rules.accessMapFrom(undefined).website, "none", "…so does undefined");
  eq(rules.accessMapFrom("guests=edit").guests, "view", "a string is not a map");
  eq(rules.accessMapFrom(["edit"]).guests, "view", "an array is not a map");
  eq(rules.accessMapFrom(null, { guests: "edit", website: "edit" }).website, "edit", "an explicit fallback is honoured");
  eq(rules.accessMapFrom(null, { guests: "root" }).guests, "none", "…but a junk fallback still fails closed");
}

console.log("Seventeen relations, and nothing else:");
{
  RELATIONS.forEach((preset) => eq(rules.relationOf(preset), preset, `"${preset}" is a relation`));
  eq(rules.relationOf("bride's mother"), "Bride's mother", "matched case-insensitively, stored in the list's spelling");
  eq(rules.relationOf("  Best man  "), "Best man", "and trimmed — so one relation is not two");
  eq(rules.relationOf("Second cousin twice removed"), null, "a relation outside the seventeen is refused");
  eq(rules.relationOf(""), null, "so is a blank one");
  eq(rules.relationOf(null), null, "so is none at all");
  eq(rules.relationOf(42), null, "so is a number");
  eq(rules.relationOf({ $ne: "" }), null, "so is an object");
}

console.log("The member body — inviting:");
{
  const good = rules.memberFields({ name: " Sunita Sharma ", relation: "Bride's mother",
    access: { guests: "edit", website: "view", decor: "edit", registry: "view", payments: "none", tasks: "view" } });
  eq(Object.keys(good.errors).length, 0, "the seed's own member is a valid invitation");
  eq(good.fields.name, "Sunita Sharma", "the name is trimmed");
  eq(good.fields.access.payments, "none", "the map survives intact");
  eq(keys(good.fields.access), keys(DEFAULT_ACCESS), "…and is six keys long");

  ok(rules.memberFields({ relation: "Cousin" }).errors.name !== undefined, "a member with no name is refused");
  ok(rules.memberFields({ name: "   ", relation: "Cousin" }).errors.name !== undefined, "whitespace is not a name");
  ok(rules.memberFields({ name: "Sunita" }).errors.relation !== undefined, "a member with no relation is refused");
  ok(rules.memberFields({ name: "S", relation: "Dog" }).errors.relation !== undefined, "…or one outside the seventeen");
  eq(rules.memberFields({ name: "S", relation: "Cousin" }).fields.access.guests, "view",
     "an invitation with no access map gets the § 05.5 default");
  eq(rules.memberFields({ name: "S", relation: "Cousin", access: { payouts: "edit" } }).fields.access.payouts, undefined,
     "…and never a key the six do not include");
}

console.log("The member body — patching:");
{
  const patch = rules.memberFields({ access: { guests: "view" } }, { partial: true });
  eq(Object.keys(patch.errors).length, 0, "an access-only patch is valid");
  eq(Object.keys(patch.fields).join(","), "access", "…and touches only the access map");
  eq(keys(patch.fields.access), keys(DEFAULT_ACCESS), "which is still six keys");
  eq(Object.keys(rules.memberFields({}, { partial: true }).fields).length, 0, "an empty patch changes nothing");
  ok(rules.memberFields({ name: "" }, { partial: true }).errors.name !== undefined, "a patch cannot blank a name");
  ok(rules.memberFields({ relation: "Neighbour" }, { partial: true }).errors.relation !== undefined,
     "a patch cannot smuggle in a relation the screen cannot render");
}

console.log("The row the screen renders — and what never leaves the server:");
{
  const shaped = rules.shapeMember({
    _id: "m1", weddingId: "w1", name: "Sunita Sharma", relation: "Bride's mother",
    access: { guests: "edit", website: "view", decor: "edit", registry: "view", payments: "none", tasks: "view" },
    phone: "+91 98450 11223", phoneNormalised: "919845011223",
    user: "u9", inviteTokenHash: "$2b$10$notreally", invitedBy: "u1",
    invitedAt: "2026-07-02T10:00:00+05:30", acceptedAt: "2026-07-02T18:20:00+05:30", revokedAt: null,
  });
  eq(keys(shaped), "acceptedAt,access,id,invitedAt,name,phone,relation", "the § 05.5 contract, and no internals");
  eq(shaped.inviteTokenHash, undefined, "THE INVITE CREDENTIAL NEVER CROSSES THE WIRE, hashed or not");
  eq(shaped.user, undefined, "nor the account it is bound to");
  eq(shaped.phoneNormalised, undefined, "nor the derived match key");
  eq(shaped.weddingId, undefined, "nor the scope it was already read under");
  eq(keys(shaped.access), keys(DEFAULT_ACCESS), "the access map is re-normalised on the way out too");
  eq(rules.shapeMember({ _id: "m2", access: { payouts: "edit" } }).access.payouts, undefined,
     "…so a row that somehow acquired a seventh key does not render one");
  eq(rules.shapeMember(null).name, "", "no row at all still shapes");
}

console.log("The members-management refusal:");
{
  const denial = rules.partnerDenial();
  eq(denial.error, "forbidden", "403, in the foundation's own body shape");
  eq(denial.section, "members", "it names what was asked for");
  eq(denial.required, "partner", "…and that only a partner has it");
  ok(/only the couple/i.test(denial.message), "and says so in the product's voice");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
