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
  return { status: res.status, contentType: res.headers.get("content-type") || "", bytes: buf.length, head: buf.slice(0, 5).toString("latin1") };
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
    const paged = await api("GET", `/venues?limit=1&status=published`, {});
    check("couple: browse pagination (limit=1 + total)", paged.status === 200 && paged.json.venues.length <= 1 && typeof paged.json.total === "number", `n ${paged.json.venues.length} total ${paged.json.total}`);
    // amenity filter: enable evCharging on test-palace, then filter
    await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: true } } });
    const byAmenity = await api("GET", `/venues?amenities=evCharging&status=published`, {});
    const hasTP = (byAmenity.json.venues || []).some((x) => x.slug === SLUG);
    check("couple: browse amenities=evCharging includes the toggled venue", byAmenity.status === 200 && hasTP, `found ${hasTP}`);
    await api("PUT", `/venues/${SLUG}`, { token, body: { amenities: { evCharging: false } } });
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
