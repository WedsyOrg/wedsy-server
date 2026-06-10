/**
 * scripts/e2e-venue.js
 *
 * API-level end-to-end checks for the venue dashboard backend.
 * Runs against a live local server (default http://localhost:8090) using the
 * test owner's token (OTP dev-bypass login). Seed first with seed-test-venue.js.
 *
 * Prints PASS / FAIL / WARN per check; process exit code is non-zero if any
 * hard check FAILs. WARN = known main-feature gap, does not fail the suite.
 *
 * Usage: node scripts/e2e-venue.js
 * Env:   API_URL (default http://localhost:8090)
 */
const API = process.env.API_URL || "http://localhost:8090";
const SLUG = "test-palace";
const OWNER_PHONE = "9999999999";

let pass = 0, fail = 0, warn = 0;
const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  if (status === "PASS") pass++;
  else if (status === "FAIL") fail++;
  else warn++;
  const tag = status === "PASS" ? "✓ PASS" : status === "FAIL" ? "✗ FAIL" : "! WARN";
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function check(name, cond, detail) {
  record(cond ? "PASS" : "FAIL", name, detail);
  return cond;
}

async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function login() {
  // Dev OTP bypass: login accepts otp "000000" with any non-empty referenceId
  // when NODE_ENV !== "production". Avoids hitting external OTP senders.
  const { status, json } = await api("POST", "/venue-owner/auth", {
    body: { phone: OWNER_PHONE, otp: "000000", referenceId: "e2e-dev" },
  });
  if (status !== 200 || !json || !json.token) {
    throw new Error(`login failed (status ${status}): ${JSON.stringify(json)}`);
  }
  return json.token;
}

