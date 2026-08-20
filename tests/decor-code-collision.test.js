/**
 * PRODUCT-CODE COLLISION (2026-08-21).
 *
 * The generator read only the Decor collection, so every draft created before
 * the first approval got the SAME "next free" code — five queued drafts all on
 * st236, and the second approval 409ing after the approver had done the review.
 *
 *   A — suggestProductCode also excludes codes reserved by QUEUED drafts.
 *   C — approve auto-advances past a taken PROVISIONAL code, but never past one
 *       the approver typed.
 *
 * ⚠️ The most important test here is the SEPARATION one: isCodeTaken must stay
 * catalogue-only. If it ever becomes drafts-aware, every draft blocks its own
 * approval — and that test is what stops the two drifting back together.
 *
 *   node tests/decor-code-collision.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const DecorDraftService = require("../services/DecorDraftService");
const { suggestProductCode, isCodeTaken, isCodeReserved, reservedDraftCodes } = require("../utils/decorCode");

const TAG = `cc-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const COPY = { suggestedName: "N", description: "d", tags: [], included: [], category: CAT, style: "Modern", colors: [], flowers: [], fabric: [] };
DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("x") });
DecorDraftService.__deps.toAnalysisBase64 = async () => "B64";
DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
DecorDraftService.__deps.analyseForCopy = async () => JSON.parse(JSON.stringify(COPY));
DecorDraftService.__deps.scheduleCopyPass = () => {};
DecorDraftService.__deps.runPricingBrain = async () => ({
  analysis: { isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern", size: { length: 24, width: 16, confidence: 0.8 }, complexity: { tier: "standard", confidence: 0.7, reasoning: "r" }, ...COPY },
  pricing: { category: CAT, applicableTiers: ["artificial"], suggested: { artificial: 60000 } },
  fallbacks: [], rejected: false,
});

const drafts = [], decors = [];
let n = 0;
const newDraft = async () => {
  n += 1;
  const d = await DecorDraftService.createDraft({ imageUrl: `https://i.pinimg.com/564x/ab/cd/${TAG}${n}.jpg`, pinId: `${TAG}-${n}`, pinText: "stage" }, null);
  drafts.push(d._id);
  return d;
};
const approve = (id, extra = {}) => DecorDraftService.approveDraft(id, { category: CAT, name: `N${n}`, productTypes: [{ name: "Artificial Flowers", sellingPrice: 60000 }], ...extra }, null);

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. THE SEPARATION — the trap that must never close ──────────────────
    console.log("1. isCodeTaken stays CATALOGUE-ONLY");
    const d0 = await newDraft();
    const held = d0.draft.productCode;
    ok(!!held, `the draft holds a provisional code (${held})`);
    eq(await isCodeTaken(held), false,
      "a code held ONLY by a queued draft is NOT 'taken' — if this flips, every draft blocks its own approval");
    eq(await isCodeReserved(held), true, "…it IS 'reserved', which is the separate question");
    eq(await Decor.exists({ "productInfo.id": held }) ? true : false, false, "…and it is genuinely not in the catalogue");
    ok((await reservedDraftCodes(null)).has(held.toLowerCase()), "reservedDraftCodes reports it");

    // ── 2. A — FIVE DRAFTS, FIVE CODES ──────────────────────────────────────
    console.log("\n2. five drafts back to back get five DIFFERENT codes");
    const made = [d0];
    for (let i = 0; i < 4; i++) made.push(await newDraft());
    const codes = made.map((d) => d.draft.productCode);
    eq(new Set(codes).size, 5, `all distinct (${codes.join(", ")})`);
    ok(codes.every((c) => /^st\d{3}$/.test(c)), "…and all well-formed");
    const nums = codes.map((c) => parseInt(c.slice(2), 10));
    ok(nums.every((v, i) => i === 0 || v > nums[i - 1]), "…and strictly ascending");

    // a REJECTED draft releases its reservation
    const rej = await newDraft();
    const rejCode = rej.draft.productCode;
    eq(await isCodeReserved(rejCode), true, "a queued draft reserves its code");
    await DecorDraftService.rejectDraft(rej._id, { reason: "no" }, null);
    eq(await isCodeReserved(rejCode), false, "…and rejecting it RELEASES the code back to the pool");
    eq(await suggestProductCode(CAT), rejCode, "…so the next suggestion reuses it rather than leaving a gap");

    // ── 3. C — AUTO-ADVANCE PAST A PROVISIONAL CODE ─────────────────────────
    console.log("\n3. approving all five in a row now works");
    const published = [];
    for (const d of made) {
      const r = await approve(d._id);
      decors.push(r.decorId);
      published.push(r.productCode);
    }
    eq(new Set(published).size, 5, `five distinct published codes (${published.join(", ")})`);
    ok(published.every((c, i) => c === codes[i]), "…each matching its own provisional code — no advance was needed");

    // now force the collision the old code hit: a draft whose provisional code
    // gets taken by someone else before approval.
    console.log("\n   …and when a provisional code IS taken meanwhile:");
    const d6 = await newDraft();
    const wanted = d6.draft.productCode;
    const squatter = await Decor.create({ category: CAT, name: `${TAG} squatter`, unit: "Pc", image: "https://s3.test/s.jpg", thumbnail: "https://s3.test/s.jpg", productInfo: { id: wanted } });
    decors.push(squatter._id);
    eq(await isCodeTaken(wanted), true, `${wanted} is now live in the catalogue`);
    const r6 = await approve(d6._id);
    decors.push(r6.decorId);
    ok(!!r6.codeAutoAssigned, "approval SUCCEEDS instead of 409ing");
    eq(r6.codeAutoAssigned.from, wanted, "…reporting the code it moved from");
    eq(r6.codeAutoAssigned.to, r6.productCode, "…and the one it published as");
    ok(r6.productCode !== wanted, `…which is different (${wanted} → ${r6.productCode})`);
    eq((await Decor.findById(r6.decorId).lean()).productInfo.id, r6.productCode, "the product carries the new code");
    const hist = (await DecorDraft.findById(d6._id).lean()).history;
    ok(hist.some((h) => h.action === "code_reassigned" && h.note.includes(r6.productCode)),
      "…and the reassignment is recorded in history, so nobody is surprised later");

    // ── 4. C — A HUMAN'S CHOICE IS NEVER OVERRIDDEN ─────────────────────────
    console.log("\n4. a code the approver TYPED still 409s");
    const d7 = await newDraft();
    const takenCode = published[0]; // a real, live product code
    const e7 = await threw(() => approve(d7._id, { productCode: takenCode }));
    ok(e7 && e7.status === 409, "409 when the approver types a taken code");
    eq(e7.code, "DUPLICATE_PRODUCT_CODE", "…with the structured code the modal acts on");
    ok(e7.message.includes(takenCode), "…naming the code they chose");
    eq((await DecorDraft.findById(d7._id).lean()).status, "queued", "…and the draft is untouched");

    // submitting the provisional code UNCHANGED is not a human choice
    const d8 = await newDraft();
    const prov8 = d8.draft.productCode;
    const squat8 = await Decor.create({ category: CAT, name: `${TAG} squat8`, unit: "Pc", image: "https://s3.test/s.jpg", thumbnail: "https://s3.test/s.jpg", productInfo: { id: prov8 } });
    decors.push(squat8._id);
    const r8 = await approve(d8._id, { productCode: prov8 }); // modal echoes it back untouched
    decors.push(r8.decorId);
    ok(!!r8.codeAutoAssigned, "echoing the provisional code back is NOT treated as a human choice");
    eq(r8.codeAutoAssigned.from, prov8, "…so it auto-advances");

    // ── 5. THE AUTO-ADVANCE PICKS A GENUINELY FREE CODE ─────────────────────
    console.log("\n5. the advanced code collides with nothing");
    eq(await isCodeTaken(r6.productCode), true, "the published code is now live");
    const others = await Decor.countDocuments({ "productInfo.id": r6.productCode });
    eq(others, 1, "…exactly once — no duplicate product was created");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await DecorDraft.deleteMany({ _id: { $in: drafts } });
    await Decor.deleteMany({ _id: { $in: decors.filter(Boolean) } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
