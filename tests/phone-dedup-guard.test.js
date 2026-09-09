/**
 * THE NARROW DEDUP GUARD.
 *
 * LeadIntakeService dedups on the LAST TEN DIGITS. The production census (1078
 * leads) found ZERO collisions: every existing last-10 group is one number
 * written two ways. So the key STAYS — widening it would split real customers
 * into duplicates, which is a worse bug than the one being prevented.
 *
 * ONE rule is added: two numbers never merge when BOTH carry an explicit
 * country code and those codes differ. A number carrying no code merges exactly
 * as it does today — that is the 47 leads in the census with no code, and the
 * "+91 98765 43210" vs "9876543210" pair the rule exists to catch.
 *
 * The shapes below are the ones the census actually found: US/Canada, UK,
 * France, Germany, Greece, UAE, Maldives — plus the Indian pairs that MUST
 * still merge.
 *
 *   node tests/phone-dedup-guard.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const LeadIntakeService = require("../services/LeadIntakeService");
const Enquiry = require("../models/Enquiry");

const TAG = `dedupguard-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const cleanup = [];

// A UNIQUE 10-digit base per run. Two things depend on it:
//  - leftover leads from earlier runs cannot make a match look like a hit
//  - EVERY number below is built as <code> + base, so every pair genuinely
//    shares its last ten digits. That is what makes them exercise the guard;
//    a pair that does not share the key would pass without the guard existing.
const BASE = `9${String(Date.now()).slice(-9)}`;

const seed = async (phone, label) => {
  const l = await Enquiry.create({
    name: `${TAG}-${label}`, phone, source: "Website",
    stage: "new", verified: false, isInterested: false, isLost: false,
  });
  cleanup.push(l._id);
  return l;
};

// Does an incoming number find the stored lead?
const finds = async (incoming, storedLead) => {
  const hit = await LeadIntakeService.findExistingByNormalizedPhone(incoming);
  return !!hit && String(hit._id) === String(storedLead._id);
};

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    console.log(`  (base number for this run: ${BASE})`);

    console.log("\n1. THE PAIRS THAT MUST STILL MERGE (the rule's whole purpose)");
    {
      const lead = await seed(`+91${BASE}`, "in-plus");
      ok(await finds(BASE, lead),
        "a bare 10-digit number STILL merges into its +91 form");
      ok(await finds(`+91 ${BASE.slice(0, 5)} ${BASE.slice(5)}`, lead),
        "…and so does the spaced, plus-prefixed form");
      ok(await finds(`91${BASE}`, lead),
        "…and the plusless 12-digit form");
      ok(await finds(`0${BASE}`, lead),
        "…and the trunk-zero form");
    }
    {
      // Stored WITHOUT a code, incoming WITH one: still one customer.
      const B2 = `8${String(Date.now() + 1).slice(-9)}`;
      const lead = await seed(B2, "in-bare");
      ok(await finds(`+91${B2}`, lead), "a stored bare number is still found by its +91 form");
      ok(await finds(B2, lead), "…and by itself");
    }

    console.log("\n2. TWO EXPLICIT CODES THAT DIFFER — NEVER MERGE");
    // Every code here is one the census actually found in production. Built as
    // <code> + BASE so the foreign and Indian forms share their last ten digits
    // — i.e. so the OLD rule would merge them and only the guard stops it.
    const codes = [
      ["1", "US/Canada"], ["44", "UK"], ["33", "France"],
      ["49", "Germany"], ["30", "Greece"], ["971", "UAE"], ["960", "Maldives"],
    ];
    for (const [code, label] of codes) {
      const B = `7${String(Date.now()).slice(-6)}${code.padStart(3, "0")}`.slice(0, 10);
      const foreign = `+${code}${B}`;
      const indian = `+91${B}`;
      const lead = await seed(foreign, `${label.replace(/\W+/g, "-")}`);
      // Sanity: the pair MUST share the dedup key, or this proves nothing.
      const sameKey = LeadIntakeService.normalizePhone(foreign) === LeadIntakeService.normalizePhone(indian);
      ok(sameKey, `${label}: +${code}${B} and +91${B} share the last-10 key (so the guard is what decides)`);
      ok(!(await finds(indian, lead)),
        `${label}: the Indian number does NOT merge into the +${code} lead`);
    }
    {
      // The direction that actually happens: the foreign lead arrives second.
      const B = `6${String(Date.now()).slice(-9)}`;
      const lead = await seed(`+91${B}`, "in-first");
      ok(!(await finds(`+1${B}`, lead)),
        "a US number arriving later does NOT merge into an existing Indian lead");
    }

    console.log("\n3. ONE SIDE HAS NO CODE — TODAY'S BEHAVIOUR IS UNCHANGED");
    {
      // The deliberate limit of the guard. A bare number cannot be proven
      // foreign, so it merges as it always has. The census puts 47 leads in
      // this state and none of them collide.
      const B = `5${String(Date.now()).slice(-9)}`;
      const lead = await seed(`+971${B}`, "uae-explicit");
      ok(await finds(B, lead),
        "a code-less number still merges into a foreign lead (unchanged, by design)");
    }

    console.log("\n4. THE GUARD IS A PURE, TESTABLE RULE");
    {
      const { mayMergeNumbers } = LeadIntakeService;
      ok(typeof mayMergeNumbers === "function", "mayMergeNumbers is exported");
      if (typeof mayMergeNumbers === "function") {
        ok(mayMergeNumbers("+919876543210", "9876543210") === true, "explicit vs bare → merge");
        ok(mayMergeNumbers("9876543210", "9876543210") === true, "bare vs bare → merge");
        ok(mayMergeNumbers("+919876543210", "+919876543210") === true, "identical explicit → merge");
        ok(mayMergeNumbers("+919876543210", "919876543210") === true,
          "explicit-by-plus vs explicit-by-length, same digits → merge");
        ok(mayMergeNumbers("+14155550134", "+914155550134") === false, "differing explicit codes → never");
        ok(mayMergeNumbers("+9714155550134", "+914155550134") === false, "UAE vs India → never");
        ok(mayMergeNumbers("ig:123", "9876543210") === true,
          "a placeholder is not an explicit code and does not block the old path");
      }
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    if (cleanup.length) await Enquiry.deleteMany({ _id: { $in: cleanup } });
    await Enquiry.deleteMany({ name: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