async function run() {
  console.log(`[e2e] target ${API}, venue ${SLUG}\n`);
  let token;
  try {
    token = await login();
    record("PASS", "owner login (OTP dev-bypass) returns token");
  } catch (e) {
    record("FAIL", "owner login", e.message);
    return finish();
  }

  // --- Check: dashboard overview shape ---
  {
    const { status, json } = await api("GET", "/venues/dashboard/overview", { token });
    const ok = status === 200 && json
      && json.onboarding && json.onboarding.steps
      && typeof json.onboarding.completed === "number"
      && typeof json.onboarding.total === "number"
      && typeof json.onboarding.percent === "number"
      && typeof json.isVerified === "boolean"
      && json.followUps
      && typeof json.followUps.dueToday === "number"
      && typeof json.followUps.overdue === "number";
    check("dashboard overview shape", ok, `status ${status}`);
  }

  // --- Check: manual lead create ---
  let manualId = null;
  {
    const phone = "9871230001";
    const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/manual`, {
      token,
      body: { coupleName: "E2E Manual Lead", couplePhone: phone, source: "walk_in", stage: "new", estimatedValue: 333000 },
    });
    const ok = [200, 201].includes(status) && json && (json.enquiryId || (json.enquiry && json.enquiry._id));
    manualId = json && (json.enquiryId || (json.enquiry && json.enquiry._id));
    check("manual lead create", ok, `status ${status}`);
  }

  // --- Check: import endpoint with one duplicate ---
  {
    // 9810000001 is a seeded lead (duplicate -> skipped); the other is new.
    const rows = [
      { coupleName: "Import New One", couplePhone: "9822220001", source: "google", stage: "new" },
      { coupleName: "Import Dup", couplePhone: "9810000001", source: "google", stage: "new" },
    ];
    const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/import`, {
      token,
      body: { rows, fileName: "e2e-inline.csv" },
    });
    const ok = status === 200 && json && json.created >= 1 && json.skipped >= 1;
    check("import endpoint (created>=1, dup skipped>=1)", ok, `status ${status} created=${json && json.created} skipped=${json && json.skipped}`);
  }

  // --- Check: interactions create + list ---
  {
    // Use the manual lead created above; fall back to first enquiry if needed.
    let targetId = manualId;
    if (!targetId) {
      const list = await api("GET", `/venues/${SLUG}/enquiries`, { token });
      targetId = list.json && list.json.enquiries && list.json.enquiries[0] && list.json.enquiries[0]._id;
    }
    const create = await api("POST", `/venues/${SLUG}/enquiries/${targetId}/interactions`, {
      token, body: { type: "call", note: "e2e logged call" },
    });
    const createdOk = [200, 201].includes(create.status) && create.json && create.json.interaction;
    const list = await api("GET", `/venues/${SLUG}/enquiries/${targetId}/interactions`, { token });
    const listedOk = list.status === 200 && Array.isArray(list.json && list.json.interactions)
      && list.json.interactions.some((i) => i.note === "e2e logged call");
    check("interaction create", createdOk, `status ${create.status}`);
    check("interaction list includes created", listedOk, `status ${list.status}`);
  }

  // --- Check: enquiry PATCH stage move (+ assignedTo) ---
  {
    let targetId = manualId;
    if (!targetId) {
      const list = await api("GET", `/venues/${SLUG}/enquiries`, { token });
      targetId = list.json.enquiries[0]._id;
    }
    const { status, json } = await api("PATCH", `/venues/${SLUG}/enquiries/${targetId}`, {
      token, body: { stage: "contacted", assignedTo: "E2E Manager" },
    });
    check("enquiry PATCH stage move", status === 200 && json && json.enquiry && json.enquiry.stage === "contacted", `status ${status}`);
    // assignedTo on the single-enquiry PATCH is NOT supported on main (controller
    // whitelist omits it). Report as WARN, not a hard failure.
    if (json && json.enquiry && json.enquiry.assignedTo === "E2E Manager") {
      record("PASS", "enquiry PATCH assignedTo persisted");
    } else {
      record("WARN", "enquiry PATCH assignedTo NOT persisted", "main controller whitelist omits assignedTo — flagged");
    }
  }

  // ================= Task B: member login determinism =================
  if (process.env.E2E_MEMBER_LOGIN === "1") {
    const MULTI = "8888888888";
    const r = await api("POST", "/venue-owner/auth", { body: { phone: MULTI, otp: "000000", referenceId: "dev" } });
    check("member-login: multi-identity returns multiple:true (no token)", r.status === 200 && r.json && r.json.multiple === true && !r.json.token, `status ${r.status}`);
    const ids = (r.json && r.json.identities) || [];
    check("member-login: 2 identities (owner + member)", ids.length === 2 && ids.some((i) => i.kind === "owner") && ids.some((i) => i.kind === "member"), `n=${ids.length}`);
    const selToken = r.json && r.json.selectionToken;
    check("member-login: selection token issued", Boolean(selToken));

    const ownerId = ids.find((i) => i.kind === "owner");
    const selO = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: selToken, kind: "owner", id: ownerId && ownerId.id } });
    const selOvenue = selO.json && selO.json.venueOwner && selO.json.venueOwner.venue;
    check("member-login: select owner identity mints token (Test Palace Two)", selO.status === 200 && selO.json.token && selOvenue && /Test Palace Two/.test(selOvenue.name || ""), `status ${selO.status}`);
    const ov = await api("GET", "/venues/dashboard/overview", { token: selO.json && selO.json.token });
    check("member-login: minted owner token authorizes dashboard", ov.status === 200, `status ${ov.status}`);

    const memId = ids.find((i) => i.kind === "member");
    const selM = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: selToken, kind: "member", id: memId && memId.id } });
    check("member-login: select member identity mints member token", selM.status === 200 && selM.json.token && selM.json.venueOwner && selM.json.venueOwner.isMember === true, `status ${selM.status}`);

    const bad = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: selToken, kind: "owner", id: "000000000000000000000000" } });
    check("member-login: unoffered identity -> 403", bad.status === 403, `status ${bad.status}`);

    const single = await api("POST", "/venue-owner/auth", { body: { phone: OWNER_PHONE, otp: "000000", referenceId: "dev" } });
    check("member-login: single-identity returns token directly (no picker)", single.status === 200 && single.json.token && !single.json.multiple, `status ${single.status}`);
  }

  finish();
}

function finish() {
  console.log(`\n[e2e] ${pass} passed, ${fail} failed, ${warn} warn`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("[e2e] crashed:", e);
  process.exit(1);
});
