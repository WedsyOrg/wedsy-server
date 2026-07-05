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

// E3x: pdfkit compresses content streams (FlateDecode) and shows text as
// HEX-encoded kerned TJ arrays ([<50> 50 <6f> …] TJ). To grep for a footer or
// system line: inflate every stream…endstream chunk, then hex-decode all
// <…> show strings in order — kerning splits mid-word, so concatenating the
// decoded segments reassembles the original line ("Powered by Wedsy").
function pdfText(latin1Body) {
  const zlib = require("zlib");
  const buf = Buffer.from(latin1Body, "latin1");
  let raw = "";
  let idx = 0;
  for (;;) {
    const s = buf.indexOf("stream", idx);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf("endstream", start);
    if (e === -1) break;
    const chunk = buf.slice(start, e);
    try { raw += zlib.inflateSync(chunk).toString("latin1"); }
    catch { raw += chunk.toString("latin1"); } // uncompressed stream
    idx = e + 9;
  }
  let out = "";
  for (const m of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    out += Buffer.from(m[1], "hex").toString("latin1");
  }
  // Literal-paren show strings too (uncompressed/simple writers).
  for (const m of raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    out += "\n" + m[1];
  }
  return out;
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

  // ================= RBAC v2 (D5): bundles, member email login, owner reset =================
  if (process.env.E2E_RBAC === "1") {
    // Roles list seeds system Owner + 4 defaults and migrates legacy members.
    const rl = await api("GET", `/venues/${SLUG}/roles`, { token });
    const names = (rl.json.roles || []).map((r) => r.name);
    check("rbac: roles list seeds Owner + 4 defaults",
      rl.status === 200 && ["Owner", "Manager", "Sales", "Front Desk", "Accounts"].every((n) => names.includes(n)),
      `status ${rl.status} names=${names.join(",")}`);
    const ownerRole = (rl.json.roles || []).find((r) => r.isSystem);
    check("rbac: system Owner role has every capability",
      ownerRole && Array.isArray(rl.json.capabilities) && rl.json.capabilities.every((c) => ownerRole.capabilities.includes(c)),
      `caps=${ownerRole && ownerRole.capabilities.length}`);

    // Legacy members got migrated onto capability-preserving bundles.
    const team = await api("GET", `/venues/${SLUG}/team`, { token });
    const legacyLm = (team.json.members || []).find((m) => m.role === "listing_manager");
    check("rbac: legacy listing_manager migrated to a capability-preserving bundle",
      legacyLm && legacyLm.roleRef && legacyLm.roleRef.name === "Listing Manager", `bundle=${legacyLm && legacyLm.roleRef && legacyLm.roleRef.name}`);

    // Custom role: starts insights-only.
    const cr = await api("POST", `/venues/${SLUG}/roles`, { token, body: { name: "Auditor", capabilities: ["insights"] } });
    check("rbac: create custom role -> 201", cr.status === 201 && cr.json.role && cr.json.role.name === "Auditor", `status ${cr.status}`);
    const auditorId = cr.json.role && cr.json.role._id;
    const crBad = await api("POST", `/venues/${SLUG}/roles`, { token, body: { name: "Bad", capabilities: ["superpowers"] } });
    check("rbac: unknown capability -> 400", crBad.status === 400, `status ${crBad.status}`);

    // Invite a member with email + generated temp password on the custom role.
    const inv = await api("POST", `/venues/${SLUG}/team`, {
      token,
      body: { name: "Rita Auditor", phone: "9333300001", email: "Rita@Test-Palace.local", roleId: auditorId, withPassword: true },
    });
    check("rbac: invite with email + temp password -> 201 + password returned once",
      inv.status === 201 && inv.json.tempPassword && inv.json.member && !inv.json.member.passwordHash, `status ${inv.status}`);
    const ritaPass = inv.json.tempPassword;
    const ritaId = inv.json.member && inv.json.member._id;

    // Email login (case-insensitive email), same member JWT shape.
    const ml = await api("POST", "/venue-owner/member-auth", { body: { email: "rita@test-palace.local", password: ritaPass } });
    check("rbac: member email login -> 200 member token", ml.status === 200 && ml.json.token && ml.json.venueOwner && ml.json.venueOwner.isMember === true, `status ${ml.status}`);
    const ritaToken = ml.json.token;
    const mlBad = await api("POST", "/venue-owner/member-auth", { body: { email: "rita@test-palace.local", password: "wrong-password" } });
    check("rbac: wrong password -> 401", mlBad.status === 401, `status ${mlBad.status}`);

    // Capability enforcement through the bundle: insights yes, leads no.
    const ritaLeadsDenied = await api("POST", `/venues/${SLUG}/enquiries/manual`, { token: ritaToken, body: { coupleName: "X", couplePhone: "9111100001" } });
    check("rbac: custom role without leads -> 403 on lead write", ritaLeadsDenied.status === 403, `status ${ritaLeadsDenied.status}`);

    // Live grant: owner adds leads to the bundle -> same token now passes.
    const grant = await api("PATCH", `/venues/${SLUG}/roles/${auditorId}`, { token, body: { capabilities: ["insights", "leads"] } });
    check("rbac: owner edits bundle -> 200", grant.status === 200, `status ${grant.status}`);
    const ritaLeadsOk = await api("POST", `/venues/${SLUG}/enquiries/manual`, { token: ritaToken, body: { coupleName: "RBAC Lead", couplePhone: "9111100002" } });
    check("rbac: grant applies to LIVE token (no re-login)", [200, 201].includes(ritaLeadsOk.status), `status ${ritaLeadsOk.status}`);

    // System Owner role immutable; role with members undeletable (409 → reassign → delete OK).
    const sysEdit = await api("PATCH", `/venues/${SLUG}/roles/${ownerRole._id}`, { token, body: { name: "Root" } });
    check("rbac: system Owner role edit -> 403", sysEdit.status === 403, `status ${sysEdit.status}`);
    const delWithMembers = await api("DELETE", `/venues/${SLUG}/roles/${auditorId}`, { token });
    check("rbac: delete role with members -> 409", delWithMembers.status === 409, `status ${delWithMembers.status}`);
    const salesRole = (rl.json.roles || []).find((r) => r.name === "Sales");
    await api("PATCH", `/venues/${SLUG}/team/${ritaId}`, { token, body: { roleId: salesRole._id } });
    const delEmpty = await api("DELETE", `/venues/${SLUG}/roles/${auditorId}`, { token });
    check("rbac: delete after reassign -> 200", delEmpty.status === 200, `status ${delEmpty.status}`);

    // Owner resets the member's password: old stops working, new works.
    const reset = await api("POST", `/venues/${SLUG}/team/${ritaId}/password`, { token, body: {} });
    check("rbac: owner reset issues new temp password", reset.status === 200 && reset.json.tempPassword, `status ${reset.status}`);
    const oldLogin = await api("POST", "/venue-owner/member-auth", { body: { email: "rita@test-palace.local", password: ritaPass } });
    check("rbac: old password -> 401 after reset", oldLogin.status === 401, `status ${oldLogin.status}`);
    const newLogin = await api("POST", "/venue-owner/member-auth", { body: { email: "rita@test-palace.local", password: reset.json.tempPassword } });
    check("rbac: new password logs in", newLogin.status === 200 && newLogin.json.token, `status ${newLogin.status}`);

    // Member cannot reset passwords even with a team-capability bundle path
    // (owner-only), and a deactivated member's live token dies per-request.
    const ritaReset = await api("POST", `/venues/${SLUG}/team/${ritaId}/password`, { token: newLogin.json.token, body: {} });
    check("rbac: member password reset -> 403 (owner-only)", ritaReset.status === 403, `status ${ritaReset.status}`);

    // ── Owner-actor escalation guard (Jul 2026 security fix) ──
    // A member holding a CUSTOM role WITH the team capability reaches the
    // controller-level owner guards (the route only gates on `team`). Before
    // the fix, isOwnerActor(req) fell through to the owner branch and let this
    // member escalate. Assert the owner-only guards now hold — AND that a
    // team-capability member can still do legitimate, non-owner team ops.
    const tmRole = await api("POST", `/venues/${SLUG}/roles`, { token, body: { name: "Team Lead", capabilities: ["team", "leads"] } });
    check("rbac(esc): create team-capability custom role -> 201", tmRole.status === 201, `status ${tmRole.status}`);
    const tmRoleId = tmRole.json.role && tmRole.json.role._id;
    const tmInv = await api("POST", `/venues/${SLUG}/team`, { token, body: { name: "Tara Lead", phone: "9333300009", email: "tara@test-palace.local", roleId: tmRoleId, withPassword: true } });
    check("rbac(esc): invite team-capability member -> 201", tmInv.status === 201 && tmInv.json.tempPassword, `status ${tmInv.status}`);
    const taraId = tmInv.json.member && tmInv.json.member._id;
    const tmLogin = await api("POST", "/venue-owner/member-auth", { body: { email: "tara@test-palace.local", password: tmInv.json.tempPassword } });
    check("rbac(esc): team-capability member logs in", tmLogin.status === 200 && tmLogin.json.token, `status ${tmLogin.status}`);
    const taraToken = tmLogin.json.token;

    // (a) setMemberPassword on another member -> 403 (owner-only, not team)
    const escReset = await api("POST", `/venues/${SLUG}/team/${ritaId}/password`, { token: taraToken, body: {} });
    check("rbac(esc): team-cap member resets another's password -> 403", escReset.status === 403, `status ${escReset.status}`);
    // (b) assign the system Owner bundle to ANOTHER member -> 403 (the
    // owner-bundle guard; self-grant is separately blocked 400 by self-modify).
    const escOwn = await api("PATCH", `/venues/${SLUG}/team/${ritaId}`, { token: taraToken, body: { roleId: ownerRole._id } });
    check("rbac(esc): team-cap member grants another the Owner bundle -> 403", escOwn.status === 403, `status ${escOwn.status}`);
    const escSelf = await api("PATCH", `/venues/${SLUG}/team/${taraId}`, { token: taraToken, body: { roleId: ownerRole._id } });
    check("rbac(esc): team-cap member self-grant Owner bundle -> 400 (self-modify)", escSelf.status === 400, `status ${escSelf.status}`);
    // (b') grant Owner bundle at invite time -> 403
    const escInvOwn = await api("POST", `/venues/${SLUG}/team`, { token: taraToken, body: { name: "Puppet", phone: "9333300010", email: "puppet@test-palace.local", roleId: ownerRole._id } });
    check("rbac(esc): team-cap member invites onto Owner bundle -> 403", escInvOwn.status === 403, `status ${escInvOwn.status}`);
    // (c) owner does the same two ops -> success (guard doesn't over-block owner)
    const ownReset = await api("POST", `/venues/${SLUG}/team/${taraId}/password`, { token, body: {} });
    check("rbac(esc): owner resets member password -> 200", ownReset.status === 200 && ownReset.json.tempPassword, `status ${ownReset.status}`);
    const ownGrantsOwner = await api("PATCH", `/venues/${SLUG}/team/${ritaId}`, { token, body: { roleId: ownerRole._id } });
    check("rbac(esc): owner assigns Owner bundle -> 200", ownGrantsOwner.status === 200, `status ${ownGrantsOwner.status}`);
    // reassign Rita back off the Owner bundle so later checks are unaffected
    await api("PATCH", `/venues/${SLUG}/team/${ritaId}`, { token, body: { roleId: salesRole._id } });
    // (legit) team-capability member CAN do non-owner team ops: invite a
    // plain member and edit a non-system role — the fix doesn't over-block.
    const tmLegitInv = await api("POST", `/venues/${SLUG}/team`, { token: taraToken, body: { name: "Vik Helper", phone: "9333300011", email: "vik@test-palace.local", roleId: salesRole._id } });
    check("rbac(esc): team-cap member invites non-owner member -> 201", tmLegitInv.status === 201, `status ${tmLegitInv.status}`);
    const tmLegitEdit = await api("PATCH", `/venues/${SLUG}/roles/${tmRoleId}`, { token: taraToken, body: { capabilities: ["team", "leads", "chats"] } });
    check("rbac(esc): team-cap member edits non-system role -> 200", tmLegitEdit.status === 200, `status ${tmLegitEdit.status}`);

    await api("PATCH", `/venues/${SLUG}/team/${ritaId}`, { token, body: { isActive: false } });
    const deadToken = await api("GET", `/venues/${SLUG}/enquiries`, { token: newLogin.json.token });
    check("rbac: deactivated member live token -> 401", deadToken.status === 401, `status ${deadToken.status}`);
  }

  // ================= D3: date-inventory, holds, calendar =================
  if (process.env.E2E_HOLDS === "1") {
    const jwtH = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwtH.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const hday = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

    // spaces present on the venue (from seed), incl. a non-bookable one
    const det0 = await api("GET", `/venues/${SLUG}`, {});
    const allSpaces = (det0.json.venue.spaces || []);
    const lawn = allSpaces.find((s) => s.name === "Grand Lawn");
    const gazebo = allSpaces.find((s) => s.name === "Photo Gazebo");
    check("holds: seed venue has bookable spaces", Boolean(lawn && gazebo), `n=${allSpaces.length}`);

    // wedsy-side (admin JWT) hold request -> requested, owner untouched
    const wReq = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(40), hday(41)], space: lawn._id, requestedByName: "Wedsy CRM", notes: "Couple shortlisted you" } });
    check("holds: wedsy-side create -> 201 requested (admin JWT)", wReq.status === 201 && wReq.json.hold.status === "requested" && wReq.json.hold.requestedBy === "wedsy", `status ${wReq.status}`);
    const holdA = wReq.json.hold;

    // non-bookable space rejected; bad dates rejected
    const badSpace = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(40)], space: gazebo._id } });
    check("holds: non-bookable space -> 400", badSpace.status === 400, `status ${badSpace.status}`);
    const badDates = await api("POST", `/venues/${SLUG}/holds`, { token, body: { dates: ["not-a-date"] } });
    check("holds: malformed dates -> 400", badDates.status === 400, `status ${badDates.status}`);

    // owner approves -> SpaceDate rows claimed, calendar shows held
    const app1 = await api("POST", `/venues/${SLUG}/holds/${holdA._id}/approve`, { token });
    check("holds: owner approve -> 200 + rows claimed", app1.status === 200 && app1.json.claimed === 2, `status ${app1.status} claimed=${app1.json.claimed}`);
    const calMonth = hday(40).slice(0, 7);
    const cal1 = await api("GET", `/venues/${SLUG}/calendar?from=${hday(40)}&to=${hday(41)}`, { token });
    const day40 = cal1.json.days && cal1.json.days.find((d) => d.date === hday(40));
    check("holds: calendar merges held state", cal1.status === 200 && day40 && day40.spaces.some((s) => s.state === "held"), `spaces=${day40 && JSON.stringify(day40.spaces.map((s) => s.state))}`);

    // overlapping second hold approval -> 409 (unique-index guard)
    const wReq2 = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(41)], space: lawn._id } });
    const app2 = await api("POST", `/venues/${SLUG}/holds/${wReq2.json.hold._id}/approve`, { token });
    check("holds: overlapping approve -> 409", app2.status === 409, `status ${app2.status}`);

    // RACE: 5 holds on one fresh space-date, approved concurrently -> exactly one wins
    const raceHolds = [];
    for (let i = 0; i < 5; i++) {
      const r = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(50)], space: lawn._id, requestedByName: `racer-${i}` } });
      raceHolds.push(r.json.hold);
    }
    const raceResults = await Promise.all(raceHolds.map((h) => api("POST", `/venues/${SLUG}/holds/${h._id}/approve`, { token })));
    const raceWins = raceResults.filter((r) => r.status === 200).length;
    const raceLosses = raceResults.filter((r) => r.status === 409).length;
    check("holds: 5-way concurrent approve race -> exactly one wins", raceWins === 1 && raceLosses === 4, `wins=${raceWins} losses=${raceLosses}`);

    // decline + release
    const dReq = await api("POST", `/venues/${SLUG}/holds`, { token, body: { dates: [hday(60)] } });
    const dec = await api("POST", `/venues/${SLUG}/holds/${dReq.json.hold._id}/decline`, { token, body: { notes: "date clash" } });
    check("holds: decline -> 200 declined", dec.status === 200 && dec.json.hold.status === "declined", `status ${dec.status}`);
    const rel = await api("POST", `/venues/${SLUG}/holds/${holdA._id}/release`, { token });
    check("holds: release frees the dates", rel.status === 200 && rel.json.hold.status === "released", `status ${rel.status}`);
    const calFree = await api("GET", `/venues/${SLUG}/calendar?from=${hday(40)}&to=${hday(41)}`, { token });
    const day40b = calFree.json.days.find((d) => d.date === hday(40));
    check("holds: released dates open again", day40b && day40b.spaces.length === 0, `spaces=${day40b && day40b.spaces.length}`);

    // convert-on-booking flips held -> booked atomically
    const cReq = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(70)], space: lawn._id } });
    await api("POST", `/venues/${SLUG}/holds/${cReq.json.hold._id}/approve`, { token });
    const bkH = await api("POST", `/venues/${SLUG}/bookings`, { token, body: { coupleName: "Hold Convert Couple", couplePhone: "9666600001", totalValue: 500000, days: [{ date: `${hday(70)}T00:00:00.000Z`, eventType: "Wedding", guestCount: 300 }] } });
    const conv = await api("POST", `/venues/${SLUG}/holds/${cReq.json.hold._id}/convert`, { token, body: { bookingId: bkH.json.booking._id } });
    check("holds: convert -> 200, rows booked", conv.status === 200 && conv.json.hold.status === "converted" && conv.json.converted === 1, `status ${conv.status} converted=${conv.json.converted}`);
    const calBooked = await api("GET", `/venues/${SLUG}/calendar?from=${hday(70)}&to=${hday(70)}`, { token });
    check("holds: calendar shows booked after convert", calBooked.json.days[0].spaces.some((s) => s.state === "booked"), `states=${JSON.stringify(calBooked.json.days[0].spaces.map((s) => s.state))}`);

    // manual block / unblock (venue-wide) + conflict with block
    const blk = await api("POST", `/venues/${SLUG}/calendar/block`, { token, body: { dates: [hday(80)], notes: "maintenance" } });
    check("holds: manual block -> 201 rows for every bookable space", blk.status === 201 && blk.json.blocked === 2, `status ${blk.status} blocked=${blk.json.blocked}`);
    const blkHold = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(80)], space: lawn._id } });
    const blkApp = await api("POST", `/venues/${SLUG}/holds/${blkHold.json.hold._id}/approve`, { token });
    check("holds: approve over blocked date -> 409", blkApp.status === 409, `status ${blkApp.status}`);
    const unblk = await api("POST", `/venues/${SLUG}/calendar/unblock`, { token, body: { dates: [hday(80)] } });
    check("holds: unblock -> frees exactly the blocked rows", unblk.status === 200 && unblk.json.unblocked === 2, `unblocked=${unblk.json.unblocked}`);

    // legacy venue-wide blockedDates respected at approval
    await api("POST", `/venues/${SLUG}/availability`, { token, body: { blockedDates: [hday(90)] } });
    const legHold = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { dates: [hday(90)], space: lawn._id } });
    const legApp = await api("POST", `/venues/${SLUG}/holds/${legHold.json.hold._id}/approve`, { token });
    check("holds: legacy blockedDates conflict -> 409", legApp.status === 409, `status ${legApp.status}`);
    await api("POST", `/venues/${SLUG}/availability`, { token, body: { blockedDates: [] } });

    // demand heat: seed a lead with an eventDate in range, expect >=1 on that day
    await api("POST", `/venues/${SLUG}/enquiries/manual`, { token, body: { coupleName: "Demand Couple", couplePhone: "9666600002", eventDate: `${hday(85)}T00:00:00.000Z` } });
    const heat = await api("GET", `/venues/${SLUG}/calendar/demand?from=${hday(84)}&to=${hday(86)}`, { token });
    const heat85 = (heat.json.demand || []).find((d) => d.date === hday(85));
    check("holds: demand heat counts non-lost leads by eventDate", heat.status === 200 && heat85 && heat85.leads >= 1, `demand=${JSON.stringify(heat.json.demand)}`);

    // settings: hold expiry days venue-configurable
    const setOk = await api("PATCH", `/venues/${SLUG}/calendar/settings`, { token, body: { holdExpiryDays: 2 } });
    check("holds: settings holdExpiryDays -> 200", setOk.status === 200 && setOk.json.holdExpiryDays === 2, `status ${setOk.status}`);
    const setBad = await api("PATCH", `/venues/${SLUG}/calendar/settings`, { token, body: { holdExpiryDays: 0 } });
    check("holds: holdExpiryDays 0 -> 400", setBad.status === 400, `status ${setBad.status}`);
    const hExp = await api("POST", `/venues/${SLUG}/holds`, { token, body: { dates: [hday(95)] } });
    const expDelta = new Date(hExp.json.hold.expiresAt) - Date.now();
    check("holds: new hold expiry honors venue setting (~2d)", expDelta > 1.8 * 86400000 && expDelta < 2.2 * 86400000, `delta=${Math.round(expDelta / 3600000)}h`);
    await api("PATCH", `/venues/${SLUG}/calendar/settings`, { token, body: { holdExpiryDays: 5 } });

    // month view shape
    const mon = await api("GET", `/venues/${SLUG}/calendar?month=${calMonth}`, { token });
    check("holds: month view returns full month with demand+visits fields", mon.status === 200 && mon.json.days.length >= 28 && "demand" in mon.json.days[0] && "visits" in mon.json.days[0], `days=${mon.json.days && mon.json.days.length}`);
  }

  // ================= D8: document engine — templates, bills, GST modes, ack =================
  if (process.env.E2E_DOCS === "1") {
    // fixture booking
    const dbk = await api("POST", `/venues/${SLUG}/bookings`, { token, body: { coupleName: "Docs Couple", couplePhone: "9555500001", totalValue: 118000, days: [{ date: new Date(Date.now() + 45 * 86400000).toISOString(), eventType: "Wedding", guestCount: 150 }] } });
    const dbkId = dbk.json.booking._id;

    // template CRUD
    const tpl = await api("POST", `/venues/${SLUG}/doc-templates`, { token, body: { type: "bill", name: "Standard Wedding Bill", lineItems: [{ label: "Venue hire", category: "venue_hire", qty: 1, unitPrice: 100000 }], terms: ["50% advance to confirm", "Balance 7 days before event"], gstMode: "exclusive", gstPercent: 18 } });
    check("docs: create template -> 201", tpl.status === 201 && tpl.json.template.name === "Standard Wedding Bill", `status ${tpl.status}`);
    const tplId = tpl.json.template._id;
    const tplDup = await api("POST", `/venues/${SLUG}/doc-templates`, { token, body: { type: "bill", name: "Standard Wedding Bill" } });
    check("docs: duplicate template name -> 400", tplDup.status === 400, `status ${tplDup.status}`);
    const tplBadType = await api("POST", `/venues/${SLUG}/doc-templates`, { token, body: { type: "receipt", name: "X" } });
    check("docs: unknown template type -> 400", tplBadType.status === 400, `status ${tplBadType.status}`);

    // GST modes — asserted to the rupee. 100000 @18%:
    //   exclusive: gst 18000, grand 118000 | inclusive: gst 15254, taxable 84746, grand 100000 | none: 0 / 100000
    const bEx = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, templateId: tplId } });
    check("docs: bill from template seeds items+terms", bEx.status === 201 && bEx.json.bill.lineItems.length === 1 && bEx.json.bill.terms.length === 2 && bEx.json.bill.billNumber.startsWith("BILL-"), `status ${bEx.status}`);
    check("docs: GST exclusive exact", bEx.json.bill.totals.subtotal === 100000 && bEx.json.bill.totals.gst === 18000 && bEx.json.bill.totals.grandTotal === 118000 && bEx.json.bill.totals.taxable === 100000, JSON.stringify(bEx.json.bill.totals));
    const bIn = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, lineItems: [{ label: "All-in package", qty: 1, unitPrice: 100000 }], gstMode: "inclusive", gstPercent: 18 } });
    check("docs: GST inclusive exact (back-computed)", bIn.json.bill.totals.gst === 15254 && bIn.json.bill.totals.taxable === 84746 && bIn.json.bill.totals.grandTotal === 100000, JSON.stringify(bIn.json.bill.totals));
    const bNo = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, lineItems: [{ label: "No-GST line", qty: 1, unitPrice: 100000 }], gstMode: "none" } });
    check("docs: GST none exact", bNo.json.bill.totals.gst === 0 && bNo.json.bill.totals.grandTotal === 100000, JSON.stringify(bNo.json.bill.totals));
    const bBadMode = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, gstMode: "magic" } });
    check("docs: unknown gstMode -> 400", bBadMode.status === 400, `status ${bBadMode.status}`);

    // send -> public white-label payload -> phone-verified acceptance
    const sent = await api("POST", `/venues/${SLUG}/bills/${bEx.json.bill._id}/send`, { token });
    check("docs: send bill -> ackToken", sent.status === 200 && sent.json.ackToken, `status ${sent.status}`);
    const ackTok = sent.json.ackToken;
    const pub = await api("GET", `/venues/doc-ack/${ackTok}`, {});
    check("docs: public ack payload is white-label (venue identity + terms, no venue internals)", pub.status === 200 && pub.json.venue && pub.json.venue.name && pub.json.terms.length === 2 && pub.json.docType === "bill", `status ${pub.status}`);
    const wrongPhone = await api("POST", `/venues/doc-ack/${ackTok}`, { body: { name: "Impostor", phone: "9000000000" } });
    check("docs: wrong phone -> 403", wrongPhone.status === 403, `status ${wrongPhone.status}`);
    const acc = await api("POST", `/venues/doc-ack/${ackTok}`, { body: { name: "Docs Couple", phone: "9555500001", channel: "whatsapp" } });
    check("docs: accept -> 200 acceptance logged", acc.status === 200 && acc.json.acceptedAt, `status ${acc.status}`);
    const accAgain = await api("POST", `/venues/doc-ack/${ackTok}`, { body: { name: "Again", phone: "9555500001" } });
    check("docs: double-accept -> 409", accAgain.status === 409, `status ${accAgain.status}`);
    const badTok = await api("GET", `/venues/doc-ack/not-a-token`, {});
    check("docs: garbage ack token -> 401", badTok.status === 401, `status ${badTok.status}`);

    // conversion: numbering continues the EXISTING invoice sequence
    const inv0 = await api("POST", `/venues/${SLUG}/invoices`, { token, body: { booking: dbkId, kind: "advance" } });
    const seq0 = inv0.json.invoice.seq;
    const conv = await api("POST", `/venues/${SLUG}/bills/${bEx.json.bill._id}/convert`, { token });
    check("docs: accepted bill converts -> real invoice, sequence intact", conv.status === 201 && conv.json.invoice.seq === seq0 + 1 && conv.json.bill.status === "converted" && conv.json.invoice.billRef === conv.json.bill._id, `seq ${seq0}->${conv.json.invoice && conv.json.invoice.seq}`);
    check("docs: converted invoice carries acceptance + gstMode + terms", conv.json.invoice.acceptance && conv.json.invoice.acceptance.name === "Docs Couple" && conv.json.invoice.gstMode === "exclusive" && conv.json.invoice.terms.length === 2, JSON.stringify(conv.json.invoice.acceptance));
    const editConverted = await api("PATCH", `/venues/${SLUG}/bills/${bEx.json.bill._id}`, { token, body: { discount: 1 } });
    check("docs: converted bill is immutable -> 409", editConverted.status === 409, `status ${editConverted.status}`);

    // add-on billing: supplementary bill -> addon invoice
    const addon = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, isAddon: true, lineItems: [{ label: "Extra 50 plates", qty: 50, unitPrice: 1500 }], gstMode: "exclusive", gstPercent: 18 } });
    check("docs: add-on bill math exact", addon.json.bill.isAddon === true && addon.json.bill.totals.subtotal === 75000 && addon.json.bill.totals.gst === 13500 && addon.json.bill.totals.grandTotal === 88500, JSON.stringify(addon.json.bill.totals));
    const addonConv = await api("POST", `/venues/${SLUG}/bills/${addon.json.bill._id}/convert`, { token });
    check("docs: add-on converts to kind=addon invoice", addonConv.status === 201 && addonConv.json.invoice.kind === "addon", `kind ${addonConv.json.invoice && addonConv.json.invoice.kind}`);

    // white-label PDF: logo -> /XObject present; Powered by Wedsy footer bytes
    const sharpD = require("sharp");
    const logoJ = await sharpD({ create: { width: 24, height: 24, channels: 3, background: { r: 107, g: 30, b: 46 } } }).jpeg().toBuffer();
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: `data:image/jpeg;base64,${logoJ.toString("base64")}` } });
    const bpdf = await apiBinary(`/venues/${SLUG}/bills/${bIn.json.bill._id}/pdf`, { token });
    check("docs: bill PDF renders with logo image object", bpdf.status === 200 && bpdf.head.startsWith("%PDF") && bpdf.body.includes("/XObject"), `bytes=${bpdf.bytes}`);
    await api("PUT", `/venues/${SLUG}`, { token, body: { logo: "" } });
    const bpdf2 = await apiBinary(`/venues/${SLUG}/bills/${bIn.json.bill._id}/pdf`, { token });
    check("docs: bill PDF graceful without logo", bpdf2.status === 200 && bpdf2.head.startsWith("%PDF") && !bpdf2.body.includes("/XObject"), `bytes=${bpdf2.bytes}`);

    // ── E3x white-label persistence: per-doc flag + venue default + renders ──
    {
      const SYS_BILL = "This is a working bill";
      const SYS_INV = "This is a system-generated tax invoice";
      const SYS_QUOTE = "This is a system-generated quotation";
      const FOOTER = "Powered by Wedsy";

      // Default-false bill (bIn, created before any default change): co-branded.
      check("e3x: legacy/default bill is co-branded (whiteLabel false)", bIn.json.bill.whiteLabel === false, `wl=${bIn.json.bill.whiteLabel}`);
      const coText = pdfText(bpdf2.body);
      check("e3x: co-branded bill PDF has system line + footer", coText.includes(SYS_BILL) && coText.includes(FOOTER), `sys=${coText.includes(SYS_BILL)} foot=${coText.includes(FOOTER)}`);

      // Setting is validated and documents-gated (capability sweep lives in hardening).
      const badSet = await api("PATCH", `/venues/${SLUG}/documents/settings`, { token, body: { documentsWhiteLabelDefault: "yes" } });
      check("e3x: non-boolean default -> 400", badSet.status === 400, `status ${badSet.status}`);
      const setOn = await api("PATCH", `/venues/${SLUG}/documents/settings`, { token, body: { documentsWhiteLabelDefault: true } });
      check("e3x: set documentsWhiteLabelDefault true -> 200", setOn.status === 200 && setOn.json.documentsWhiteLabelDefault === true, `status ${setOn.status}`);

      // New bill inherits the venue default; PDF drops the system line, keeps footer.
      const wlBill = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, lineItems: [{ label: "White-label package", qty: 1, unitPrice: 200000 }], gstMode: "exclusive", gstPercent: 18 } });
      check("e3x: new bill inherits whiteLabel default", wlBill.status === 201 && wlBill.json.bill.whiteLabel === true, `wl=${wlBill.json.bill && wlBill.json.bill.whiteLabel}`);
      const wlPdf = await apiBinary(`/venues/${SLUG}/bills/${wlBill.json.bill._id}/pdf`, { token });
      const wlText = pdfText(wlPdf.body);
      check("e3x: white-label bill PDF venue-only + small footer", wlPdf.status === 200 && !wlText.includes(SYS_BILL) && wlText.includes(FOOTER), `sys=${wlText.includes(SYS_BILL)} foot=${wlText.includes(FOOTER)}`);

      // Per-doc override beats the default, both directions; PATCH toggles live.
      const coBill = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, whiteLabel: false, lineItems: [{ label: "Co-branded line", qty: 1, unitPrice: 1000 }] } });
      check("e3x: explicit whiteLabel:false overrides true default", coBill.json.bill.whiteLabel === false, `wl=${coBill.json.bill.whiteLabel}`);
      const flip = await api("PATCH", `/venues/${SLUG}/bills/${coBill.json.bill._id}`, { token, body: { whiteLabel: true } });
      check("e3x: bill whiteLabel PATCHes", flip.status === 200 && flip.json.bill.whiteLabel === true, `wl=${flip.json.bill && flip.json.bill.whiteLabel}`);
      const badWl = await api("POST", `/venues/${SLUG}/bills`, { token, body: { booking: dbkId, whiteLabel: "yes" } });
      check("e3x: non-boolean per-doc whiteLabel -> 400", badWl.status === 400, `status ${badWl.status}`);

      // Conversion carries the flag; invoice PDF renders white-label.
      const wlConv = await api("POST", `/venues/${SLUG}/bills/${wlBill.json.bill._id}/convert`, { token });
      check("e3x: conversion carries whiteLabel to invoice", wlConv.status === 201 && wlConv.json.invoice.whiteLabel === true, `wl=${wlConv.json.invoice && wlConv.json.invoice.whiteLabel}`);
      const wlInvPdf = await apiBinary(`/venues/${SLUG}/invoices/${wlConv.json.invoice._id}/pdf`, { token });
      const wlInvText = pdfText(wlInvPdf.body);
      check("e3x: white-label invoice PDF venue-only + small footer", !wlInvText.includes(SYS_INV) && wlInvText.includes(FOOTER), `sys=${wlInvText.includes(SYS_INV)} foot=${wlInvText.includes(FOOTER)}`);

      // Quote lane: explicit flag persists and renders; co-branded stays intact.
      const wlEnq = await api("POST", `/venues/${SLUG}/enquiries/manual`, { token, body: { coupleName: "WL Quote Couple", couplePhone: "9555500003" } });
      const wlEnqId = wlEnq.json.enquiryId || (wlEnq.json.enquiry && wlEnq.json.enquiry._id);
      const wlQuote = await api("POST", `/venues/${SLUG}/quotes`, { token, body: { enquiry: wlEnqId, whiteLabel: true, lineItems: [{ label: "Hall", qty: 1, unitPrice: 90000 }] } });
      check("e3x: quote persists whiteLabel", wlQuote.status === 201 && wlQuote.json.quote.whiteLabel === true, `wl=${wlQuote.json.quote && wlQuote.json.quote.whiteLabel}`);
      const wlQPdf = await apiBinary(`/venues/${SLUG}/quotes/${wlQuote.json.quote._id}/pdf`, { token });
      const wlQText = pdfText(wlQPdf.body);
      check("e3x: white-label quote PDF venue-only + small footer", !wlQText.includes(SYS_QUOTE) && wlQText.includes(FOOTER), `sys=${wlQText.includes(SYS_QUOTE)} foot=${wlQText.includes(FOOTER)}`);
      const coQuote = await api("POST", `/venues/${SLUG}/quotes`, { token, body: { enquiry: wlEnqId, whiteLabel: false, lineItems: [{ label: "Hall", qty: 1, unitPrice: 90000 }] } });
      const coQPdf = await apiBinary(`/venues/${SLUG}/quotes/${coQuote.json.quote._id}/pdf`, { token });
      const coQText = pdfText(coQPdf.body);
      check("e3x: co-branded quote PDF keeps system line", coQText.includes(SYS_QUOTE) && coQText.includes(FOOTER), `sys=${coQText.includes(SYS_QUOTE)}`);

      // Leave the venue default as found (false) for the rest of the suite.
      const setOff = await api("PATCH", `/venues/${SLUG}/documents/settings`, { token, body: { documentsWhiteLabelDefault: false } });
      check("e3x: reset default -> 200", setOff.status === 200 && setOff.json.documentsWhiteLabelDefault === false, `status ${setOff.status}`);
    }

    // quote ack path (same engine)
    const qEnq = await api("POST", `/venues/${SLUG}/enquiries/manual`, { token, body: { coupleName: "Quote Ack Couple", couplePhone: "9555500002" } });
    const qEnqId = qEnq.json.enquiryId || (qEnq.json.enquiry && qEnq.json.enquiry._id);
    const q = await api("POST", `/venues/${SLUG}/quotes`, { token, body: { enquiry: qEnqId, lineItems: [{ label: "Hall", qty: 1, unitPrice: 50000 }], gstMode: "inclusive", gstPercent: 5, terms: ["Valid 14 days"] } });
    check("docs: quote with inclusive mode exact", q.json.quote.totals.gst === 2381 && q.json.quote.totals.grandTotal === 50000, JSON.stringify(q.json.quote.totals));
    const qSend = await api("POST", `/venues/${SLUG}/quotes/${q.json.quote._id}/send-ack`, { token });
    const qAcc = await api("POST", `/venues/doc-ack/${qSend.json.ackToken}`, { body: { name: "Quote Ack Couple", phone: "9555500002" } });
    check("docs: quote acceptance via public link", qAcc.status === 200 && qAcc.json.acceptedAt, `status ${qAcc.status}`);

    // template delete
    const tplDel = await api("DELETE", `/venues/${SLUG}/doc-templates/${tplId}`, { token });
    check("docs: delete template -> 200", tplDel.status === 200, `status ${tplDel.status}`);

    // "Quote accepted -> confirm booking" (review add): the publicly-accepted
    // quote surfaces on the dashboard until the owner confirms the booking.
    const dash1 = await api("GET", "/venues/dashboard/overview", { token });
    const cardItem = (dash1.json.actionNeeded && dash1.json.actionNeeded.quotesAwaitingBooking || []).find((i) => String(i.quoteId) === String(q.json.quote._id));
    check("docs: accepted quote surfaces on dashboard card", dash1.status === 200 && cardItem && cardItem.coupleName === "Quote Ack Couple" && cardItem.acceptedBy === "Quote Ack Couple", JSON.stringify(cardItem));
    const notAccepted = await api("POST", `/venues/${SLUG}/quotes/${bEx.json.bill._id}/confirm-booking`, { token });
    check("docs: confirm-booking on non-quote id -> 404", notAccepted.status === 404, `status ${notAccepted.status}`);
    const confirm = await api("POST", `/venues/${SLUG}/quotes/${q.json.quote._id}/confirm-booking`, { token });
    check("docs: confirm-booking creates the draft booking with quote total", confirm.status === 200 && confirm.json.booking && confirm.json.booking.totalValue === 50000, `status ${confirm.status} total=${confirm.json.booking && confirm.json.booking.totalValue}`);
    const confirmAgain = await api("POST", `/venues/${SLUG}/quotes/${q.json.quote._id}/confirm-booking`, { token });
    check("docs: confirm-booking idempotent (one booking per enquiry)", confirmAgain.status === 200 && String(confirmAgain.json.booking._id) === String(confirm.json.booking._id), `ids match=${String(confirmAgain.json.booking && confirmAgain.json.booking._id) === String(confirm.json.booking._id)}`);
    const dash2 = await api("GET", "/venues/dashboard/overview", { token });
    const stillThere = (dash2.json.actionNeeded.quotesAwaitingBooking || []).some((i) => String(i.quoteId) === String(q.json.quote._id));
    check("docs: card clears once the booking exists", !stillThere, `still=${stillThere}`);
  }

  // ================= D7: payments approval — pending, owner labels, rollups =================
  if (process.env.E2E_PAYAPPROVAL === "1") {
    // fixture: booking + invoice of 100000 (no GST for round numbers)
    const pbk = await api("POST", `/venues/${SLUG}/bookings`, { token, body: { coupleName: "PayApproval Couple", couplePhone: "9444400001", totalValue: 100000, days: [{ date: new Date(Date.now() + 55 * 86400000).toISOString(), eventType: "Wedding", guestCount: 100 } ] } });
    const pinv = await api("POST", `/venues/${SLUG}/invoices`, { token, body: { booking: pbk.json.booking._id, lineItems: [{ label: "Venue hire", qty: 1, unitPrice: 100000 }], gstMode: "none" } });
    const invId = pinv.json.invoice._id;

    // an Accounts-bundle member (bookings_money + documents)
    const prl = await api("GET", `/venues/${SLUG}/roles`, { token });
    const accountsRole = (prl.json.roles || []).find((r) => r.name === "Accounts");
    const pinvite = await api("POST", `/venues/${SLUG}/team`, { token, body: { name: "Paula Accounts", phone: "9333300002", email: "paula@test-palace.local", roleId: accountsRole._id, withPassword: true } });
    const plogin = await api("POST", "/venue-owner/member-auth", { body: { email: "paula@test-palace.local", password: pinvite.json.tempPassword } });
    const paulaToken = plogin.json.token;
    check("payapproval: accounts member logs in", plogin.status === 200 && paulaToken, `status ${plogin.status}`);

    // member records -> pending_approval, full who/when/how/proof answers
    const mp = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token: paulaToken, body: { amount: 40000, mode: "cash", collectedBy: "Paula (front desk)", proofUrl: "https://files.local/receipt-1.jpg", note: "advance cash" } });
    check("payapproval: member entry -> pending_approval", mp.status === 200 && mp.json.payment.status === "pending_approval" && mp.json.payment.recordedByType === "member" && mp.json.payment.recordedByName === "Paula Accounts" && mp.json.payment.collectedBy === "Paula (front desk)" && mp.json.payment.proofUrl.includes("receipt-1"), JSON.stringify(mp.json.payment && { s: mp.json.payment.status, n: mp.json.payment.recordedByName }));
    check("payapproval: pending excluded from received", mp.json.received === 0 && mp.json.invoice.status === "unpaid", `received=${mp.json.received} status=${mp.json.invoice.status}`);
    const sum1 = await api("GET", `/venues/${SLUG}/payments/summary`, { token });
    check("payapproval: summary shows approval queue, not revenue", sum1.json.totals.pendingApproval === 40000 && sum1.json.pendingEntries.some((e) => String(e.invoiceId) === String(invId)), `pendingApproval=${sum1.json.totals.pendingApproval}`);

    // owner approves -> rollups flip
    const payId = mp.json.payment._id;
    const app = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments/${payId}/approve`, { token });
    check("payapproval: owner approve -> received flips", app.status === 200 && app.json.received === 40000 && app.json.invoice.status === "partially_paid", `received=${app.json.received}`);
    const appAgain = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments/${payId}/approve`, { token });
    check("payapproval: double-approve -> 409", appAgain.status === 409, `status ${appAgain.status}`);

    // member cannot approve their own entry
    const mp2 = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token: paulaToken, body: { amount: 10000, mode: "upi" } });
    const pay2 = mp2.json.payment._id;
    const selfApprove = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments/${pay2}/approve`, { token: paulaToken });
    check("payapproval: member approve -> 403 (owner only)", selfApprove.status === 403, `status ${selfApprove.status}`);

    // reject path: audit kept, never counted
    const rej = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments/${pay2}/reject`, { token, body: { reason: "no proof attached" } });
    check("payapproval: owner reject -> kept for audit, not counted", rej.status === 200 && rej.json.payment.status === "rejected" && rej.json.payment.rejectedReason === "no proof attached", `status ${rej.status}`);
    const sum2 = await api("GET", `/venues/${SLUG}/payments/summary`, { token });
    check("payapproval: rejected excluded everywhere", sum2.json.totals.pendingApproval === 0 && sum2.json.perBooking.find((b) => String(b.bookingId) === String(pbk.json.booking._id)).received === 40000, `pendingApproval=${sum2.json.totals.pendingApproval}`);

    // owner entry: auto-approved + permanent label
    const op = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token, body: { amount: 25000, mode: "bank_transfer" } });
    check("payapproval: owner entry auto-approved + labeled", op.status === 200 && op.json.payment.status === "approved" && op.json.payment.ownerEntry === true && op.json.received === 65000, `received=${op.json.received}`);

    // over-recording guard: pending+approved claim balance (35000 left)
    const over = await api("POST", `/venues/${SLUG}/invoices/${invId}/payments`, { token, body: { amount: 35001 } });
    check("payapproval: overpayment still rejected", over.status === 400, `status ${over.status}`);
  }

  // ================= D6: rooms per-wedding workflow — check-in/out + settlement =================
  if (process.env.E2E_CHECKIN === "1") {
    const cday = (n) => new Date(Date.now() + n * 86400000).toISOString();
    // room + booking + allotment fixtures
    const rRoom = await api("POST", `/venues/${SLUG}/rooms`, { token, body: { name: "Checkin Suite", type: "suite", capacity: 3 } });
    const roomC = rRoom.json.room._id;
    const cbk = await api("POST", `/venues/${SLUG}/bookings`, { token, body: { coupleName: "Checkin Couple", couplePhone: "9222200001", totalValue: 200000, days: [{ date: cday(20), eventType: "Wedding", guestCount: 120 }] } });
    const cbkId = cbk.json.booking._id;
    const alr = await api("POST", `/venues/${SLUG}/bookings/${cbkId}/allotments`, { token, body: { room: roomC, guestName: "Uncle Ajay", guestPhone: "9222200002", checkInAt: cday(20), checkOutAt: cday(22) } });
    const alId = alr.json.allotments[0]._id;

    // full-capture check-in in ONE round trip
    const cin = await api("POST", `/venues/${SLUG}/allotments/${alId}/check-in`, {
      token,
      body: {
        guestCount: 3, extraBeds: 1, deposit: 10000,
        inventory: [{ item: "Towels", qty: 4 }, { item: "Iron", qty: 1 }],
        idCaptureUrl: "https://files.local/id-ajay.jpg", photoUrl: "https://files.local/guest-ajay.jpg", signatureUrl: "https://files.local/sign-ajay.png",
        notes: "late arrival expected",
      },
    });
    check("checkin: single-call capture -> checked_in with full block",
      cin.status === 200 && cin.json.allotment.status === "checked_in" && cin.json.allotment.checkIn.guestCount === 3 && cin.json.allotment.checkIn.extraBeds === 1 && cin.json.allotment.checkIn.inventory.length === 2 && cin.json.allotment.checkIn.signatureUrl.includes("sign-ajay") && cin.json.allotment.deposit.amount === 10000,
      `status ${cin.status}`);
    const cinAgain = await api("POST", `/venues/${SLUG}/allotments/${alId}/check-in`, { token, body: {} });
    check("checkin: double check-in -> 409", cinAgain.status === 409, `status ${cinAgain.status}`);

    // check-out with checklist + damages: 10000 deposit, 6000 damages
    const cout = await api("POST", `/venues/${SLUG}/allotments/${alId}/check-out`, {
      token,
      body: {
        checklist: [{ item: "Towels", ok: true }, { item: "Iron", ok: false }],
        damages: [{ desc: "Broken iron", charge: 1500 }, { desc: "Stained carpet", charge: 4500 }],
        notes: "guest informed",
      },
    });
    check("checkin: checkout computes settlement exactly",
      cout.status === 200 && cout.json.settlement.deposit === 10000 && cout.json.settlement.damagesTotal === 6000 && cout.json.settlement.deducted === 6000 && cout.json.settlement.refundDue === 4000 && cout.json.settlement.payableDue === 0,
      JSON.stringify(cout.json.settlement));
    check("checkin: damages produce an addon invoice ref", Boolean(cout.json.settlement.invoiceRef), `ref=${cout.json.settlement.invoiceRef}`);

    // the settlement payment landed as an approved owner entry on the addon invoice
    const sInv = await api("GET", `/venues/${SLUG}/invoices/${cout.json.settlement.invoiceRef}`, { token });
    const sPay = sInv.json.invoice.payments[0];
    check("checkin: settlement recorded through payments engine (owner entry, approved)",
      sInv.json.invoice.kind === "addon" && sInv.json.invoice.totals.grandTotal === 6000 && sPay && sPay.status === "approved" && sPay.ownerEntry === true && sPay.amount === 6000 && sPay.collectedBy === "Deposit settlement",
      JSON.stringify(sPay && { s: sPay.status, a: sPay.amount }));

    // printable slip
    const slip = await apiBinary(`/venues/${SLUG}/allotments/${alId}/settlement-slip`, { token });
    check("checkin: settlement slip PDF renders", slip.status === 200 && slip.head.startsWith("%PDF") && slip.bytes > 800, `bytes=${slip.bytes}`);

    // archive -> booking roomsHistory; rooms live on
    const arch = await api("POST", `/venues/${SLUG}/allotments/${alId}/archive`, { token });
    check("checkin: archive -> 200", arch.status === 200 && arch.json.allotment.archived === true, `status ${arch.status}`);
    const archAgain = await api("POST", `/venues/${SLUG}/allotments/${alId}/archive`, { token });
    check("checkin: double archive -> 409", archAgain.status === 409, `status ${archAgain.status}`);
    const bkAfter = await api("GET", `/venues/${SLUG}/bookings/${cbkId}`, { token });
    const hist = (bkAfter.json.booking.roomsHistory || [])[0];
    check("checkin: booking carries the archived block",
      hist && hist.roomName === "Checkin Suite" && hist.guestName === "Uncle Ajay" && hist.damagesTotal === 6000 && hist.refundDue === 4000,
      JSON.stringify(hist && { r: hist.roomName, d: hist.damagesTotal }));

    // damages beyond deposit -> payableDue; validation teeth
    const alr2 = await api("POST", `/venues/${SLUG}/bookings/${cbkId}/allotments`, { token, body: { room: roomC, guestName: "Aunt Rekha", checkInAt: cday(25), checkOutAt: cday(26) } });
    const alId2 = alr2.json.allotments[0]._id;
    await api("POST", `/venues/${SLUG}/allotments/${alId2}/check-in`, { token, body: { deposit: 2000 } });
    const cout2 = await api("POST", `/venues/${SLUG}/allotments/${alId2}/check-out`, { token, body: { damages: [{ desc: "Cracked mirror", charge: 5000 }] } });
    check("checkin: damages beyond deposit -> payableDue",
      cout2.json.settlement.deducted === 2000 && cout2.json.settlement.refundDue === 0 && cout2.json.settlement.payableDue === 3000,
      JSON.stringify(cout2.json.settlement));
    const alr3 = await api("POST", `/venues/${SLUG}/bookings/${cbkId}/allotments`, { token, body: { room: roomC, guestName: "Neg", checkInAt: cday(28), checkOutAt: cday(29) } });
    const badDamage = await api("POST", `/venues/${SLUG}/allotments/${alr3.json.allotments[0]._id}/check-out`, { token, body: { damages: [{ desc: "x", charge: -5 }] } });
    check("checkin: checkout before check-in -> 409", badDamage.status === 409, `status ${badDamage.status}`);
    await api("POST", `/venues/${SLUG}/allotments/${alr3.json.allotments[0]._id}/check-in`, { token, body: {} });
    const badDamage2 = await api("POST", `/venues/${SLUG}/allotments/${alr3.json.allotments[0]._id}/check-out`, { token, body: { damages: [{ desc: "x", charge: -5 }] } });
    check("checkin: negative damage charge -> 400", badDamage2.status === 400, `status ${badDamage2.status}`);
  }

  // ================= D10: activity spine — hooks, dual-actor, filters =================
  if (process.env.E2E_ACTIVITY === "1") {
    // owner edits: pricing (high), photos (low), rename (high, then rename back)
    await api("PUT", `/venues/${SLUG}`, { token, body: { pricing: { perPlate: { veg: 1725 } } } });
    await api("PUT", `/venues/${SLUG}`, { token, body: { photos: { venue: ["https://files.local/g1.jpg"] } } });
    await api("PUT", `/venues/${SLUG}`, { token, body: { name: "Test Palace Regal" } });
    await api("PUT", `/venues/${SLUG}`, { token, body: { name: "Test Palace" } });

    const feed = await api("GET", `/venues/${SLUG}/activity?limit=50`, { token });
    check("activity: owner GET returns the trail", feed.status === 200 && feed.json.activity.length >= 4, `n=${feed.json.total}`);
    const pricingRow = feed.json.activity.find((a) => a.field === "pricing.perPlate.veg");
    check("activity: pricing change logged HIGH with old/new", pricingRow && pricingRow.severity === "high" && pricingRow.new === "1725" && pricingRow.actorType === "venue_team" && pricingRow.actorName === "Owner", JSON.stringify(pricingRow && { s: pricingRow.severity, n: pricingRow.new }));
    const photoRow = feed.json.activity.find((a) => a.field === "photos.venue");
    check("activity: photos change logged LOW", photoRow && photoRow.severity === "low", `sev=${photoRow && photoRow.severity}`);
    const renameRow = feed.json.activity.find((a) => a.action === "venue_renamed");
    check("activity: rename logged as venue_renamed HIGH", renameRow && renameRow.severity === "high", `sev=${renameRow && renameRow.severity}`);

    // dual-actor: a member edit carries the member's name
    const arl = await api("GET", `/venues/${SLUG}/roles`, { token });
    const mgrRole = (arl.json.roles || []).find((r) => r.name === "Manager");
    const ainv = await api("POST", `/venues/${SLUG}/team`, { token, body: { name: "Meera Manager", phone: "9333300003", email: "meera@test-palace.local", roleId: mgrRole._id, withPassword: true } });
    const alog = await api("POST", "/venue-owner/member-auth", { body: { email: "meera@test-palace.local", password: ainv.json.tempPassword } });
    await api("PUT", `/venues/${SLUG}`, { token: alog.json.token, body: { tagline: "edited by meera" } });
    const feed2 = await api("GET", `/venues/${SLUG}/activity?limit=10`, { token });
    const meeraRow = feed2.json.activity.find((a) => a.field === "tagline");
    check("activity: member edit carries member identity", meeraRow && meeraRow.actorType === "venue_team" && meeraRow.actorName === "Meera Manager", JSON.stringify(meeraRow && { t: meeraRow.actorType, n: meeraRow.actorName }));

    // filters
    const highOnly = await api("GET", `/venues/${SLUG}/activity?severity=high`, { token });
    check("activity: severity filter", highOnly.status === 200 && highOnly.json.activity.length >= 2 && highOnly.json.activity.every((a) => a.severity === "high"), `n=${highOnly.json.total}`);
    const badSev = await api("GET", `/venues/${SLUG}/activity?severity=catastrophic`, { token });
    check("activity: unknown severity -> 400", badSev.status === 400, `status ${badSev.status}`);

    // no-op writes don't pollute the trail
    const before = (await api("GET", `/venues/${SLUG}/activity?limit=500`, { token })).json.total;
    await api("PUT", `/venues/${SLUG}`, { token, body: { name: "Test Palace" } }); // unchanged value
    const after = (await api("GET", `/venues/${SLUG}/activity?limit=500`, { token })).json.total;
    check("activity: no-op write adds nothing", after === before, `before=${before} after=${after}`);

    // append-only at the API surface: no write routes exist
    const tryPost = await api("POST", `/venues/${SLUG}/activity`, { token, body: {} });
    check("activity: no write route (POST -> 404)", tryPost.status === 404, `status ${tryPost.status}`);
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
  // ================= MB-V2 P0 S2: admin queues (claims, onboarding, partner board) =================
  // Runs BEFORE the public-ratelimit section — it seeds fixtures through the
  // public onboarding/claim intakes, which that section rate-exhausts.
  if (process.env.E2E_ADMIN_QUEUES === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // Fixture A: a fresh unclaimed venue + a manual claim on it (clean approve).
    const freshVenue = await api("POST", "/venues", { token: adminToken, body: { name: "Queue Test Manor", venueType: "resort", city: "Bangalore" } });
    const freshSlug = freshVenue.json && freshVenue.json.venue && freshVenue.json.venue.slug;
    check("queues: fixture venue created", freshVenue.status === 201 && Boolean(freshSlug), `status ${freshVenue.status}`);
    const claimA = await api("POST", "/venue-owner/claim/manual", { body: { slug: freshSlug, name: "Fresh Owner", designation: "owner", phone: "9811111111", email: "fresh@qtm.local" } });
    check("queues: manual claim submitted on fixture venue", claimA.status === 201, `status ${claimA.status}`);
    // Fixture B: a new_venue_signup claim (no slug).
    const claimB = await api("POST", "/venue-owner/claim/manual", { body: { name: "Signup Owner", designation: "manager", phone: "9822222222", email: "signup@qtm.local", newVenueName: "Signup Palace", newVenueType: "weird-type", newVenueAddress: "12 Test Road" } });
    check("queues: new-venue signup claim submitted", claimB.status === 201, `status ${claimB.status}`);
    // Fixture C: a manual claim against test-palace (conflicting active owner).
    const claimC = await api("POST", "/venue-owner/claim/manual", { body: { slug: SLUG, name: "Impostor", designation: "owner", phone: "9833333333", email: "impostor@qtm.local" } });
    check("queues: conflicting claim submitted on seeded venue", claimC.status === 201, `status ${claimC.status}`);

    // Queue list + detail.
    const claims = await api("GET", "/admin/venues/claims?status=pending_manual_review&limit=100", { token: adminToken });
    check("queues: claims list -> 200 with pending requests", claims.status === 200 && claims.json.total >= 3, `status ${claims.status}, total ${claims.json && claims.json.total}`);
    const rows = (claims.json && claims.json.requests) || [];
    const reqA = rows.find((r) => r.venueSlug === freshSlug);
    const reqB = rows.find((r) => r.tier === "new_venue_signup" && r.phone === "9822222222");
    const reqC = rows.find((r) => r.venueSlug === SLUG && r.phone === "9833333333");
    check("queues: all three fixtures visible in queue", Boolean(reqA && reqB && reqC));
    const claimsBadTier = await api("GET", "/admin/venues/claims?tier=bogus", { token: adminToken });
    check("queues: unknown tier filter -> 400", claimsBadTier.status === 400, `status ${claimsBadTier.status}`);
    const detailC = await api("GET", `/admin/venues/claims/${reqC && reqC._id}`, { token: adminToken });
    check("queues: claim detail surfaces current-owner conflict", detailC.status === 200 && detailC.json.currentOwner && detailC.json.currentOwner.phone === OWNER_PHONE, `status ${detailC.status}`);

    // Approve A: creates a verified owner on the fixture venue.
    const approveA = await api("POST", `/admin/venues/claims/${reqA && reqA._id}/approve`, { token: adminToken, body: { reviewNote: "checks out" } });
    check("queues: approve existing-venue claim -> 200 verified owner", approveA.status === 200 && approveA.json.owner && approveA.json.owner.verificationStatus === "verified" && approveA.json.owner.phone === "9811111111", `status ${approveA.status}`);
    const approveAgain = await api("POST", `/admin/venues/claims/${reqA && reqA._id}/approve`, { token: adminToken });
    check("queues: double approve -> 409", approveAgain.status === 409, `status ${approveAgain.status}`);
    const sumAfterA = await api("GET", `/admin/venues/${freshSlug}/summary`, { token: adminToken });
    check("queues: fixture venue now claimState=claimed", sumAfterA.status === 200 && sumAfterA.json.claimState === "claimed", sumAfterA.json && sumAfterA.json.claimState);
    const actAfterA = await api("GET", `/admin/venues/${freshSlug}/activity?actorType=wedsy_team&limit=20`, { token: adminToken });
    check("queues: approval logged to activity spine (high)", actAfterA.status === 200 && (actAfterA.json.activity || []).some((a) => a.action === "claim_approved" && a.severity === "high"), `rows ${actAfterA.json && actAfterA.json.total}`);

    // Approve B: creates the venue (draft, type mapped to enum) + owner.
    const approveB = await api("POST", `/admin/venues/claims/${reqB && reqB._id}/approve`, { token: adminToken });
    check("queues: approve new-venue signup -> 200 with created venue", approveB.status === 200 && approveB.json.venue && approveB.json.venue.slug, `status ${approveB.status}`);
    const createdSlug = approveB.json && approveB.json.venue && approveB.json.venue.slug;
    const createdSum = await api("GET", `/admin/venues/${createdSlug}/summary`, { token: adminToken });
    check("queues: signup venue is draft + claimed + type coerced to enum", createdSum.status === 200 && createdSum.json.venue.status === "draft" && createdSum.json.venue.venueType === "other" && createdSum.json.claimState === "claimed", createdSum.json && createdSum.json.venue && createdSum.json.venue.venueType);

    // Approve C must 409 (active owner with different phone), then reject it.
    const approveC = await api("POST", `/admin/venues/claims/${reqC && reqC._id}/approve`, { token: adminToken });
    check("queues: conflicting approve -> 409 (owner phone mismatch)", approveC.status === 409, `status ${approveC.status}`);
    const rejectC = await api("POST", `/admin/venues/claims/${reqC && reqC._id}/reject`, { token: adminToken, body: { reviewNote: "not the owner" } });
    check("queues: reject -> 200 with reviewer stamp", rejectC.status === 200 && rejectC.json.request.status === "rejected" && Boolean(rejectC.json.request.reviewedAt), `status ${rejectC.status}`);
    const rejectAgain = await api("POST", `/admin/venues/claims/${reqC && reqC._id}/reject`, { token: adminToken });
    check("queues: double reject -> 409", rejectAgain.status === 409, `status ${rejectAgain.status}`);

    // Onboarding queue: public intake -> guarded transitions.
    const onb1 = await api("POST", "/venues/onboarding-requests", { body: { name: "Ravi", venueName: "Lakeside Grounds", city: "Mysore", phone: "9844444444" } });
    const onb2 = await api("POST", "/venues/onboarding-requests", { body: { name: "Meera", venueName: "Hilltop Farms", city: "Coorg", phone: "9855555555" } });
    check("queues: onboarding intakes accepted", [200, 201].includes(onb1.status) && [200, 201].includes(onb2.status), `statuses ${onb1.status},${onb2.status}`);
    const onbList = await api("GET", "/admin/venues/onboarding-requests?status=new&limit=100", { token: adminToken });
    check("queues: onboarding list -> 200 with new requests", onbList.status === 200 && onbList.json.total >= 2, `status ${onbList.status}, total ${onbList.json && onbList.json.total}`);
    const onbRows = (onbList.json && onbList.json.requests) || [];
    const r1 = onbRows.find((r) => r.phone === "9844444444");
    const r2 = onbRows.find((r) => r.phone === "9855555555");
    const move1 = await api("PATCH", `/admin/venues/onboarding-requests/${r1 && r1._id}`, { token: adminToken, body: { status: "contacted" } });
    check("queues: onboarding new -> contacted", move1.status === 200 && move1.json.request.status === "contacted", `status ${move1.status}`);
    const moveBack = await api("PATCH", `/admin/venues/onboarding-requests/${r1 && r1._id}`, { token: adminToken, body: { status: "new" } });
    check("queues: backwards transition -> 400 (not an allowed target)", moveBack.status === 400 || moveBack.status === 409, `status ${moveBack.status}`);
    const move2 = await api("PATCH", `/admin/venues/onboarding-requests/${r2 && r2._id}`, { token: adminToken, body: { status: "converted" } });
    check("queues: onboarding new -> converted", move2.status === 200, `status ${move2.status}`);
    const moveTerminal = await api("PATCH", `/admin/venues/onboarding-requests/${r2 && r2._id}`, { token: adminToken, body: { status: "dropped" } });
    check("queues: converted is terminal -> 409", moveTerminal.status === 409, `status ${moveTerminal.status}`);
    const moveBogus = await api("PATCH", `/admin/venues/onboarding-requests/${r1 && r1._id}`, { token: adminToken, body: { status: "abducted" } });
    check("queues: unknown onboarding status -> 400", moveBogus.status === 400, `status ${moveBogus.status}`);

    // Partner board: derived columns fed by both queues.
    const board = await api("GET", "/admin/venues/partner-board", { token: adminToken });
    const cols = (board.json && board.json.columns) || {};
    check("queues: partner board -> 200 with 4 columns", board.status === 200 && ["prospect", "contacted", "onboarded", "live"].every((k) => Array.isArray(cols[k])), `status ${board.status}`);
    check("queues: contacted onboarding request on board", (cols.contacted || []).some((c) => c.kind === "onboarding_request" && c.phone === "9844444444"));
    check("queues: seeded venue (claimed+published) in live column", (cols.live || []).some((c) => c.kind === "venue" && c.slug === SLUG));
    check("queues: signup-created venue (claimed+draft) in onboarded column", (cols.onboarded || []).some((c) => c.kind === "venue" && c.slug === createdSlug));
    check("queues: approved fixture venue in onboarded column", (cols.onboarded || []).some((c) => c.kind === "venue" && c.slug === freshSlug));
  }

  // ================= MB-V2 P0 S3: admin day-board + cross-venue hold tracker =================
  if (process.env.E2E_ADMIN_BOARD === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });
    // Far-future date so no other section's holds/bookings collide.
    const boardDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);

    const vDetail = await api("GET", `/venues/${SLUG}`);
    const spaces = ((vDetail.json && vDetail.json.venue && vDetail.json.venue.spaces) || []).filter((s) => s.isBookable !== false);
    const spaceId = spaces[0] && spaces[0]._id;
    check("board: seeded venue has a bookable space", Boolean(spaceId));

    // Wedsy-side hold REQUEST through the EXISTING route (admin token).
    const holdReq = await api("POST", `/venues/${SLUG}/holds`, { token: adminToken, body: { space: spaceId, dates: [boardDate], notes: "day-board probe" } });
    check("board: wedsy hold request via existing route -> 201 requestedBy=wedsy", holdReq.status === 201 && holdReq.json.hold && holdReq.json.hold.requestedBy === "wedsy", `status ${holdReq.status}`);
    const holdId = holdReq.json.hold && holdReq.json.hold._id;

    const b1 = await api("GET", `/admin/venues/day-board?date=${boardDate}`, { token: adminToken });
    const row1 = b1.status === 200 && (b1.json.venues || []).find((v) => v.slug === SLUG);
    check("board: day-board -> 200 with seeded venue row", Boolean(row1), `status ${b1.status}`);
    check("board: pending hold counted, no space claimed yet", row1 && row1.pendingHolds >= 1 && row1.held === 0 && row1.open === row1.spacesTotal, row1 && JSON.stringify({ pendingHolds: row1.pendingHolds, held: row1.held, open: row1.open }));
    check("board: demand heat present as number", row1 && typeof row1.demand === "number");
    check("board: totals aggregate pending holds", b1.json.totals && b1.json.totals.pendingHolds >= 1, b1.json.totals && JSON.stringify(b1.json.totals));

    // D3: the OWNER approves; admin has no approve route.
    const appr = await api("POST", `/venues/${SLUG}/holds/${holdId}/approve`, { token });
    check("board: owner approves the wedsy request -> 200", appr.status === 200, `status ${appr.status}`);
    const b2 = await api("GET", `/admin/venues/day-board?date=${boardDate}`, { token: adminToken });
    const row2 = b2.status === 200 && (b2.json.venues || []).find((v) => v.slug === SLUG);
    check("board: after approval the date shows held space", row2 && row2.held >= 1 && row2.open < row2.spacesTotal && row2.pendingHolds === 0, row2 && JSON.stringify({ held: row2.held, open: row2.open, pendingHolds: row2.pendingHolds }));

    const tracker = await api("GET", `/admin/venues/holds?status=approved&requestedBy=wedsy&slug=${SLUG}`, { token: adminToken });
    check("board: holds tracker filters + populated venue", tracker.status === 200 && (tracker.json.holds || []).some((h) => h._id === holdId && h.venue && h.venue.slug === SLUG), `status ${tracker.status}`);

    // Owner releases — the admin tracker sees the transition (visibility only).
    const rel = await api("POST", `/venues/${SLUG}/holds/${holdId}/release`, { token });
    check("board: owner release -> 200", rel.status === 200, `status ${rel.status}`);
    const tracker2 = await api("GET", `/admin/venues/holds?status=released&slug=${SLUG}`, { token: adminToken });
    check("board: released status visible cross-venue", tracker2.status === 200 && (tracker2.json.holds || []).some((h) => h._id === holdId), `status ${tracker2.status}`);
    const b3 = await api("GET", `/admin/venues/day-board?date=${boardDate}`, { token: adminToken });
    const row3 = b3.status === 200 && (b3.json.venues || []).find((v) => v.slug === SLUG);
    check("board: date opens back up after release", row3 && row3.held === 0 && row3.open === row3.spacesTotal, row3 && JSON.stringify({ held: row3.held, open: row3.open }));

    // Validation.
    const badDate = await api("GET", "/admin/venues/day-board?date=13-2030-99", { token: adminToken });
    check("board: malformed date -> 400", badDate.status === 400, `status ${badDate.status}`);
    const noDate = await api("GET", "/admin/venues/day-board", { token: adminToken });
    check("board: missing date -> 400", noDate.status === 400, `status ${noDate.status}`);
    const badStatus = await api("GET", "/admin/venues/holds?status=bogus", { token: adminToken });
    check("board: unknown hold status filter -> 400", badStatus.status === 400, `status ${badStatus.status}`);
    const badSlug = await api("GET", "/admin/venues/holds?slug=definitely-not-a-venue", { token: adminToken });
    check("board: unknown venue slug -> 404", badSlug.status === 404, `status ${badSlug.status}`);
  }

  // ================= MB-V2 P0 S4+S5: leads oversight + forward bridge + firehose =================
  if (process.env.E2E_ADMIN_LEADS === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // Cross-venue list with venue populated + creator labels.
    const all = await api("GET", "/admin/venues/leads?limit=100", { token: adminToken });
    check("leads-oversight: cross-venue list -> 200 rows+total", all.status === 200 && Array.isArray(all.json.leads) && all.json.total >= 10, `status ${all.status}, total ${all.json && all.json.total}`);
    check("leads-oversight: rows carry venue + source + createdBy", (all.json.leads || []).every((l) => l.venue && l.venue.slug && typeof l.source === "string" && ["venue_team", "couple", "unknown"].includes(l.createdBy)));
    const bySlug = await api("GET", `/admin/venues/leads?slug=${SLUG}&limit=100`, { token: adminToken });
    check("leads-oversight: venue filter scopes rows", bySlug.status === 200 && (bySlug.json.leads || []).every((l) => l.venue.slug === SLUG) && bySlug.json.total >= 10, `status ${bySlug.status}`);
    const byStage = await api("GET", "/admin/venues/leads?stage=booked&limit=100", { token: adminToken });
    check("leads-oversight: stage filter honored", byStage.status === 200 && (byStage.json.leads || []).every((l) => l.stage === "booked"), `status ${byStage.status}`);
    const badStage = await api("GET", "/admin/venues/leads?stage=bogus", { token: adminToken });
    check("leads-oversight: unknown stage -> 400", badStage.status === 400, `status ${badStage.status}`);
    const badSlug = await api("GET", "/admin/venues/leads?slug=definitely-not-a-venue", { token: adminToken });
    check("leads-oversight: unknown venue -> 404", badSlug.status === 404, `status ${badSlug.status}`);

    // The D1 bridge: forward one lead, idempotently.
    const target = (bySlug.json.leads || []).find((l) => !l.forward);
    check("leads-oversight: an unforwarded lead exists to bridge", Boolean(target));
    const fwd = await api("POST", `/admin/venues/leads/${target && target._id}/forward`, { token: adminToken, body: { notes: "hot lead — wants a Dec date" } });
    check("forward: first forward -> 201 pending_os with snapshots", fwd.status === 201 && fwd.json.forward && fwd.json.forward.status === "pending_os" && fwd.json.duplicate === false && typeof fwd.json.forward.couplePhone === "string", `status ${fwd.status}`);
    const fwdAgain = await api("POST", `/admin/venues/leads/${target && target._id}/forward`, { token: adminToken, body: { notes: "resubmitted" } });
    check("forward: repeat forward idempotent -> 200 duplicate, same row", fwdAgain.status === 200 && fwdAgain.json.duplicate === true && String(fwdAgain.json.forward._id) === String(fwd.json.forward._id), `status ${fwdAgain.status}`);
    const fwd404 = await api("POST", "/admin/venues/leads/000000000000000000000000/forward", { token: adminToken });
    check("forward: unknown enquiry -> 404", fwd404.status === 404, `status ${fwd404.status}`);
    const fwdBadId = await api("POST", "/admin/venues/leads/not-an-id/forward", { token: adminToken });
    check("forward: malformed id -> 400", fwdBadId.status === 400, `status ${fwdBadId.status}`);
    const fwdBadNotes = await api("POST", `/admin/venues/leads/${target && target._id}/forward`, { token: adminToken, body: { notes: 42 } });
    check("forward: non-string notes -> 400 (validation precedes idempotency)", fwdBadNotes.status === 400, `status ${fwdBadNotes.status}`);

    // Forwarded marker shows up in the oversight list.
    const marked = await api("GET", `/admin/venues/leads?slug=${SLUG}&forwarded=true&limit=100`, { token: adminToken });
    check("leads-oversight: forwarded=true filter finds the bridged lead", marked.status === 200 && (marked.json.leads || []).some((l) => String(l._id) === String(target._id) && l.forward && l.forward.status === "pending_os"), `status ${marked.status}`);

    // The bridge queue endpoint (what the OS receive side consumes).
    const queue = await api("GET", "/admin/venues/forwards?status=pending_os", { token: adminToken });
    check("forward: pending_os queue lists the row with venue+enquiry populated", queue.status === 200 && (queue.json.forwards || []).some((f) => String(f.enquiryRef && f.enquiryRef._id || f.enquiryRef) === String(target._id) && f.venue && f.venue.slug === SLUG), `status ${queue.status}`);
    const queueBad = await api("GET", "/admin/venues/forwards?status=bogus", { token: adminToken });
    check("forward: unknown queue status -> 400", queueBad.status === 400, `status ${queueBad.status}`);

    // Activity spine recorded the bridge action.
    const act = await api("GET", `/admin/venues/${SLUG}/activity?actorType=wedsy_team&limit=50`, { token: adminToken });
    check("forward: bridge logged on the venue's trail", act.status === 200 && (act.json.activity || []).some((a) => a.action === "lead_forwarded_to_crm"), `status ${act.status}`);

    // ---- S5: cross-venue firehose ----
    const fire = await api("GET", "/admin/venues/activity-feed?limit=100", { token: adminToken });
    check("firehose: default feed -> 200, high-severity only, venue populated", fire.status === 200 && Array.isArray(fire.json.activity) && (fire.json.activity || []).every((a) => a.severity === "high" && a.venue && a.venue.slug), `status ${fire.status}, rows ${fire.json && fire.json.activity && fire.json.activity.length}`);
    check("firehose: has cross-venue high entries (claim approvals etc.)", (fire.json.activity || []).length >= 1);
    const fireAll = await api("GET", "/admin/venues/activity-feed?severity=all&actorType=wedsy_team&limit=100", { token: adminToken });
    check("firehose: severity=all + actorType filter", fireAll.status === 200 && (fireAll.json.activity || []).some((a) => a.severity !== "high") && (fireAll.json.activity || []).every((a) => a.actorType === "wedsy_team"), `status ${fireAll.status}`);
    const fireSlug = await api("GET", `/admin/venues/activity-feed?severity=all&slug=${SLUG}&limit=100`, { token: adminToken });
    check("firehose: slug filter scopes to one venue", fireSlug.status === 200 && (fireSlug.json.activity || []).every((a) => a.venue && a.venue.slug === SLUG), `status ${fireSlug.status}`);
    const fireBad = await api("GET", "/admin/venues/activity-feed?severity=catastrophic", { token: adminToken });
    check("firehose: unknown severity -> 400", fireBad.status === 400, `status ${fireBad.status}`);
  }

  // ================= MB-V2 P1: lead planner — shortlists, present mode, D2 linkage =================
  if (process.env.E2E_PLANNER === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const CRM_ID = "crm-lead-e2e-0001";
    const PLANNER_PHONE = "9877001122";

    // Shortlist create (idempotent per CRM lead) + validation.
    const noId = await api("POST", "/admin/venues/shortlists", { token: adminToken, body: { coupleName: "No Id" } });
    check("planner: shortlist without crmEnquiryId -> 400", noId.status === 400, `status ${noId.status}`);
    const sl = await api("POST", "/admin/venues/shortlists", { token: adminToken, body: { crmEnquiryId: CRM_ID, coupleName: "Aarohi & Vikram", couplePhone: PLANNER_PHONE } });
    check("planner: shortlist created", sl.status === 201 && sl.json.shortlist && sl.json.duplicate === false, `status ${sl.status}`);
    const slId = sl.json.shortlist && sl.json.shortlist._id;
    const slDup = await api("POST", "/admin/venues/shortlists", { token: adminToken, body: { crmEnquiryId: CRM_ID } });
    check("planner: duplicate crmEnquiryId -> 200 existing", slDup.status === 200 && slDup.json.duplicate === true && String(slDup.json.shortlist._id) === String(slId), `status ${slDup.status}`);

    // Items: add (dedupe 409), unknown venue 404, notes patch.
    const add1 = await api("POST", `/admin/venues/shortlists/${slId}/items`, { token: adminToken, body: { venueSlug: SLUG, notes: "Great lawn for 450 pax" } });
    check("planner: add venue A -> 201", add1.status === 201, `status ${add1.status}`);
    const add1Dup = await api("POST", `/admin/venues/shortlists/${slId}/items`, { token: adminToken, body: { venueSlug: SLUG } });
    check("planner: duplicate venue on shortlist -> 409", add1Dup.status === 409, `status ${add1Dup.status}`);
    const add2 = await api("POST", `/admin/venues/shortlists/${slId}/items`, { token: adminToken, body: { venueSlug: "test-palace-two" } });
    check("planner: add venue B -> 201", add2.status === 201, `status ${add2.status}`);
    const addGhost = await api("POST", `/admin/venues/shortlists/${slId}/items`, { token: adminToken, body: { venueSlug: "no-such-venue" } });
    check("planner: unknown venue -> 404", addGhost.status === 404, `status ${addGhost.status}`);
    const items = add2.json.shortlist.items;
    const itemA = items.find((i) => i.venue && i.venue.slug === SLUG);
    const itemB = items.find((i) => i.venue && i.venue.slug === "test-palace-two");
    check("planner: detail items carry venue cards", Boolean(itemA && itemB && itemA.venue.name), itemA && itemA.venue && itemA.venue.name);
    const patchNote = await api("PATCH", `/admin/venues/shortlists/${slId}/items/${itemA._id}`, { token: adminToken, body: { notes: "Owner quotes ₹1500/plate veg" } });
    check("planner: item notes patched", patchNote.status === 200, `status ${patchNote.status}`);
    const patchBadStatus = await api("PATCH", `/admin/venues/shortlists/${slId}/items/${itemA._id}`, { token: adminToken, body: { status: "reacted" } });
    check("planner: admin cannot force status=reacted -> 400", patchBadStatus.status === 400, `status ${patchBadStatus.status}`);

    // Present link + PUBLIC present mode.
    const link1 = await api("POST", `/admin/venues/shortlists/${slId}/present-link`, { token: adminToken });
    check("planner: present link -> 48-hex token", link1.status === 200 && /^[a-f0-9]{48}$/.test(link1.json.presentToken || ""), `status ${link1.status}`);
    const token1 = link1.json.presentToken;
    const pub1 = await api("GET", `/venues/present/${token1}`);
    check("present: public read -> 200 with venue cards", pub1.status === 200 && Array.isArray(pub1.json.items) && pub1.json.items.length === 2 && pub1.json.items.every((i) => i.venue && i.venue.name), `status ${pub1.status}`);
    check("present: no phone/CRM leakage in public payload", !JSON.stringify(pub1.json).includes(PLANNER_PHONE) && !JSON.stringify(pub1.json).includes(CRM_ID));
    const pubItemA = pub1.json.items.find((i) => i.venue.name === "Test Palace");
    const reactOk = await api("POST", `/venues/present/${token1}/react`, { body: { itemId: pubItemA.itemId, reaction: "love" } });
    check("present: couple reaction accepted", reactOk.status === 200 && reactOk.json.reaction === "love", `status ${reactOk.status}`);
    const reactBad = await api("POST", `/venues/present/${token1}/react`, { body: { itemId: pubItemA.itemId, reaction: "meh" } });
    check("present: unknown reaction -> 400", reactBad.status === 400, `status ${reactBad.status}`);
    const reactGhost = await api("POST", `/venues/present/${token1}/react`, { body: { itemId: "000000000000000000000000", reaction: "no" } });
    check("present: unknown item -> 404", reactGhost.status === 404, `status ${reactGhost.status}`);
    const afterReact = await api("GET", `/admin/venues/shortlists/${slId}`, { token: adminToken });
    const reactedItem = afterReact.json.shortlist.items.find((i) => String(i._id) === String(pubItemA.itemId));
    check("planner: reaction lands in admin view (status reacted)", reactedItem && reactedItem.reaction === "love" && reactedItem.status === "reacted", reactedItem && reactedItem.status);

    // Token typing + replay-after-rotation.
    const malformed = await api("GET", "/venues/present/not-a-token");
    check("present: malformed token -> 400", malformed.status === 400, `status ${malformed.status}`);
    const unknownTok = await api("GET", `/venues/present/${"ab".repeat(24)}`);
    check("present: well-formed unknown token -> 404", unknownTok.status === 404, `status ${unknownTok.status}`);
    const link2 = await api("POST", `/admin/venues/shortlists/${slId}/present-link`, { token: adminToken });
    const replay = await api("GET", `/venues/present/${token1}`);
    check("present: rotated link kills the old token (replay -> 404)", link2.status === 200 && replay.status === 404, `replay ${replay.status}`);

    // One-tap hold: D2 linkage creates the owner-visible lead (source wedsy + crmLeadRef).
    const holdDate = new Date(Date.now() + 220 * 86400000).toISOString().slice(0, 10);
    const tapHold = await api("POST", `/admin/venues/shortlists/${slId}/items/${itemA._id}/hold`, { token: adminToken, body: { dates: [holdDate] } });
    check("planner: one-tap hold -> 201 wedsy request + linked enquiry", tapHold.status === 201 && tapHold.json.hold.requestedBy === "wedsy" && Boolean(tapHold.json.enquiryId), `status ${tapHold.status}`);
    const linkedEnqId = tapHold.json.enquiryId;
    const enqList = await api("GET", `/admin/venues/${SLUG}/enquiries?source=wedsy&limit=100`, { token: adminToken });
    const linkedEnq = (enqList.json.enquiries || []).find((e) => String(e._id) === String(linkedEnqId));
    check("planner: D2 lead is owner-visible with source=wedsy + crmLeadRef", Boolean(linkedEnq) && linkedEnq.crmLeadRef === CRM_ID, linkedEnq && linkedEnq.crmLeadRef);
    const tapHoldAgain = await api("POST", `/admin/venues/shortlists/${slId}/items/${itemA._id}/hold`, { token: adminToken, body: { dates: [holdDate] } });
    check("planner: second hold while active -> 409", tapHoldAgain.status === 409, `status ${tapHoldAgain.status}`);
    const badDates = await api("POST", `/admin/venues/shortlists/${slId}/items/${itemB._id}/hold`, { token: adminToken, body: { dates: ["soon"] } });
    check("planner: malformed hold dates -> 400", badDates.status === 400, `status ${badDates.status}`);

    // Site visit on the SAME couple+venue reuses the D2 lead (phone dedup).
    const visitAt = new Date(Date.now() + 12 * 86400000).toISOString();
    const visit = await api("POST", `/admin/venues/shortlists/${slId}/items/${itemA._id}/visit`, { token: adminToken, body: { scheduledAt: visitAt, notes: "Bring decor lookbook" } });
    check("planner: visit scheduled -> 201", visit.status === 201, `status ${visit.status}`);
    check("planner: D2 dedup — visit reuses the hold's enquiry", visit.status === 201 && String(visit.json.enquiryId) === String(linkedEnqId), `enq ${visit.json && visit.json.enquiryId}`);
    const visitId = visit.json.visit && visit.json.visit._id;
    const visitBad = await api("POST", `/admin/venues/shortlists/${slId}/items/${itemB._id}/visit`, { token: adminToken, body: { scheduledAt: "whenever" } });
    check("planner: malformed visit datetime -> 400", visitBad.status === 400, `status ${visitBad.status}`);

    // Owner side: sees + progresses the walk-through.
    const ownerVisits = await api("GET", `/venues/${SLUG}/site-visits`, { token });
    check("planner: owner sees the visit with couple attached", ownerVisits.status === 200 && (ownerVisits.json.visits || []).some((v) => String(v._id) === String(visitId) && v.enquiryRef && v.enquiryRef.coupleName), `status ${ownerVisits.status}`);
    const ownerConfirm = await api("PATCH", `/venues/${SLUG}/site-visits/${visitId}`, { token, body: { status: "confirmed" } });
    check("planner: owner confirms visit -> 200", ownerConfirm.status === 200 && ownerConfirm.json.visit.status === "confirmed", `status ${ownerConfirm.status}`);
    const adminVisits = await api("GET", `/admin/venues/site-visits?status=confirmed`, { token: adminToken });
    check("planner: admin visit oversight reflects owner's confirm", adminVisits.status === 200 && (adminVisits.json.visits || []).some((v) => String(v._id) === String(visitId) && v.venue && v.venue.slug === SLUG), `status ${adminVisits.status}`);
    const adminVisitBad = await api("GET", "/admin/venues/site-visits?status=bogus", { token: adminToken });
    check("planner: unknown visit status filter -> 400", adminVisitBad.status === 400, `status ${adminVisitBad.status}`);

    // Item removal keeps the shortlist consistent.
    const rm = await api("DELETE", `/admin/venues/shortlists/${slId}/items/${itemB._id}`, { token: adminToken });
    check("planner: item removal -> 200, one item left", rm.status === 200 && rm.json.shortlist.items.length === 1, `status ${rm.status}`);

    // Planner list rollup.
    const lists = await api("GET", "/admin/venues/shortlists?limit=50", { token: adminToken });
    const listRow = (lists.json.shortlists || []).find((s) => s.crmEnquiryId === CRM_ID);
    check("planner: list rollup (counts + link flag)", lists.status === 200 && listRow && listRow.itemCount === 1 && listRow.reactedCount === 1 && listRow.hasPresentLink === true, listRow && JSON.stringify({ itemCount: listRow.itemCount, reactedCount: listRow.reactedCount }));
  }

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

  // ================= MB-V2 P0 S1: admin venue ops (directory + 360 reads) =================
  if (process.env.E2E_ADMIN_OPS === "1") {
    const jwt = require("jsonwebtoken");
    require("dotenv").config();
    const adminToken = jwt.sign({ _id: "000000000000000000000001", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // Directory: rows + total, seeded venue present with derived claim state.
    const dir = await api("GET", "/admin/venues?limit=100", { token: adminToken });
    check("admin-ops: directory -> 200 with venues+total", dir.status === 200 && Array.isArray(dir.json.venues) && typeof dir.json.total === "number", `status ${dir.status}`);
    const dirRow = ((dir.json && dir.json.venues) || []).find((v) => v.slug === SLUG);
    check("admin-ops: seeded venue claimState=claimed (active owner)", Boolean(dirRow) && dirRow.claimState === "claimed", dirRow && dirRow.claimState);
    check("admin-ops: directory row carries owner snapshot + enquiryCount", Boolean(dirRow) && dirRow.owner && dirRow.owner.phone === OWNER_PHONE && typeof dirRow.enquiryCount === "number", dirRow && JSON.stringify(dirRow.owner));
    const dirClaimed = await api("GET", "/admin/venues?claimState=claimed&limit=100", { token: adminToken });
    check("admin-ops: claimState=claimed filter keeps seeded venue", dirClaimed.status === 200 && dirClaimed.json.venues.some((v) => v.slug === SLUG), `status ${dirClaimed.status}`);
    const dirUnclaimed = await api("GET", "/admin/venues?claimState=unclaimed&limit=100", { token: adminToken });
    check("admin-ops: claimState=unclaimed filter drops seeded venue", dirUnclaimed.status === 200 && !dirUnclaimed.json.venues.some((v) => v.slug === SLUG), `status ${dirUnclaimed.status}`);
    const dirBadClaim = await api("GET", "/admin/venues?claimState=bogus", { token: adminToken });
    check("admin-ops: unknown claimState -> 400", dirBadClaim.status === 400, `status ${dirBadClaim.status}`);
    const dirBadSort = await api("GET", "/admin/venues?sort=bogus", { token: adminToken });
    check("admin-ops: unknown sort -> 400", dirBadSort.status === 400, `status ${dirBadSort.status}`);
    const dirSearch = await api("GET", "/admin/venues?search=Test+Palace&limit=100", { token: adminToken });
    check("admin-ops: name search finds seeded venue", dirSearch.status === 200 && dirSearch.json.venues.some((v) => v.slug === SLUG), `status ${dirSearch.status}`);

    // 360 summary: profile + counts + owner + claim state.
    const sum = await api("GET", `/admin/venues/${SLUG}/summary`, { token: adminToken });
    const counts = (sum.json && sum.json.counts) || {};
    check("admin-ops: summary -> 200 with venue+counts", sum.status === 200 && sum.json.venue && sum.json.venue.slug === SLUG, `status ${sum.status}`);
    check("admin-ops: summary counts shape (enquiries/bookings/docs/conversations/holds)", ["enquiries", "bookings", "quotes", "bills", "invoices", "contracts", "conversations"].every((k) => typeof counts[k] === "number") && counts.holds && typeof counts.holds === "object", JSON.stringify(counts));
    check("admin-ops: summary enquiry count reflects seed", counts.enquiries >= 10, `enquiries ${counts.enquiries}`);
    check("admin-ops: summary claimState=claimed with owner listed", sum.json.claimState === "claimed" && Array.isArray(sum.json.owners) && sum.json.owners.some((o) => o.phone === OWNER_PHONE), sum.json.claimState);
    check("admin-ops: summary strips heavy fields (googleReviews/competitiveCache)", !("googleReviews" in (sum.json.venue || {})) && !("competitiveCache" in (sum.json.venue || {})));
    const sum404 = await api("GET", "/admin/venues/definitely-not-a-venue/summary", { token: adminToken });
    check("admin-ops: summary unknown slug -> 404", sum404.status === 404, `status ${sum404.status}`);

    // Leads tab (D1 Version A): read-only, labeled source + derived creator.
    const enq = await api("GET", `/admin/venues/${SLUG}/enquiries?limit=100`, { token: adminToken });
    check("admin-ops: enquiries -> 200 with rows+total", enq.status === 200 && Array.isArray(enq.json.enquiries) && enq.json.total >= 10, `status ${enq.status}, total ${enq.json && enq.json.total}`);
    check("admin-ops: every lead labeled with source + createdBy", (enq.json.enquiries || []).every((e) => typeof e.source === "string" && ["venue_team", "couple", "unknown"].includes(e.createdBy)), enq.json.enquiries && JSON.stringify(enq.json.enquiries[0] && { source: enq.json.enquiries[0].source, createdBy: enq.json.enquiries[0].createdBy }));
    const enqSrc = await api("GET", `/admin/venues/${SLUG}/enquiries?source=instagram&limit=100`, { token: adminToken });
    check("admin-ops: enquiries source filter honored", enqSrc.status === 200 && (enqSrc.json.enquiries || []).every((e) => e.source === "instagram"), `status ${enqSrc.status}`);
    const enqBadSrc = await api("GET", `/admin/venues/${SLUG}/enquiries?source=bogus`, { token: adminToken });
    check("admin-ops: unknown source -> 400", enqBadSrc.status === 400, `status ${enqBadSrc.status}`);
    const enqBadStage = await api("GET", `/admin/venues/${SLUG}/enquiries?stage=bogus`, { token: adminToken });
    check("admin-ops: unknown stage -> 400", enqBadStage.status === 400, `status ${enqBadStage.status}`);

    // Activity tab (E6): admin PUT writes a wedsy_team entry; filters narrow to it.
    const adminPut = await api("PUT", `/venues/${SLUG}`, { token: adminToken, body: { tagline: "mbv2-admin-ops-probe" } });
    check("admin-ops: admin listing PUT (activity probe) -> 200", adminPut.status === 200, `status ${adminPut.status}`);
    const act = await api("GET", `/admin/venues/${SLUG}/activity?limit=100`, { token: adminToken });
    check("admin-ops: activity -> 200 with rows+total", act.status === 200 && Array.isArray(act.json.activity) && typeof act.json.total === "number", `status ${act.status}`);
    const actWedsy = await api("GET", `/admin/venues/${SLUG}/activity?actorType=wedsy_team&field=tagline&limit=10`, { token: adminToken });
    check("admin-ops: actorType+field filters isolate the admin tagline write", actWedsy.status === 200 && (actWedsy.json.activity || []).length >= 1 && actWedsy.json.activity.every((a) => a.actorType === "wedsy_team" && a.field === "tagline"), `status ${actWedsy.status}, rows ${actWedsy.json && actWedsy.json.activity && actWedsy.json.activity.length}`);
    const actBadSev = await api("GET", `/admin/venues/${SLUG}/activity?severity=catastrophic`, { token: adminToken });
    check("admin-ops: unknown severity -> 400", actBadSev.status === 400, `status ${actBadSev.status}`);
    const actBadActor = await api("GET", `/admin/venues/${SLUG}/activity?actorType=alien`, { token: adminToken });
    check("admin-ops: unknown actorType -> 400", actBadActor.status === 400, `status ${actBadActor.status}`);
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
