/**
 * COMPLETING A CALL MUST NEVER REFUSE.
 *
 * Decision (Rohaan, 5 Sep 2026): "remove all those guards. they should be able
 * to move the lead forward even without any information. let the intern take a
 * call."
 *
 * The principle is REMOVE REFUSALS, KEEP MEASUREMENTS. completeCall held the
 * only server-side hard stop: a qualified lead with no future follow-up threw
 * 400 and the intern's call would not save. It fired at the worst possible
 * moment — after they had qualified the lead and were trying to hang up — and
 * with the UI guards gone an intern reaches it in one click.
 *
 * The call must now always save. When the next step is missing the LEAD SAYS SO,
 * via the callCompletion.status/gaps path that already existed for an explicit
 * incomplete=true. Nothing new is invented; the refusal just takes the road the
 * code already had.
 *
 * Written BEFORE the change and expected to fail on the 400.
 *
 *   node tests/call-complete-no-refusal.test.js
 */
const Module = require("module");

const leads = {};
const written = [];
const events = [];
const origLoad = Module._load;
Module._load = function (r) {
  if (r.endsWith("/repositories/EnquiryRepository")) return {
    findById: async (id) => leads[id] || null,
    updateFieldsById: async (id, fields) => {
      written.push({ id, fields });
      // Mirror the $set-style dotted paths onto the doc so later reads see them.
      for (const [k, v] of Object.entries(fields)) {
        const parts = k.split(".");
        let node = leads[id];
        while (parts.length > 1) { const p = parts.shift(); node[p] = node[p] || {}; node = node[p]; }
        node[parts[0]] = v;
      }
      return leads[id];
    },
  };
  if (r.endsWith("/LeadInternalEventService")) return { record: async (e) => { events.push(e); } };
  if (r.endsWith("/SettingsService")) return { getMany: async () => ({}), get: async () => null };
  return origLoad.apply(this, arguments);
};

const svc = require("../services/CallCockpitService");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

const oid = (n) => String(n).padStart(24, "a");
const mkLead = (n, over = {}) => {
  const id = oid(n);
  leads[id] = {
    _id: id, qualified: false, followUps: [], callCompletion: {},
    noFurtherAction: {}, toObject() { return { ...this }; }, ...over,
  };
  return id;
};
const complete = async (id, body = {}) => {
  written.length = 0; events.length = 0;
  try { return { ok: true, res: await svc.completeCall(id, body, "admin1") }; }
  catch (e) { return { ok: false, status: e.status, message: e.message }; }
};
const fieldsOf = () => Object.assign({}, ...written.map((w) => w.fields));
const future = () => [{ scheduledAt: new Date(Date.now() + 864e5) }];

const run = async () => {

console.log("\n1. THE REFUSAL IS GONE — a qualified call with no next step still saves");
{
  const id = mkLead(1, { qualified: true, followUps: [] });   // the exact 400 case
  const r = await complete(id, {});                           // NO incomplete flag
  eq(r.ok, true, "qualified + no future follow-up + no incomplete flag → SAVES (was 400)");
  const f = fieldsOf();
  eq(f["callCompletion.status"], "incomplete", "…recorded as 'incomplete', not 'complete'");
  ok(Array.isArray(f["callCompletion.gaps"]) && f["callCompletion.gaps"].length > 0,
    "…with the gap recorded, so the lead says what is missing");
  ok((f["callCompletion.gaps"] || []).includes("a locked next step"),
    "…using the same wording the cockpit already sends ('a locked next step')");
  ok(f["callCompletion.completedAt"] instanceof Date, "…and the call is stamped as completed");
}

console.log("\n2. THE MEASUREMENT SURVIVES — the event still records the truth");
{
  const id = mkLead(2, { qualified: true, followUps: [] });
  await complete(id, {});
  const ev = events.find((e) => e.type === "call_completed");
  ok(!!ev, "a call_completed event is still written");
  eq(ev && ev.payload.incomplete, true, "…flagged incomplete, so the trail is honest");
  ok((ev && ev.payload.gaps || []).includes("a locked next step"), "…and carries the gap");
}

console.log("\n3. NOTHING ELSE CHANGES");
{
  const id = mkLead(3, { qualified: true, followUps: future() });
  const r = await complete(id, {});
  eq(r.ok, true, "qualified WITH a future follow-up still saves");
  eq(fieldsOf()["callCompletion.status"], "complete", "…as 'complete'");
  eq((fieldsOf()["callCompletion.gaps"] || []).length, 0, "…with no gaps");
}
{
  const id = mkLead(4, { qualified: false, followUps: [] });
  const r = await complete(id, {});
  eq(r.ok, true, "an UNqualified lead with no follow-up still saves (never gated)");
  eq(fieldsOf()["callCompletion.status"], "complete", "…as 'complete' — the rule only ever applied to qualified");
}
{
  const id = mkLead(5, { qualified: true, followUps: [] });
  const r = await complete(id, { incomplete: true, gaps: ["email", "venue"] });
  eq(r.ok, true, "an explicit incomplete=true still works");
  eq(JSON.stringify(fieldsOf()["callCompletion.gaps"]), '["email","venue"]',
    "…and the caller's own gaps are preserved verbatim, not overwritten");
}
{
  // The one refusal that SHOULD remain: a malformed request is not a judgement
  // call about the lead, it is a broken payload.
  const id = mkLead(6, { qualified: true, followUps: [] });
  const r = await complete(id, { incomplete: true, gaps: "not-an-array" });
  eq(r.ok, false, "a malformed gaps payload is still rejected");
  eq(r.status, 400, "…with 400 — validation is not a discovery guard");
}
{
  const r = await complete(oid(99), {});
  eq(r.ok, false, "a missing lead is still 404");
  eq(r.status, 404, "…with 404");
}

console.log("\n4. THE MARKER STILL FIRES — it is now the only thing doing this job");
{
  const id = mkLead(7, { qualified: true, followUps: [] });
  await complete(id, {});
  const f = fieldsOf();
  ok("noFurtherAction.flagged" in f, "setNoFurtherAction still runs on the save path");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { console.error("suite crashed:", e.message); process.exit(1); });
