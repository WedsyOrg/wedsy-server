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

// Fetch a binary endpoint (e.g. PDF). Returns { status, contentType, bytes, head }.
async function apiBinary(path, { token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method: "GET", headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type") || "", bytes: buf.length, head: buf.slice(0, 5).toString("latin1"), body: buf.toString("latin1") };
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

  // ================= Task 8 (Analytics 4.1) — runs FIRST, against pristine seed =================
  if (process.env.E2E_ANALYTICS === "1") {
    const { status, json } = await api("GET", `/venues/${SLUG}/analytics`, { token });
    check("analytics: total === 20 (seed)", status === 200 && json.total === 20, `total ${json && json.total}`);
    const volSum = (json.volume && json.volume.byMonth || []).reduce((s, r) => s + r.count, 0);
    check("analytics: volume byMonth sums to 20", volSum === 20, `sum ${volSum}`);
    check("analytics: funnel new=20 / site_visit_done=9 / booked=2",
      json.funnel && json.funnel.new === 20 && json.funnel.site_visit_done === 9 && json.funnel.booked === 2,
      json.funnel && `new=${json.funnel.new} svd=${json.funnel.site_visit_done} booked=${json.funnel.booked}`);
    check("analytics: funnel bookingRate = 10%", json.funnel && json.funnel.conversion.bookingRate === 10, json.funnel && `${json.funnel.conversion.bookingRate}`);
    const wedsy = (json.sources || []).find((s) => s.source === "wedsy");
    const srcSum = (json.sources || []).reduce((s, r) => s + r.count, 0);
    check("analytics: 8 sources, sum 20, wedsy count 3", json.sources.length === 8 && srcSum === 20 && wedsy && wedsy.count === 3, `len ${json.sources.length} sum ${srcSum} wedsy ${wedsy && wedsy.count}`);
    const lostTotal = (json.lostReasons || []).reduce((s, r) => s + r.count, 0);
    check("analytics: lost reasons total 2 (too_expensive + chose_competitor)", lostTotal === 2 && json.lostReasons.length === 2, `total ${lostTotal}`);
    check("analytics: revenue.byMonth is array, responseTime omitted (null)", Array.isArray(json.revenue.byMonth) && json.responseTime === null);
  }

  // The remaining checks mutate data, so when running analytics-only we stop here.
  if (process.env.E2E_ANALYTICS_ONLY === "1") return finish();

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

  // --- Check: duplicate-phone soft-warn exists endpoint ---
  {
    // The lead just created has phone 9871230001; a +91/spaced variant must
    // still match on the last-10 canonical digits.
    const hit = await api("GET", `/venues/${SLUG}/enquiries/exists?phone=${encodeURIComponent("+91 98712 30001")}`, { token });
    check("dup-warn: existing phone (last-10 canonical) -> exists:true + lead",
      hit.status === 200 && hit.json.exists === true && hit.json.lead && hit.json.lead._id,
      `status ${hit.status} exists=${hit.json && hit.json.exists}`);
    const miss = await api("GET", `/venues/${SLUG}/enquiries/exists?phone=9000000123`, { token });
    check("dup-warn: unknown phone -> exists:false", miss.status === 200 && miss.json.exists === false, `exists=${miss.json && miss.json.exists}`);
    const short = await api("GET", `/venues/${SLUG}/enquiries/exists?phone=123`, { token });
    check("dup-warn: <10 digits -> exists:false (no false match)", short.status === 200 && short.json.exists === false, `exists=${short.json && short.json.exists}`);
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

  // ================= Task 4: public enquiry rate limiting =================
  // Run against a freshly-started server (in-memory counters reset on restart).
  // Posts the same phone repeatedly to the PUBLIC enquiry endpoint; with the
  // default per-phone limit of 3/day, the 4th submission must return 429.
  if (process.env.E2E_RATELIMIT === "1") {
    const phone = "9871239999";
    let last = 0;
    let earlyOk = true;
    for (let i = 1; i <= 4; i++) {
      const { status } = await api("POST", `/venues/${SLUG}/enquiry`, {
        body: { coupleName: `RateLimit ${i}`, couplePhone: phone, source: "wedsy" },
      });
      if (i <= 3 && ![200, 201].includes(status)) earlyOk = false;
      last = status;
    }
    check("rate-limit: first 3 public enquiries accepted", earlyOk);
    check("rate-limit: 4th same-phone enquiry -> 429", last === 429, `last status ${last}`);
    // The gated /manual route must remain unaffected by the public limiter.
    const manual = await api("POST", `/venues/${SLUG}/enquiries/manual`, {
      token, body: { coupleName: "Manual Not Limited", couplePhone: "9871230077" },
    });
    check("rate-limit: gated /manual still works (not limited)", [200, 201].includes(manual.status), `status ${manual.status}`);
  }

  // ================= Task 3: bulk actions + templates + bulk-whatsapp =================
  if (process.env.E2E_BULK === "1") {
    const list = await api("GET", `/venues/${SLUG}/enquiries`, { token });
    const ids = (list.json && list.json.enquiries ? list.json.enquiries : []).slice(0, 2).map((e) => e._id);
    check("bulk: have >=2 enquiry ids", ids.length >= 2, `got ${ids.length}`);

    {
      const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/bulk`, {
        token, body: { enquiryIds: ids, action: "stage", value: "contacted" },
      });
      check("bulk action stage (updated==2)", status === 200 && json && json.updated === ids.length && Array.isArray(json.errors), `status ${status} updated=${json && json.updated}`);
    }
    {
      const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/bulk`, {
        token, body: { enquiryIds: ids, action: "assign", value: "Bulk Assignee" },
      });
      check("bulk action assign (updated==2)", status === 200 && json && json.updated === ids.length, `status ${status} updated=${json && json.updated}`);
    }
    {
      const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/bulk`, {
        token, body: { enquiryIds: ids, action: "note", value: "bulk note from e2e" },
      });
      check("bulk action note (updated==2)", status === 200 && json && json.updated === ids.length, `status ${status} updated=${json && json.updated}`);
    }
    {
      const { status } = await api("POST", `/venues/${SLUG}/enquiries/bulk`, {
        token, body: { enquiryIds: ids, action: "nope", value: "x" },
      });
      check("bulk action invalid -> 400", status === 400, `status ${status}`);
    }

    let templateId = null;
    {
      const create = await api("POST", `/venues/${SLUG}/templates`, { token, body: { name: "Welcome", body: "Hi, thanks for your enquiry!" } });
      templateId = create.json && create.json.template && create.json.template._id;
      check("template create -> 201", [200, 201].includes(create.status) && templateId, `status ${create.status}`);
      const listT = await api("GET", `/venues/${SLUG}/templates`, { token });
      check("template list includes created", listT.status === 200 && listT.json.templates.some((t) => t._id === templateId), `status ${listT.status}`);
      const upd = await api("PATCH", `/venues/${SLUG}/templates/${templateId}`, { token, body: { name: "Welcome v2" } });
      check("template update name", upd.status === 200 && upd.json.template.name === "Welcome v2", `status ${upd.status}`);
      const del = await api("DELETE", `/venues/${SLUG}/templates/${templateId}`, { token });
      check("template delete", del.status === 200 && del.json.success, `status ${del.status}`);
    }

    // bulk-whatsapp: e2e server instance runs with WhatsApp creds blanked so the
    // unconfigured 503 path is exercised — no real messages are ever sent.
    {
      const { status, json } = await api("POST", `/venues/${SLUG}/enquiries/bulk-whatsapp`, {
        token, body: { enquiryIds: ids, body: "hello from e2e" },
      });
      check("bulk-whatsapp unconfigured -> 503 {configured:false}", status === 503 && json && json.configured === false, `status ${status}`);
    }
  }

  // ================= Task 7 (Phase 3): lost reason, bookings, quotes, invoices, payments =================
  if (process.env.E2E_PHASE3 === "1") {
    const mk = async (name, estimatedValue) => {
      const r = await api("POST", `/venues/${SLUG}/enquiries/manual`, {
        token, body: { coupleName: name, couplePhone: `98${Math.floor(Math.random() * 1e8)}`.slice(0, 10), estimatedValue },
      });
      return r.json && (r.json.enquiryId || (r.json.enquiry && r.json.enquiry._id));
    };

    // 7a — lost reason
    {
      const L = await mk("P3 Lost", 100000);
      const ok = await api("PATCH", `/venues/${SLUG}/enquiries/${L}`, { token, body: { stage: "lost", lostReason: "too_expensive" } });
      check("7a lost reason set", ok.status === 200 && ok.json.enquiry.lostReason === "too_expensive", `status ${ok.status}`);
      const bad = await api("PATCH", `/venues/${SLUG}/enquiries/${L}`, { token, body: { lostReason: "banana" } });
      check("7a invalid lostReason -> 400", bad.status === 400, `status ${bad.status}`);
    }

    // 7b — booked -> auto-booking (idempotent)
    let bookingBV = null;
    const B = await mk("P3 Booked", 200000);
    {
      const r1 = await api("PATCH", `/venues/${SLUG}/enquiries/${B}`, { token, body: { stage: "booked" } });
      check("7b booked PATCH returns booking", r1.status === 200 && r1.json.booking && r1.json.booking._id, `status ${r1.status}`);
      const list1 = await api("GET", `/venues/${SLUG}/bookings`, { token });
      const forB = list1.json.bookings.filter((b) => String(b.enquiry) === String(B));
      bookingBV = forB[0] && forB[0]._id;
      check("7b exactly one booking for enquiry", forB.length === 1, `count ${forB.length}`);
      // idempotent: re-book
      await api("PATCH", `/venues/${SLUG}/enquiries/${B}`, { token, body: { stage: "negotiating" } });
      await api("PATCH", `/venues/${SLUG}/enquiries/${B}`, { token, body: { stage: "booked" } });
      const list2 = await api("GET", `/venues/${SLUG}/bookings`, { token });
      check("7b auto-booking idempotent (still one)", list2.json.bookings.filter((b) => String(b.enquiry) === String(B)).length === 1);
    }

    // 7c — quote create/version/totals/pdf + accept->booking
    let quoteV2 = null, bookingQV = null;
    const Q = await mk("P3 Quote", 0);
    {
      const c1 = await api("POST", `/venues/${SLUG}/quotes`, {
        token, body: { enquiry: Q, lineItems: [{ label: "Venue hire", category: "venue_hire", qty: 1, unitPrice: 100000 }], gstPercent: 18, discount: 5000 },
      });
      const t = c1.json.quote && c1.json.quote.totals;
      check("7c quote v1 totals (100000 / 18% / -5000 => 17100 / 112100)",
        c1.status === 201 && c1.json.quote.version === 1 && t.subtotal === 100000 && t.gst === 17100 && t.grandTotal === 112100,
        t && `subtotal=${t.subtotal} gst=${t.gst} grand=${t.grandTotal}`);
      const c2 = await api("POST", `/venues/${SLUG}/quotes`, {
        token, body: { enquiry: Q, lineItems: [{ label: "Venue hire", qty: 1, unitPrice: 100000 }], gstPercent: 18, discount: 5000 },
      });
      quoteV2 = c2.json.quote && c2.json.quote._id;
      check("7c new version supersedes prior", c2.json.quote.version === 2, `version ${c2.json.quote && c2.json.quote.version}`);
      const listQ = await api("GET", `/venues/${SLUG}/quotes?enquiry=${Q}`, { token });
      const v1 = listQ.json.quotes.find((x) => x.version === 1);
      check("7c prior version marked superseded", v1 && v1.status === "superseded", v1 && v1.status);
      const pdf = await apiBinary(`/venues/${SLUG}/quotes/${quoteV2}/pdf`, { token });
      check("7c quote PDF returns bytes", pdf.status === 200 && pdf.contentType.includes("pdf") && pdf.bytes > 500 && pdf.head.startsWith("%PDF"), `bytes=${pdf.bytes} ct=${pdf.contentType}`);
      const acc = await api("PATCH", `/venues/${SLUG}/quotes/${quoteV2}`, { token, body: { status: "accepted" } });
      bookingQV = acc.json.booking && acc.json.booking._id;
      check("7c accept quote -> booking (totalValue=grandTotal)", acc.status === 200 && acc.json.booking && acc.json.booking.totalValue === 112100, `tv=${acc.json.booking && acc.json.booking.totalValue}`);
    }

    // 7d — invoices: number increment, payments, status transitions, pdf
    {
      const i1 = await api("POST", `/venues/${SLUG}/invoices`, { token, body: { booking: bookingBV, kind: "advance" } });
      check("7d invoice create from booking", i1.status === 201 && i1.json.invoice.invoiceNumber, `#${i1.json.invoice && i1.json.invoice.invoiceNumber}`);
      const i1seq = i1.json.invoice.seq;
      const i1grand = i1.json.invoice.totals.grandTotal; // 200000 + 18% = 236000
      check("7d invoice totals from booking (200000 => 236000)", i1.json.invoice.totals.subtotal === 200000 && i1grand === 236000, `grand=${i1grand}`);
      const i2 = await api("POST", `/venues/${SLUG}/invoices`, { token, body: { booking: bookingQV } });
      check("7d invoice number increments", i2.json.invoice.seq === i1seq + 1, `seq ${i1seq} -> ${i2.json.invoice.seq}`);

      const invId = i1.json.invoice._id;
      const p1 = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token, body: { amount: 100000, mode: "upi" } });
      check("7d partial payment -> partially_paid", p1.status === 200 && p1.json.invoice.status === "partially_paid" && p1.json.balance === 136000, `status=${p1.json.invoice.status} bal=${p1.json.balance}`);
      const p2 = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token, body: { amount: 136000, mode: "bank_transfer" } });
      check("7d final payment -> paid (balance 0)", p2.status === 200 && p2.json.invoice.status === "paid" && p2.json.balance === 0, `status=${p2.json.invoice.status} bal=${p2.json.balance}`);
      const pdf = await apiBinary(`/venues/${SLUG}/invoices/${invId}/pdf`, { token });
      check("7d invoice PDF returns bytes", pdf.status === 200 && pdf.contentType.includes("pdf") && pdf.bytes > 500 && pdf.head.startsWith("%PDF"), `bytes=${pdf.bytes}`);
    }

    // 7e — payments summary math + overview revenue
    {
      const s = await api("GET", `/venues/${SLUG}/payments/summary`, { token });
      const t = s.json.totals;
      // confirmed = 200000 (BV) + 112100 (QV) = 312100 ; received = 236000 (BV invoice) ; pending = 76100
      check("7e payments summary math (312100 / 236000 / 76100)",
        s.status === 200 && t.confirmedValue === 312100 && t.received === 236000 && t.pending === 76100,
        `confirmed=${t.confirmedValue} received=${t.received} pending=${t.pending}`);
      const ov = await api("GET", `/venues/dashboard/overview`, { token });
      const r = ov.json.revenue;
      check("7e overview revenue shape + matches summary",
        r && r.confirmedValue === 312100 && r.received === 236000 && r.pending === 76100,
        r && `confirmed=${r.confirmedValue} received=${r.received} pending=${r.pending}`);
    }
  }

  // ================= Task 9: EV charging amenity (toggle -> save -> public read) =================
  if (process.env.E2E_EV === "1") {
    const on = await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: true } } });
    check("EV: PUT amenities.evCharging=true", [200, 201].includes(on.status), `status ${on.status}`);
    const pub1 = await api("GET", `/venues/${SLUG}`, {});
    const v1 = pub1.json && (pub1.json.venue || pub1.json);
    check("EV: public venue reflects evCharging=true", v1 && v1.amenities && v1.amenities.evCharging === true);
    const off = await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: false } } });
    const pub2 = await api("GET", `/venues/${SLUG}`, {});
    const v2 = pub2.json && (pub2.json.venue || pub2.json);
    check("EV: toggle back to false persists", off.status >= 200 && v2 && v2.amenities && v2.amenities.evCharging === false);
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

  // ================= Polish: role-gated sheets + member listing edit =================
  if (process.env.E2E_ROLES === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const loginToken = async (phone) => {
      const r = await api("POST", "/venue-owner/auth", { body: { phone, otp: "000000", referenceId: "dev" } });
      return r.json && r.json.token;
    };
    // listing_manager (single-identity member: listing+availability, NO leads).
    const lmToken = await loginToken("9700000002");
    // sales token via 8888888888's member identity (sales: leads only, NO listing).
    const multi = await api("POST", "/venue-owner/auth", { body: { phone: "8888888888", otp: "000000", referenceId: "dev" } });
    const memId = (multi.json.identities || []).find((i) => i.kind === "member");
    const salesSel = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: multi.json.selectionToken, kind: "member", id: memId && memId.id } });
    const salesToken = salesSel.json && salesSel.json.token;
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // (b) member listing edit via adminOrVenueOwnerAuth member-token support.
    const lmPut = await api("PUT", `/venues/${SLUG}`, { token: lmToken, body: { tagline: "lm-edit" } });
    check("roles: listing_manager listing PUT -> 200", lmPut.status === 200, `status ${lmPut.status}`);
    const salesPut = await api("PUT", `/venues/${SLUG}`, { token: salesToken, body: { tagline: "sales-edit" } });
    check("roles: sales listing PUT -> 403 (no listing cap)", salesPut.status === 403, `status ${salesPut.status}`);
    const adminPut = await api("PUT", `/venues/${SLUG}`, { token: adminToken, body: { tagline: "admin-edit" } });
    check("roles: admin listing PUT -> 200", adminPut.status === 200, `status ${adminPut.status}`);

    // (a) sheets routes now require leads -> listing_manager 403; open reads -> 200.
    const lmSheets = await api("GET", `/venues/${SLUG}/integrations/google-sheets`, { token: lmToken });
    check("roles: listing_manager sheets GET -> 403", lmSheets.status === 403, `status ${lmSheets.status}`);
    const lmSync = await api("POST", `/venues/${SLUG}/integrations/google-sheets/sync`, { token: lmToken });
    check("roles: listing_manager sheets sync -> 403", lmSync.status === 403, `status ${lmSync.status}`);
    const lmBookings = await api("GET", `/venues/${SLUG}/bookings`, { token: lmToken });
    check("roles: listing_manager bookings GET -> 200 (open read)", lmBookings.status === 200, `status ${lmBookings.status}`);
    const lmPayments = await api("GET", `/venues/${SLUG}/payments/summary`, { token: lmToken });
    check("roles: listing_manager payments GET -> 200 (open read)", lmPayments.status === 200, `status ${lmPayments.status}`);
  }

  // ================= Couple-side: isVerified, view beacon, availability, browse =================
  if (process.env.E2E_COUPLE === "1") {
    // isVerified on public detail (derived from status; test-palace is published -> false)
    const det = await api("GET", `/venues/${SLUG}`, {});
    check("couple: public detail exposes isVerified (false for published)", det.status === 200 && det.json.isVerified === false && det.json.venue, `isVerified ${det.json && det.json.isVerified}`);

    // view beacon (public) increments analytics views + conversion shape
    const beforeAn = await api("GET", `/venues/${SLUG}/analytics`, { token });
    const beforeViews = beforeAn.json.traffic ? beforeAn.json.traffic.views : -1;
    const v = await api("POST", `/venues/${SLUG}/view`, {});
    check("couple: public view beacon -> 200", v.status === 200, `status ${v.status}`);
    // The beacon is fire-and-forget (writes AFTER responding) — poll for the async write.
    let tr = null;
    for (let i = 0; i < 15; i++) {
      const a = await api("GET", `/venues/${SLUG}/analytics`, { token });
      tr = a.json.traffic;
      if (tr && tr.views > beforeViews) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    check("couple: analytics traffic shape {views,enquiries,conversionRate}", tr && typeof tr.views === "number" && typeof tr.enquiries === "number" && typeof tr.conversionRate === "number", JSON.stringify(tr));
    check("couple: view recorded (views >= 1)", tr && tr.views >= 1, `views ${tr && tr.views}`);

    // availability-check: block a date, then query
    await api("POST", `/venues/${SLUG}/availability`, { token, body: { blockedDates: ["2027-01-01"] } });
    const unavail = await api("GET", `/venues/${SLUG}/availability-check?date=2027-01-01`, {});
    check("couple: availability-check blocked date -> unavailable", unavail.status === 200 && unavail.json.status === "unavailable", `status ${unavail.json && unavail.json.status}`);
    const avail = await api("GET", `/venues/${SLUG}/availability-check?date=2027-06-15`, {});
    check("couple: availability-check free date -> available", avail.status === 200 && avail.json.status === "available", `status ${avail.json && avail.json.status}`);
    const badDate = await api("GET", `/venues/${SLUG}/availability-check?date=31-02-2026`, {});
    check("couple: availability-check invalid date -> 400", badDate.status === 400, `status ${badDate.status}`);

    // browse filters (public list)
    const byType = await api("GET", `/venues?venueType=banquet_hall&status=published`, {});
    check("couple: browse venueType filter returns matches", byType.status === 200 && Array.isArray(byType.json.venues) && byType.json.venues.every((x) => x.venueType === "banquet_hall"), `n ${byType.json && byType.json.venues && byType.json.venues.length}`);
    check("couple: browse list items expose isVerified (future-proof cards)", byType.json.venues.length > 0 && byType.json.venues.every((x) => typeof x.isVerified === "boolean"), "");
    const paged = await api("GET", `/venues?limit=1&status=published`, {});
    check("couple: browse pagination (limit=1 + total)", paged.status === 200 && paged.json.venues.length <= 1 && typeof paged.json.total === "number", `n ${paged.json.venues.length} total ${paged.json.total}`);
    // amenity filter: enable evCharging on test-palace, then filter
    await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: true } } });
    const byAmenity = await api("GET", `/venues?amenities=evCharging&status=published`, {});
    const hasTP = (byAmenity.json.venues || []).some((x) => x.slug === SLUG);
    check("couple: browse amenities=evCharging includes the toggled venue", byAmenity.status === 200 && hasTP, `found ${hasTP}`);
    await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: false } } });

    // ── Places proxy contract (auth-gated; no live Google call to avoid cost/key) ──
    const acNoAuth = await api("GET", `/places/autocomplete?input=mumbai`, {});
    check("places: autocomplete requires auth -> 401", acNoAuth.status === 401, `status ${acNoAuth.status}`);
    const detNoAuth = await api("GET", `/places/details?placeId=x`, {});
    check("places: details requires auth -> 401", detNoAuth.status === 401, `status ${detNoAuth.status}`);

    // ── policyDoc structured policies + backward compat ──
    await api("PUT", `/venues/${SLUG}`, { token, body: { policies: { otherRestrictions: "No outside DJ after 11pm", cancellation: "50% refund before 30 days", refund: "No refund within 7 days" } } });
    const r1 = await api("GET", `/venues/${SLUG}`, {});
    const pd1 = r1.json.venue.policyDoc;
    check("policyDoc: legacy policies migrated on read (otherRestrictions->policies, cancel/refund->refund)",
      pd1 && pd1.policies.includes("No outside DJ after 11pm") && pd1.refund.length >= 1, JSON.stringify(pd1));
    await api("PUT", `/venues/${SLUG}`, { token, body: { policyDoc: { policies: ["Clause A", "Clause B"], terms: ["T1"], refund: ["R1"] } } });
    const r2 = await api("GET", `/venues/${SLUG}`, {});
    const pd2 = r2.json.venue.policyDoc;
    check("policyDoc: structured value persists + precedes legacy",
      pd2 && pd2.policies.length === 2 && pd2.policies[0] === "Clause A" && pd2.terms[0] === "T1" && pd2.refund[0] === "R1", JSON.stringify(pd2));

    // ── onboarding requests (public) create + hostile input ──
    const onb = await api("POST", `/venues/onboarding-requests`, { body: { name: "Rohaan", venueName: "Crown Estate", city: "Bangalore", phone: "+91 98765 43210" } });
    check("onboarding: create -> 201 + id", [200, 201].includes(onb.status) && onb.json.id, `status ${onb.status}`);
    const onbMissing = await api("POST", `/venues/onboarding-requests`, { body: { venueName: "X", phone: "9876543210" } });
    check("onboarding: missing name -> 400", onbMissing.status === 400, `status ${onbMissing.status}`);
    const onbShort = await api("POST", `/venues/onboarding-requests`, { body: { name: "  ", venueName: "X", phone: "123" } });
    check("onboarding: blank name / short phone -> 400", onbShort.status === 400, `status ${onbShort.status}`);
    const onbNull = await api("POST", `/venues/onboarding-requests`, { rawBody: "null" });
    check("onboarding: null body -> not 500", onbNull.status !== 500, `status ${onbNull.status}`);
  }

  // ================= Phase 3.5: contracts (generate / edit / send / public ack / pdf) =================
  if (process.env.E2E_CONTRACTS === "1") {
    // Seed structured policies so generation has known content.
    await api("PUT", `/venues/${SLUG}`, { token, body: { policyDoc: { policies: ["No outside DJ after 11pm"], terms: ["50% advance to confirm"], refund: ["No refund within 7 days"] } } });
    const couplePhone = `95${String(Date.now() % 1e8).padStart(8, "0")}`;
    const bk = await api("POST", `/venues/${SLUG}/bookings`, {
      token,
      body: { coupleName: "Contract Couple", couplePhone, totalValue: 400000, days: [{ date: new Date(Date.now() + 30 * 86400000).toISOString(), eventType: "Wedding", guestCount: 250 }], paymentSchedule: [{ label: "Advance", amount: 100000 }] },
    });
    const bkId = bk.json.booking._id;

    // generate v1 — seeded from policyDoc + frozen specifics
    const g1 = await api("POST", `/venues/${SLUG}/bookings/${bkId}/contracts`, { token });
    const c1 = g1.json.contract;
    check("contracts: generate v1 seeds from policyDoc",
      g1.status === 201 && c1.version === 1 && c1.sections.length === 3
        && c1.sections[0].clauses[0] === "No outside DJ after 11pm"
        && c1.parties.coupleName === "Contract Couple"
        && c1.specifics.totalValue === 400000,
      `status ${g1.status} sections=${c1 && c1.sections.length}`);

    // edit while draft
    const ed = await api("PATCH", `/venues/${SLUG}/contracts/${c1._id}`, { token, body: { sections: [{ heading: "Venue Policies", clauses: ["No outside DJ after 11pm", "Decor by approved vendors only"] }] } });
    check("contracts: edit draft sections -> 200", ed.status === 200 && ed.json.contract.sections[0].clauses.length === 2, `status ${ed.status}`);
    const edBad = await api("PATCH", `/venues/${SLUG}/contracts/${c1._id}`, { token, body: { sections: [{ heading: "   ", clauses: ["x"] }] } });
    check("contracts: blank section heading -> 400", edBad.status === 400, `status ${edBad.status}`);

    // send -> public ack link
    const sent = await api("POST", `/venues/${SLUG}/contracts/${c1._id}/send`, { token });
    check("contracts: send -> sent + ack token", sent.status === 200 && sent.json.contract.status === "sent" && sent.json.contract.sentAt && sent.json.ackToken, `status ${sent.status}`);
    const ackToken = sent.json.ackToken;

    // public read (no auth) — phone masked
    const pub = await api("GET", `/venues/contract-ack/${ackToken}`, {});
    check("contracts: public ack GET shows contract, masks phone",
      pub.status === 200 && pub.json.contract.sections.length === 1 && /•/.test(pub.json.contract.parties.couplePhone),
      `status ${pub.status} phone=${pub.json.contract && pub.json.contract.parties.couplePhone}`);

    // garbage + tampered tokens rejected
    const badTok = await api("GET", `/venues/contract-ack/not-a-token`, {});
    check("contracts: garbage token -> 401", badTok.status === 401, `status ${badTok.status}`);
    const tampered = await api("POST", `/venues/contract-ack/${ackToken.slice(0, -2)}xx`, { body: { name: "X", phone: couplePhone } });
    check("contracts: tampered token -> 401", tampered.status === 401, `status ${tampered.status}`);

    // wrong phone -> 403; hostile name -> 400
    const wrong = await api("POST", `/venues/contract-ack/${ackToken}`, { body: { name: "Impostor", phone: "9000000000" } });
    check("contracts: wrong phone -> 403", wrong.status === 403, `status ${wrong.status}`);
    const blankName = await api("POST", `/venues/contract-ack/${ackToken}`, { body: { name: "   ", phone: couplePhone } });
    check("contracts: blank name -> 400", blankName.status === 400, `status ${blankName.status}`);

    // right phone -> acknowledged + stamps
    const ack = await api("POST", `/venues/contract-ack/${ackToken}`, { body: { name: "Contract Couple", phone: couplePhone } });
    check("contracts: matching phone -> acknowledged", ack.status === 200 && ack.json.acknowledgedAt, `status ${ack.status}`);
    const ackAgain = await api("POST", `/venues/contract-ack/${ackToken}`, { body: { name: "Again", phone: couplePhone } });
    check("contracts: double-acknowledge -> 409", ackAgain.status === 409, `status ${ackAgain.status}`);

    // pdf bytes — clean (no logo set) renders without an image object
    const pdf = await apiBinary(`/venues/${SLUG}/contracts/${c1._id}/pdf`, { token });
    check("contracts: PDF returns bytes", pdf.status === 200 && pdf.head.startsWith("%PDF") && pdf.bytes > 800, `bytes=${pdf.bytes}`);
    check("contracts: PDF without logo has no image object", pdf.status === 200 && !pdf.body.includes("/XObject"), `hasImage=${pdf.body.includes("/XObject")}`);

    // logo set -> contract PDF embeds the image object (graceful when cleared)
    const sharpLib = require("sharp");
    const logoJpeg = await sharpLib({ create: { width: 24, height: 24, channels: 3, background: { r: 107, g: 30, b: 46 } } }).jpeg().toBuffer();
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: `data:image/jpeg;base64,${logoJpeg.toString("base64")}` } });
    const pdfLogo = await apiBinary(`/venues/${SLUG}/contracts/${c1._id}/pdf`, { token });
    check("contracts: PDF embeds image object when logo set",
      pdfLogo.status === 200 && pdfLogo.head.startsWith("%PDF") && pdfLogo.body.includes("/XObject"),
      `bytes=${pdfLogo.bytes} hasImage=${pdfLogo.body.includes("/XObject")}`);
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: "" } });
    const pdfClean = await apiBinary(`/venues/${SLUG}/contracts/${c1._id}/pdf`, { token });
    check("contracts: PDF clean again after logo cleared", pdfClean.status === 200 && !pdfClean.body.includes("/XObject"), `hasImage=${pdfClean.body.includes("/XObject")}`);

    // new version supersedes (voids) prior non-acknowledged; acknowledged stays
    const g2 = await api("POST", `/venues/${SLUG}/bookings/${bkId}/contracts`, { token });
    check("contracts: v2 generated", g2.status === 201 && g2.json.contract.version === 2, `v=${g2.json.contract && g2.json.contract.version}`);
    const both = await api("GET", `/venues/${SLUG}/bookings/${bkId}/contracts`, { token });
    const v1After = both.json.contracts.find((c) => c.version === 1);
    check("contracts: acknowledged v1 NOT voided by v2", v1After && v1After.status === "acknowledged", `v1=${v1After && v1After.status}`);
    const g3 = await api("POST", `/venues/${SLUG}/bookings/${bkId}/contracts`, { token });
    const all3 = await api("GET", `/venues/${SLUG}/bookings/${bkId}/contracts`, { token });
    const v2After = all3.json.contracts.find((c) => c.version === 2);
    check("contracts: draft v2 voided by v3 (supersede)", g3.status === 201 && v2After && v2After.status === "void", `v2=${v2After && v2After.status}`);

    // draft-only editing: v1 (acknowledged) cannot be edited
    const edAck = await api("PATCH", `/venues/${SLUG}/contracts/${c1._id}`, { token, body: { sections: [] } });
    check("contracts: editing acknowledged contract -> 409", edAck.status === 409, `status ${edAck.status}`);
  }


  // ================= Venue logo on quote/invoice PDFs =================
  if (process.env.E2E_PDF_LOGO === "1") {
    // Tiny solid-colour JPEG via sharp (already a dependency) — no fixtures.
    const sharp = require("sharp");
    const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 107, g: 30, b: 46 } } }).jpeg().toBuffer();
    const dataUri = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

    const setLogo = await api("PUT", `/venues/${SLUG}`, { token, body: { logo: dataUri } });
    check("pdf-logo: PUT venue.logo (listing gate) -> 200", setLogo.status === 200 && setLogo.json.venue && setLogo.json.venue.logo === dataUri, `status ${setLogo.status}`);

    // Fresh lead -> quote -> PDF with the logo embedded as an image XObject.
    const lead = await api("POST", `/venues/${SLUG}/enquiries/manual`, { token, body: { coupleName: "PDF Logo Couple", couplePhone: `97${Date.now() % 1e8}` } });
    const leadId = lead.json.enquiryId || (lead.json.enquiry && lead.json.enquiry._id);
    const q = await api("POST", `/venues/${SLUG}/quotes`, { token, body: { enquiry: leadId, lineItems: [{ label: "Hall", qty: 1, unitPrice: 50000 }], gstPercent: 18, discount: 0 } });
    const quoteId = q.json.quote && q.json.quote._id;
    const withLogo = await apiBinary(`/venues/${SLUG}/quotes/${quoteId}/pdf`, { token });
    check("pdf-logo: quote PDF embeds image object when logo set",
      withLogo.status === 200 && withLogo.head.startsWith("%PDF") && withLogo.body.includes("/XObject"),
      `bytes=${withLogo.bytes} hasImage=${withLogo.body.includes("/XObject")}`);

    // Graceful absence: clear the logo -> same PDF renders with no image object.
    const clearLogo = await api("PUT", `/venues/${SLUG}`, { token, body: { logo: "" } });
    check("pdf-logo: clearing logo -> 200", clearLogo.status === 200, `status ${clearLogo.status}`);
    const without = await apiBinary(`/venues/${SLUG}/quotes/${quoteId}/pdf`, { token });
    check("pdf-logo: PDF without logo still renders (no image object)",
      without.status === 200 && without.head.startsWith("%PDF") && !without.body.includes("/XObject"),
      `bytes=${without.bytes}`);

    // Unreachable URL logo must degrade gracefully, never 500.
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: "http://127.0.0.1:9/nope.jpg" } });
    const broken = await apiBinary(`/venues/${SLUG}/quotes/${quoteId}/pdf`, { token });
    check("pdf-logo: unreachable logo URL degrades gracefully (200, no image)",
      broken.status === 200 && broken.head.startsWith("%PDF") && !broken.body.includes("/XObject"),
      `status ${broken.status}`);
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: "" } });
  }

  // ================= Phase 5 (PMS): rooms, allotments, runsheet, occupancy =================
  if (process.env.E2E_PMS === "1") {
    const day = (offset) => {
      const t = Date.now() + offset * 86400000;
      const d = new Date(t);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    const iso = (d) => d.toISOString();

    // ── rooms CRUD + hostile input ──
    const r1 = await api("POST", `/venues/${SLUG}/rooms`, { token, body: { name: "PMS Suite 1", type: "suite", capacity: 2 } });
    check("pms: add room -> 201", r1.status === 201 && r1.json.room && r1.json.room.name === "PMS Suite 1", `status ${r1.status}`);
    const roomA = r1.json.room && r1.json.room._id;
    const r2 = await api("POST", `/venues/${SLUG}/rooms`, { token, body: { name: "PMS Std 2", type: "standard", capacity: 3 } });
    const roomB = r2.json.room && r2.json.room._id;
    const rBadType = await api("POST", `/venues/${SLUG}/rooms`, { token, body: { name: "X", type: "penthouse" } });
    check("pms: bad room type -> 400", rBadType.status === 400, `status ${rBadType.status}`);
    const rBlank = await api("POST", `/venues/${SLUG}/rooms`, { token, body: { name: "   " } });
    check("pms: blank room name -> 400", rBlank.status === 400, `status ${rBlank.status}`);
    const rPatch = await api("PATCH", `/venues/${SLUG}/rooms/${roomA}`, { token, body: { capacity: 4, notes: "lake view" } });
    check("pms: patch room -> 200 persists", rPatch.status === 200 && rPatch.json.room.capacity === 4, `status ${rPatch.status}`);

    // ── booking with two days -> auto-seeded runsheet skeleton per day ──
    const bk = await api("POST", `/venues/${SLUG}/bookings`, {
      token,
      body: { coupleName: "PMS Couple", couplePhone: `96${Date.now() % 1e8}`, totalValue: 300000, days: [{ date: iso(day(7)), eventType: "Wedding", guestCount: 200 }, { date: iso(day(8)), eventType: "Reception", guestCount: 350 }] },
    });
    check("pms: booking with 2 days -> 201", bk.status === 201 && bk.json.booking, `status ${bk.status}`);
    const bkId = bk.json.booking._id;
    const rs0 = await api("GET", `/venues/${SLUG}/bookings/${bkId}/runsheet`, { token });
    check("pms: auto-seeded runsheet = 3 items × 2 days", rs0.status === 200 && rs0.json.items.length === 6 && rs0.json.items.every((i) => i.seeded), `n=${rs0.json.items && rs0.json.items.length}`);

    // ── allotment lifecycle ──
    const al1 = await api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, {
      token,
      body: { room: roomA, guestName: "Groom's family", checkInAt: iso(day(7)), checkOutAt: iso(day(9)) },
    });
    check("pms: allot room -> 201", al1.status === 201 && al1.json.allotments.length === 1, `status ${al1.status}`);
    const alId = al1.json.allotments[0] && al1.json.allotments[0]._id;

    // overlap rejected (different booking range overlapping night 8)
    const alOverlap = await api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, {
      token,
      body: { room: roomA, guestName: "Clash", checkInAt: iso(day(8)), checkOutAt: iso(day(10)) },
    });
    check("pms: overlapping allotment -> 409", alOverlap.status === 409, `status ${alOverlap.status}`);

    // CONCURRENCY: 5 simultaneous identical requests on roomB -> exactly one wins
    const burst = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, {
          token,
          body: { room: roomB, guestName: `Racer ${i}`, checkInAt: iso(day(7)), checkOutAt: iso(day(8)) },
        })
      )
    );
    const winners = burst.filter((r) => r.status === 201).length;
    const losers = burst.filter((r) => r.status === 409).length;
    check("pms: 5 concurrent same-room allotments -> exactly 1 wins, 4 conflict", winners === 1 && losers === 4, `winners=${winners} losers=${losers}`);

    // check-in stamps actualCheckInAt
    const ci = await api("PATCH", `/venues/${SLUG}/allotments/${alId}`, { token, body: { action: "check_in" } });
    check("pms: check-in stamps actualCheckInAt", ci.status === 200 && ci.json.allotment.status === "checked_in" && ci.json.allotment.actualCheckInAt, `status ${ci.status}`);
    const ciAgain = await api("PATCH", `/venues/${SLUG}/allotments/${alId}`, { token, body: { action: "check_in" } });
    check("pms: double check-in -> 409", ciAgain.status === 409, `status ${ciAgain.status}`);
    const co = await api("PATCH", `/venues/${SLUG}/allotments/${alId}`, { token, body: { action: "check_out" } });
    check("pms: check-out stamps actualCheckOutAt", co.status === 200 && co.json.allotment.status === "checked_out" && co.json.allotment.actualCheckOutAt, `status ${co.status}`);

    // cancel frees the range: cancel the roomB winner, re-allot same range OK
    const winnerId = burst.find((r) => r.status === 201).json.allotments[0]._id;
    const cancel = await api("PATCH", `/venues/${SLUG}/allotments/${winnerId}`, { token, body: { action: "cancel" } });
    check("pms: cancel allotment -> 200", cancel.status === 200 && cancel.json.allotment.status === "cancelled", `status ${cancel.status}`);
    const realot = await api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, {
      token,
      body: { room: roomB, guestName: "After cancel", checkInAt: iso(day(7)), checkOutAt: iso(day(8)) },
    });
    check("pms: cancelled range can be re-allotted", realot.status === 201, `status ${realot.status}`);

    // hostile allotment input
    const alBad = await api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, { token, body: { room: roomA, guestName: "X", checkInAt: "not-a-date", checkOutAt: iso(day(9)) } });
    check("pms: invalid checkInAt -> 400", alBad.status === 400, `status ${alBad.status}`);
    const alRev = await api("POST", `/venues/${SLUG}/bookings/${bkId}/allotments`, { token, body: { room: roomA, guestName: "X", checkInAt: iso(day(9)), checkOutAt: iso(day(7)) } });
    check("pms: checkOut before checkIn -> 400", alRev.status === 400, `status ${alRev.status}`);

    // ── runsheet CRUD + reorder + vendor wa.me field ──
    const it1 = await api("POST", `/venues/${SLUG}/bookings/${bkId}/runsheet`, {
      token,
      body: { day: iso(day(7)), time: "14:30", title: "Florist arrival", category: "vendor", vendorPhone: "9876501234", owner: "Asiya" },
    });
    check("pms: add vendor runsheet item -> 201", it1.status === 201 && it1.json.item.vendorPhone === "9876501234", `status ${it1.status}`);
    const itemId = it1.json.item._id;
    const itBadTime = await api("POST", `/venues/${SLUG}/bookings/${bkId}/runsheet`, { token, body: { day: iso(day(7)), time: "25:99", title: "X" } });
    check("pms: invalid time -> 400", itBadTime.status === 400, `status ${itBadTime.status}`);
    const itDone = await api("PATCH", `/venues/${SLUG}/runsheet/${itemId}`, { token, body: { status: "done" } });
    check("pms: runsheet check-off -> done", itDone.status === 200 && itDone.json.item.status === "done", `status ${itDone.status}`);

    const rsDay = await api("GET", `/venues/${SLUG}/bookings/${bkId}/runsheet?day=${iso(day(7))}`, { token });
    const dayIds = rsDay.json.items.map((i) => i._id);
    const reordered = await api("POST", `/venues/${SLUG}/bookings/${bkId}/runsheet/reorder`, { token, body: { day: iso(day(7)), ids: [...dayIds].reverse() } });
    check("pms: reorder persists (first becomes last)", reordered.status === 200 && String(reordered.json.items[0]._id) === String(dayIds[dayIds.length - 1]), `status ${reordered.status}`);
    const del = await api("DELETE", `/venues/${SLUG}/runsheet/${itemId}`, { token });
    check("pms: delete runsheet item -> 200", del.status === 200 && del.json.deleted, `status ${del.status}`);

    // ── occupancy matrix vs what we just created ──
    const occ = await api("GET", `/venues/${SLUG}/occupancy?from=${iso(day(6))}&to=${iso(day(10))}`, { token });
    const occOk = occ.status === 200 && Array.isArray(occ.json.days) && occ.json.days.length === 4 && Array.isArray(occ.json.rooms);
    check("pms: occupancy shape (4 days, rooms[])", occOk, `status ${occ.status} days=${occ.json.days && occ.json.days.length}`);
    if (occOk) {
      const occA = occ.json.rooms.find((r) => String(r._id) === String(roomA));
      const occB = occ.json.rooms.find((r) => String(r._id) === String(roomB));
      check("pms: occupancy shows roomA stay (checked_out) + roomB re-allotment",
        occA && occA.allotments.length >= 1 && occB && occB.allotments.some((a) => a.guestName === "After cancel"),
        `A=${occA && occA.allotments.length} B=${occB && occB.allotments.length}`);
      check("pms: cancelled allotment absent from occupancy", occB && !occB.allotments.some((a) => a.status === "cancelled"));
    }
    const occBad = await api("GET", `/venues/${SLUG}/occupancy?from=${iso(day(10))}&to=${iso(day(6))}`, { token });
    check("pms: occupancy to<=from -> 400", occBad.status === 400, `status ${occBad.status}`);

    // ── day added to existing booking -> new day auto-seeds ──
    const addDay = await api("PATCH", `/venues/${SLUG}/bookings/${bkId}`, {
      token,
      body: { days: [{ date: iso(day(7)), eventType: "Wedding", guestCount: 200 }, { date: iso(day(8)), eventType: "Reception", guestCount: 350 }, { date: iso(day(9)), eventType: "Brunch", guestCount: 80 }] },
    });
    const rs2 = await api("GET", `/venues/${SLUG}/bookings/${bkId}/runsheet`, { token });
    const day9Items = rs2.json.items.filter((i) => i.day && i.day.slice(0, 10) === iso(day(9)).slice(0, 10));
    check("pms: new booking day auto-seeds skeleton", addDay.status === 200 && day9Items.length === 3, `day9=${day9Items.length}`);
  }

  // ================= Phase 4.2: owner reviews (cache, rate limit, public payload) =================
  if (process.env.E2E_REVIEWS === "1") {
    // Seed gives test-palace a fresh deterministic cache -> served without Google.
    const r1 = await api("GET", `/venues/${SLUG}/reviews`, { token });
    check("reviews: owner GET serves the cached rating (no Google call)",
      r1.status === 200 && r1.json.cached === true && r1.json.rating === 4.6 && r1.json.count === 132 && r1.json.reviews.length === 1,
      `status ${r1.status} rating=${r1.json.rating} cached=${r1.json.cached}`);

    // Manual refresh with creds blanked -> graceful skip (no live call), still 200.
    const rf = await api("POST", `/venues/${SLUG}/reviews/refresh`, { token });
    check("reviews: refresh with blank creds -> 200 skipped (cache intact)",
      rf.status === 200 && rf.json.skipped && rf.json.rating === 4.6, `status ${rf.status} skipped=${rf.json.skipped}`);

    // Couple-side enrichment route (public) now shares utils/venueGoogleReviews:
    // a fresh 7-day cache serves cached with the legacy { reviews, rating, total } shape.
    const couple = await api("POST", `/venues/${SLUG}/reviews`, {});
    check("reviews: couple-side route serves cached via shared util (legacy shape)",
      couple.status === 200 && couple.json.cached === true && couple.json.rating === 4.6 && couple.json.total === 132 && Array.isArray(couple.json.reviews),
      `status ${couple.status} rating=${couple.json.rating} total=${couple.json.total} cached=${couple.json.cached}`);

    // Refresh rate limit: burst past the limiter -> 429 present.
    const burst = await Promise.all(Array.from({ length: 6 }, () => api("POST", `/venues/${SLUG}/reviews/refresh`, { token })));
    check("reviews: refresh burst -> 429 rate limit", burst.some((r) => r.status === 429), `statuses ${[...new Set(burst.map((r) => r.status))].join(",")}`);

    // Public detail: rating + count exposed, individual review texts ABSENT.
    const pub = await api("GET", `/venues/${SLUG}`, {});
    const v = pub.json.venue || {};
    check("reviews: public detail exposes rating+count ONLY (no texts)",
      pub.status === 200 && v.googleRating === 4.6 && v.googleReviewCount === 132 && v.googleReviews === undefined,
      `rating=${v.googleRating} texts=${JSON.stringify(v.googleReviews)}`);

    // Public browse list: same guarantee (select already excludes texts).
    const list = await api("GET", `/venues?limit=3`, {});
    const items = list.json.venues || list.json || [];
    check("reviews: public list never includes review texts",
      list.status === 200 && items.length > 0 && items.every((x) => x.googleReviews === undefined), `n=${items.length}`);
  }

  // ================= Phase 4.3: competitor insights (live endpoint shape + cache) =================
  // (Cohort math + suppression are exercised deterministically by
  // scripts/e2e-competitive.js; here we confirm the live route + caching + auth.)
  if (process.env.E2E_COMPETITIVE === "1") {
    const c1 = await api("GET", `/venues/${SLUG}/competitive`, { token });
    const validShape = c1.status === 200 && c1.json && typeof c1.json.cohortSize === "number"
      && (c1.json.suppressedAll === true || (c1.json.metrics && c1.json.metrics.enquiries));
    check("competitive: GET returns a valid shape", validShape, `status ${c1.status} size=${c1.json && c1.json.cohortSize}`);
    // Never leaks competitor identifiers regardless of cohort.
    const blob = JSON.stringify(c1.json || {});
    check("competitive: payload carries no other venue slugs/ids",
      !/test-palace-two/.test(blob) && !/"slug"/.test(blob), "no per-competitor fields");
    // Second call is served from the 24h cache.
    const c2 = await api("GET", `/venues/${SLUG}/competitive`, { token });
    check("competitive: second call is cached", c2.status === 200 && c2.json.cached === true, `cached=${c2.json && c2.json.cached}`);
  }

  // ================= Multi-property: my-venues / switch-venue / portfolio =================
  if (process.env.E2E_MULTIPROP === "1") {
    const PORT_PHONE = "7777777777";
    // Owns 3 venues -> login returns a picker. Select one to get a session token.
    const login3 = await api("POST", "/venue-owner/auth", { body: { phone: PORT_PHONE, otp: "000000", referenceId: "dev" } });
    check("multiprop: 3-venue owner login -> picker with 3 owner identities",
      login3.status === 200 && login3.json.multiple === true && (login3.json.identities || []).length === 3 && login3.json.identities.every((i) => i.kind === "owner"),
      `n=${login3.json.identities && login3.json.identities.length}`);
    const firstId = login3.json.identities[0];
    const sel = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: login3.json.selectionToken, kind: "owner", id: firstId.id } });
    const ptoken = sel.json && sel.json.token;
    check("multiprop: select-identity mints a session token", sel.status === 200 && Boolean(ptoken), `status ${sel.status}`);

    // my-venues: exactly the 3 owned venues; the deactivated test-palace membership is excluded.
    const mv = await api("GET", "/venue-owner/my-venues", { token: ptoken });
    const slugs = (mv.json.venues || []).map((v) => v.slug).sort();
    check("multiprop: my-venues lists the 3 owned venues, deactivated membership excluded",
      mv.status === 200 && mv.json.count === 3 && slugs.join(",") === "portfolio-alpha,portfolio-beta,portfolio-gamma" && mv.json.venues.every((v) => v.role === "owner"),
      `slugs=${slugs.join(",")}`);
    check("multiprop: my-venues flags exactly one current venue", (mv.json.venues || []).filter((v) => v.current).length === 1);

    // switch-venue to another owned venue -> token works on that venue's dashboard.
    const target = mv.json.venues.find((v) => !v.current);
    const sw = await api("POST", "/venue-owner/switch-venue", { token: ptoken, body: { venueId: target.venueId } });
    check("multiprop: switch-venue mints a token for the chosen venue", sw.status === 200 && sw.json.token, `status ${sw.status}`);
    const swOv = await api("GET", "/venues/dashboard/overview", { token: sw.json.token });
    check("multiprop: switched token authorizes that venue's dashboard", swOv.status === 200, `status ${swOv.status}`);
    const swMv = await api("GET", "/venue-owner/my-venues", { token: sw.json.token });
    const nowCurrent = (swMv.json.venues || []).find((v) => v.current);
    check("multiprop: switched token's current venue is the target", nowCurrent && nowCurrent.venueId === target.venueId, `current=${nowCurrent && nowCurrent.slug}`);

    // switch to a venue this phone does NOT own -> 403 (re-verified from DB).
    const tp = await api("GET", `/venues/${SLUG}`, {});
    const notOwned = tp.json.venue && tp.json.venue._id;
    const swBad = await api("POST", "/venue-owner/switch-venue", { token: ptoken, body: { venueId: notOwned } });
    check("multiprop: switch to a non-owned venue -> 403", swBad.status === 403, `status ${swBad.status}`);

    // portfolio overview: 3 rows + totals = sum of rows.
    const pf = await api("GET", "/venue-owner/portfolio/overview", { token: ptoken });
    const rows = pf.json.venues || [];
    const sumLeads = rows.reduce((s, r) => s + r.newLeads7d, 0);
    const sumPending = rows.reduce((s, r) => s + r.revenuePending, 0);
    check("multiprop: portfolio overview returns 3 owned venues with KPIs",
      pf.status === 200 && pf.json.count === 3 && rows.every((r) => typeof r.newLeads7d === "number" && typeof r.revenuePending === "number" && typeof r.bookingsUpcoming === "number"),
      `count=${pf.json.count}`);
    check("multiprop: portfolio totals == sum of per-venue rows",
      pf.json.totals && pf.json.totals.newLeads7d === sumLeads && pf.json.totals.revenuePending === sumPending,
      `totals=${JSON.stringify(pf.json.totals)}`);
    // Each portfolio venue seeded with 2 recent leads + 1 upcoming booking.
    check("multiprop: seeded KPIs are non-zero (2 leads, 1 upcoming booking per venue)",
      rows.every((r) => r.newLeads7d === 2 && r.bookingsUpcoming === 1 && r.followUpsDue >= 1),
      JSON.stringify(rows.map((r) => ({ s: r.slug, l: r.newLeads7d, b: r.bookingsUpcoming, f: r.followUpsDue }))));
  }

  // The public-ratelimit drain MUST run last: it exhausts the shared per-IP
  // publicReadLimiter bucket that other public routes (couple reviews, onboarding,
  // availability) also use.
  // ================= Public-route rate limiting (callback + generate-location) =================
  // Run on a freshly-started server (publicReadLimiter counters reset on restart).
  if (process.env.E2E_PUBLIC_RATELIMIT === "1") {
    // Burst the public sheets OAuth callback past the per-IP publicReadLimiter.
    const burst = await Promise.all(Array.from({ length: 75 }, () =>
      api("GET", `/venues/${SLUG}/integrations/google-sheets/callback`, {})));
    const statuses = [...new Set(burst.map((r) => r.status))];
    check("public-ratelimit: sheets callback burst -> 429 present", burst.some((r) => r.status === 429), `statuses ${statuses.join(",")}`);
    // The per-IP bucket (shared across publicReadLimiter routes) is now exhausted,
    // so generate-location-description 429s at the limiter — BEFORE invoking Anthropic.
    const gen = await api("POST", `/venues/${SLUG}/generate-location-description`, {});
    check("public-ratelimit: generate-location-description over-limit -> 429 (no Anthropic call)", gen.status === 429, `status ${gen.status}`);
    // Shared bucket exhausted -> onboarding 429s at the limiter (no record created).
    const onbOver = await api("POST", `/venues/onboarding-requests`, { body: { name: "R", venueName: "V", phone: "9876543210" } });
    check("public-ratelimit: onboarding over-limit -> 429 (no record created)", onbOver.status === 429, `status ${onbOver.status}`);
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
