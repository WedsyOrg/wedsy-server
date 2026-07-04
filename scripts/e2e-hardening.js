/**
 * scripts/e2e-hardening.js — permanent adversarial test suite for the venue API.
 *
 * Attacks every write endpoint with hostile input, concurrency, IDOR/tenancy,
 * money-math edges, and rate-limit spoofing. Run against a freshly seeded local
 * server (seed-test-venue.js). Prints PASS/FAIL/FLAG; exit non-zero on any FAIL.
 *
 *   node scripts/e2e-hardening.js
 */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const API = process.env.API_URL || "http://localhost:8090";
const A = "test-palace";       // venue A (owner 9999999999)
const B = "test-palace-two";   // venue B (owner 8888888888 owner-identity)

let pass = 0, fail = 0, flag = 0;
const PERF = {};
function rec(s, name, detail) {
  if (s === "PASS") pass++; else if (s === "FAIL") fail++; else flag++;
  const tag = s === "PASS" ? "✓ PASS" : s === "FAIL" ? "✗ FAIL" : "⚑ FLAG";
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const ok = (n, c, d) => rec(c ? "PASS" : "FAIL", n, d);
const flagIf = (n, c, d) => rec(c ? "FLAG" : "PASS", n, d);

async function api(method, path, { token, body, rawBody, headers } = {}) {
  const h = { "Content-Type": "application/json", ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}
async function loginToken(phone) {
  const r = await api("POST", "/venue-owner/auth", { body: { phone, otp: "000000", referenceId: "dev" } });
  return r.json && r.json.token;
}

async function run() {
  console.log(`[hardening] target ${API}\n`);

  // ── Setup tokens ──
  const tokenA = await loginToken("9999999999"); // venue A owner
  // venue B owner via 8888888888 owner identity
  const multi = await api("POST", "/venue-owner/auth", { body: { phone: "8888888888", otp: "000000", referenceId: "dev" } });
  const ownerId = (multi.json.identities || []).find((i) => i.kind === "owner");
  const selB = await api("POST", "/venue-owner/auth/select-identity", { body: { selectionToken: multi.json.selectionToken, kind: "owner", id: ownerId && ownerId.id } });
  const tokenB = selB.json && selB.json.token;
  ok("setup: venue A + venue B owner tokens", Boolean(tokenA && tokenB));
  if (!tokenA || !tokenB) return finish();

  const enquiriesA = (await api("GET", `/venues/${A}/enquiries`, { token: tokenA })).json.enquiries || [];
  const leadId = enquiriesA[0]._id;

  // ═══════════ 1. HOSTILE INPUT ═══════════
  console.log("\n— 1. Hostile input —");
  // whitespace-only required fields
  {
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "   ", couplePhone: "   " } });
    ok("1 whitespace-only required -> 400", r.status === 400, `status ${r.status}`);
  }
  // null / wrong-type bodies on write routes -> 400/4xx never 500
  for (const [label, path, method] of [
    ["manual", `/venues/${A}/enquiries/manual`, "POST"],
    ["patch", `/venues/${A}/enquiries/${leadId}`, "PATCH"],
    ["bulk", `/venues/${A}/enquiries/bulk`, "POST"],
    ["quote", `/venues/${A}/quotes`, "POST"],
    ["invoice", `/venues/${A}/invoices`, "POST"],
    ["import", `/venues/${A}/enquiries/import`, "POST"],
  ]) {
    for (const [bodyLabel, raw] of [["null", "null"], ["string", '"hax"'], ["array", "[]"], ["number", "5"]]) {
      const r = await api(method, path, { token: tokenA, rawBody: raw });
      ok(`1 ${label} body=${bodyLabel} -> not 500`, r.status !== 500, `status ${r.status}`);
    }
  }
  // emoji + non-Latin couple name stored intact
  {
    const name = "अंकित 💍 José Ñoño 王伟";
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: name, couplePhone: "9811110001" } });
    const stored = r.json && r.json.enquiry && r.json.enquiry.coupleName;
    ok("1 emoji/non-Latin name stored intact", [200, 201].includes(r.status) && stored === name, `status ${r.status}`);
  }
  // stored-XSS payload stored verbatim (rendered inert by React; verify not 500 and stored as-is)
  {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: xss, couplePhone: "9811110002" } });
    ok("1 XSS payload stored verbatim (inert)", [200, 201].includes(r.status) && r.json.enquiry.coupleName === xss, `status ${r.status}`);
  }
  // 10k-char string -> sane maxlength (400) not stored unbounded
  {
    const big = "x".repeat(10000);
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: big, couplePhone: "9811110003" } });
    const storedLen = r.json && r.json.enquiry ? (r.json.enquiry.coupleName || "").length : 0;
    ok("1 10k-char name rejected or capped (<=2000)", r.status === 400 || storedLen <= 2000, `status ${r.status} len ${storedLen}`);
  }
  // negative / absurd numeric
  {
    const r1 = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "Neg Guests", couplePhone: "9811110004", guestCount: -5 } });
    ok("1 negative guestCount -> 400", r1.status === 400, `status ${r1.status}`);
    const r2 = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "Neg Value", couplePhone: "9811110005", estimatedValue: -100 } });
    ok("1 negative estimatedValue -> 400", r2.status === 400, `status ${r2.status}`);
  }
  // invalid dates -> 400, not NaN
  for (const bad of ["31-02-2026", "abc", "not-a-date"]) {
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "Bad Date", couplePhone: "9811110006", eventDate: bad } });
    ok(`1 invalid eventDate "${bad}" -> 400`, r.status === 400, `status ${r.status}`);
  }

  // ═══════════ 3. CONCURRENCY & IDEMPOTENCY ═══════════
  console.log("\n— 3. Concurrency & idempotency —");
  // parallel manual-creates of the same phone
  {
    const phone = "9844440001";
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: `Race ${i}`, couplePhone: phone } })));
    const created = (await api("GET", `/venues/${A}/enquiries`, { token: tokenA })).json.enquiries.filter((e) => (e.couplePhone || "").replace(/\D/g, "").endsWith("9844440001")).length;
    flagIf("3 parallel same-phone manual create deduped to 1", created !== 1, `created ${created} (no unique index -> flag)`);
  }
  // invoice number race: 10 simultaneous creates -> unique sequential
  {
    const bookings = (await api("GET", `/venues/${B}/bookings`, { token: tokenB })).json.bookings || [];
    if (bookings[0]) {
      const res = await Promise.all(Array.from({ length: 10 }, () =>
        api("POST", `/venues/${B}/invoices`, { token: tokenB, body: { booking: bookings[0]._id, kind: "advance" } })));
      const nums = res.filter((r) => r.json && r.json.invoice).map((r) => r.json.invoice.invoiceNumber);
      const uniq = new Set(nums);
      ok("3 invoice-number race: 10 creates all succeed", res.every((r) => r.status === 201), `statuses ${res.map((r) => r.status).join(",")}`);
      ok("3 invoice numbers all unique", nums.length === uniq.size, `${nums.length} created, ${uniq.size} unique`);
    } else { rec("FLAG", "3 invoice race: no booking on venue B to test", ""); }
  }
  // two simultaneous PATCH -> no 500
  {
    const res = await Promise.all([
      api("PATCH", `/venues/${A}/enquiries/${leadId}`, { token: tokenA, body: { stage: "contacted" } }),
      api("PATCH", `/venues/${A}/enquiries/${leadId}`, { token: tokenA, body: { stage: "negotiating" } }),
    ]);
    ok("3 concurrent PATCH no 500", res.every((r) => r.status !== 500), `statuses ${res.map((r) => r.status).join(",")}`);
  }

  // ═══════════ 4. AUTH & TENANCY (IDOR) ═══════════
  console.log("\n— 4. Auth & tenancy (IDOR) —");
  // venue B owner hitting venue A resources
  {
    const r1 = await api("PATCH", `/venues/${A}/enquiries/${leadId}`, { token: tokenB, body: { stage: "lost" } });
    ok("4 IDOR: venueB token PATCH venueA lead -> 403/404", [403, 404].includes(r1.status), `status ${r1.status}`);
    const r2 = await api("GET", `/venues/${A}/enquiries`, { token: tokenB });
    ok("4 IDOR: venueB token GET venueA enquiries -> 403/404", [403, 404].includes(r2.status), `status ${r2.status}`);
  }
  // tampered / empty JWT
  {
    const r1 = await api("GET", `/venues/dashboard/overview`, { token: "garbage.token.here" });
    ok("4 tampered JWT -> 401", r1.status === 401, `status ${r1.status}`);
    const r2 = await api("GET", `/venues/dashboard/overview`, { token: jwt.sign({ type: "venue_owner", venueOwnerId: "x", venueId: "y" }, "WRONG_SECRET") });
    ok("4 wrong-secret JWT -> 401", r2.status === 401, `status ${r2.status}`);
  }
  // role-escalation via body ignored
  {
    const r = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "Esc", couplePhone: "9855550001", role: "owner", isAdmin: true, venueId: "000000000000000000000000" } });
    const venueOk = [200, 201].includes(r.status) && r.json.enquiry && String(r.json.enquiry.venueId) !== "000000000000000000000000";
    ok("4 role/venueId in body ignored (server derives from token)", venueOk, `status ${r.status}`);
  }
  // deactivated member JWT rejected on next request
  {
    // login the manager member, then deactivate via owner, then reuse token
    const memToken = await loginToken("9700000001");
    const team = (await api("GET", `/venues/${A}/team`, { token: tokenA })).json.members || (await api("GET", `/venues/${A}/team`, { token: tokenA })).json.team || [];
    const mgr = team.find((m) => m.phone === "9700000001");
    if (memToken && mgr) {
      await api("PATCH", `/venues/${A}/team/${mgr._id}`, { token: tokenA, body: { isActive: false } });
      const after = await api("GET", `/venues/${A}/enquiries`, { token: memToken });
      ok("4 deactivated member token rejected next request", [401, 403].includes(after.status), `status ${after.status}`);
      // reactivate for idempotent reseed-free reruns
      await api("PATCH", `/venues/${A}/team/${mgr._id}`, { token: tokenA, body: { isActive: true } });
    } else { rec("FLAG", "4 deactivated-member: could not resolve member", `token ${!!memToken} mgr ${!!mgr}`); }
  }

  // ═══════════ 5. MONEY MATH EDGE ═══════════
  console.log("\n— 5. Money math edge —");
  const newLead = await api("POST", `/venues/${A}/enquiries/manual`, { token: tokenA, body: { coupleName: "Money Test", couplePhone: "9866660001" } });
  const mlId = newLead.json.enquiry._id;
  // GST producing paise: 33333 @ 18% = 5999.94 -> round
  {
    const q = await api("POST", `/venues/${A}/quotes`, { token: tokenA, body: { enquiry: mlId, lineItems: [{ label: "x", qty: 1, unitPrice: 33333 }], gstPercent: 18, discount: 0 } });
    const t = q.json.quote.totals;
    ok("5 GST 33333@18% rounded consistently (gst=6000, grand=39333)", t.subtotal === 33333 && t.gst === 6000 && t.grandTotal === 39333, `gst=${t.gst} grand=${t.grandTotal}`);
  }
  // discount > subtotal -> grandTotal floored at 0
  {
    const q = await api("POST", `/venues/${A}/quotes`, { token: tokenA, body: { enquiry: mlId, lineItems: [{ label: "x", qty: 1, unitPrice: 1000 }], gstPercent: 18, discount: 999999 } });
    const t = q.json.quote.totals;
    ok("5 discount>subtotal floors grandTotal at 0", t.grandTotal === 0, `grand=${t.grandTotal}`);
  }
  // zero line items quote cannot be accepted
  {
    const q = await api("POST", `/venues/${A}/quotes`, { token: tokenA, body: { enquiry: mlId, lineItems: [], gstPercent: 18, discount: 0 } });
    const acc = await api("PATCH", `/venues/${A}/quotes/${q.json.quote._id}`, { token: tokenA, body: { status: "accepted" } });
    ok("5 zero-line-item quote accept -> 400", acc.status === 400, `status ${acc.status}`);
  }
  // payment 0 / negative -> 400 ; payment > balance -> capped/rejected
  {
    const bk = (await api("GET", `/venues/${B}/bookings`, { token: tokenB })).json.bookings[0];
    const inv = await api("POST", `/venues/${B}/invoices`, { token: tokenB, body: { booking: bk._id, kind: "final", lineItems: [{ label: "x", qty: 1, unitPrice: 100000 }], gstPercent: 18 } });
    const invId = inv.json.invoice._id;
    const grand = inv.json.invoice.totals.grandTotal; // 118000
    const p0 = await api("POST", `/venues/${B}/invoices/${invId}/payments`, { token: tokenB, body: { amount: 0 } });
    ok("5 payment amount 0 -> 400", p0.status === 400, `status ${p0.status}`);
    const pn = await api("POST", `/venues/${B}/invoices/${invId}/payments`, { token: tokenB, body: { amount: -50 } });
    ok("5 payment amount negative -> 400", pn.status === 400, `status ${pn.status}`);
    const over = await api("POST", `/venues/${B}/invoices/${invId}/payments`, { token: tokenB, body: { amount: grand + 50000 } });
    ok("5 overpayment rejected (> balance -> 400)", over.status === 400, `status ${over.status}`);
  }

  // ═══════════ 8. RATE-LIMIT INTEGRITY ═══════════
  console.log("\n— 8. Rate-limit integrity —");
  {
    // spoofed X-Forwarded-For should NOT grant fresh buckets per fake IP
    const phone = "9877770001";
    let blocked = false;
    for (let i = 0; i < 6; i++) {
      const r = await api("POST", `/venues/${A}/enquiry`, { headers: { "X-Forwarded-For": `1.2.3.${i}` }, body: { coupleName: `Spoof ${i}`, couplePhone: phone } });
      if (r.status === 429) blocked = true;
    }
    ok("8 X-Forwarded-For spoof does not bypass per-IP limit", blocked, "expected a 429 within 6 spoofed-IP requests");
  }

  // ═══════════ 2. IMPORT TORTURE (server takes parsed rows; CSV/xlsx/encoding parsing is client-side) ═══════════
  console.log("\n— 2. Import torture —");
  const RUNBASE = 7000000000 + (Date.now() % 1000000000); // run-unique 10-digit phone base
  const phoneAt = (i) => String(RUNBASE + i);
  // 5,000-row import — measure time, must complete
  {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ coupleName: `Bulk ${i}`, couplePhone: phoneAt(i), source: "google" }));
    const t0 = Date.now();
    const r = await api("POST", `/venues/${A}/enquiries/import`, { token: tokenA, body: { rows, fileName: "torture-5000.csv" } });
    const ms = Date.now() - t0;
    PERF.import5000 = `${r.json && r.json.created} created / 5000 in ${ms}ms`;
    ok("2 5,000-row import completes (created>=4990)", r.status === 200 && r.json.created >= 4990, `created ${r.json && r.json.created} in ${ms}ms`);
  }
  // same file imported twice -> full dedup skip
  {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ coupleName: `Bulk ${i}`, couplePhone: phoneAt(i) }));
    const r = await api("POST", `/venues/${A}/enquiries/import`, { token: tokenA, body: { rows } });
    ok("2 re-import same file -> all skipped (created 0)", r.status === 200 && r.json.created === 0 && r.json.skipped >= 4990, `created ${r.json.created} skipped ${r.json.skipped}`);
  }
  // all-duplicates file (same phone repeated)
  {
    const p = phoneAt(900001);
    const rows = Array.from({ length: 50 }, () => ({ coupleName: "Dup", couplePhone: p }));
    const r = await api("POST", `/venues/${A}/enquiries/import`, { token: tokenA, body: { rows } });
    ok("2 all-duplicates file -> created 1, skipped 49", r.status === 200 && r.json.created === 1 && r.json.skipped === 49, `created ${r.json.created} skipped ${r.json.skipped}`);
  }
  // alternating good/bad rows — every good imported, every bad reported
  {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ coupleName: `Good ${i}`, couplePhone: phoneAt(950000 + i) }); // good
      rows.push({ coupleName: "", couplePhone: "" }); // bad (no name/phone)
    }
    const r = await api("POST", `/venues/${A}/enquiries/import`, { token: tokenA, body: { rows } });
    const errs = (r.json && r.json.errors) || [];
    ok("2 alternating good/bad: 10 created, 10 errors reported", r.status === 200 && r.json.created === 10 && errs.length === 10, `created ${r.json.created} errors ${errs.length}`);
  }
  // empty file
  {
    const r = await api("POST", `/venues/${A}/enquiries/import`, { token: tokenA, body: { rows: [] } });
    ok("2 empty rows -> 200 created 0 (no crash)", r.status === 200 && r.json.created === 0, `status ${r.status}`);
  }

  // ═══════════ 6. VOLUME & RENDER (API side) ═══════════
  console.log("\n— 6. Volume & analytics —");
  {
    // after the 5,000-row import, list + analytics must respond quickly
    let t0 = Date.now();
    const list = await api("GET", `/venues/${A}/enquiries`, { token: tokenA });
    const listMs = Date.now() - t0;
    PERF.list = `${(list.json.enquiries || []).length} leads in ${listMs}ms`;
    ok("6 enquiries list at 5000+ responds <5s", list.status === 200 && listMs < 5000 && list.json.enquiries.length >= 5000, `${list.json.enquiries.length} in ${listMs}ms`);
    t0 = Date.now();
    const an = await api("GET", `/venues/${A}/analytics`, { token: tokenA });
    const anMs = Date.now() - t0;
    PERF.analytics = `${anMs}ms over ${an.json && an.json.total} leads`;
    ok("6 analytics over large dataset responds <5s, no NaN", an.status === 200 && anMs < 5000 && typeof an.json.total === "number" && !Number.isNaN(an.json.funnel.conversion.bookingRate), `${anMs}ms total ${an.json.total}`);
  }
  // analytics over an EMPTY range -> designed zero state, no NaN
  {
    const an = await api("GET", `/venues/${A}/analytics?from=2000-01-01&to=2000-01-02`, { token: tokenA });
    const t = an.json;
    ok("6 analytics empty range -> 0s, no NaN/crash", an.status === 200 && t.total === 0 && t.funnel.conversion.bookingRate === 0 && Array.isArray(t.volume.byMonth), `total ${t.total}`);
  }

  // ═══════════ 7. RESILIENCE (API-testable subset) ═══════════
  console.log("\n— 7. Resilience —");
  {
    // server stays up + returns clean JSON under a burst of malformed requests
    const bad = await Promise.all(Array.from({ length: 20 }, () =>
      api("PATCH", `/venues/${A}/enquiries/${leadId}`, { token: tokenA, rawBody: "{ this is not json" })));
    ok("7 malformed-JSON burst -> all 4xx, server up", bad.every((r) => r.status >= 400 && r.status < 500), `statuses ${[...new Set(bad.map((r) => r.status))].join(",")}`);
    const alive = await api("GET", `/venues/${A}/enquiries`, { token: tokenA });
    ok("7 server still responsive after burst", alive.status === 200, `status ${alive.status}`);
    // logged-out / no token on a gated route -> 401 (drives the client login redirect)
    const noTok = await api("GET", "/venues/dashboard/overview", {});
    ok("7 gated route without token -> 401", noTok.status === 401, `status ${noTok.status}`);
  }

  // ═══════════ 9. PMS WRITE SURFACES (rooms / allotments / runsheet) ═══════════
  console.log("\n— 9. PMS hostile input —");
  {
    // XSS room name stored verbatim (inert), giant name rejected
    const xssName = '<img src=x onerror=alert(1)>Suite';
    const rx = await api("POST", `/venues/${A}/rooms`, { token: tokenA, body: { name: xssName, type: "suite" } });
    ok("9 XSS room name stored verbatim (inert)", rx.status === 201 && rx.json.room.name === xssName, `status ${rx.status}`);
    const rGiant = await api("POST", `/venues/${A}/rooms`, { token: tokenA, body: { name: "R".repeat(10000) } });
    ok("9 10k-char room name -> 400", rGiant.status === 400, `status ${rGiant.status}`);
    const rNegCap = await api("POST", `/venues/${A}/rooms`, { token: tokenA, body: { name: "Neg", capacity: -3 } });
    ok("9 negative capacity -> 400", rNegCap.status === 400, `status ${rNegCap.status}`);

    // a booking to hang allotments off
    const bkr = await api("POST", `/venues/${A}/bookings`, { token: tokenA, body: { coupleName: "PMS Torture", days: [{ date: new Date(Date.now() + 30 * 86400000).toISOString() }] } });
    const bId = bkr.json.booking && bkr.json.booking._id;
    const roomId = rx.json.room._id;

    const aAbsurd = await api("POST", `/venues/${A}/bookings/${bId}/allotments`, { token: tokenA, body: { room: roomId, guestName: "X", checkInAt: "9999-01-01", checkOutAt: "9999-01-02" } });
    ok("9 absurd-year allotment dates -> 400", aAbsurd.status === 400, `status ${aAbsurd.status}`);
    const aJunkRoom = await api("POST", `/venues/${A}/bookings/${bId}/allotments`, { token: tokenA, body: { room: "not-an-objectid", guestName: "X", checkInAt: new Date(Date.now() + 86400000).toISOString(), checkOutAt: new Date(Date.now() + 2 * 86400000).toISOString() } });
    ok("9 junk room id -> 4xx, not 500", aJunkRoom.status >= 400 && aJunkRoom.status < 500, `status ${aJunkRoom.status}`);
    const aHuge = await api("POST", `/venues/${A}/bookings/${bId}/allotments`, { token: tokenA, body: { allotments: Array.from({ length: 51 }, () => ({ room: roomId, guestName: "X", checkInAt: new Date().toISOString(), checkOutAt: new Date(Date.now() + 86400000).toISOString() })) } });
    ok("9 51-item bulk allotment -> 400", aHuge.status === 400, `status ${aHuge.status}`);

    const rsGiant = await api("POST", `/venues/${A}/bookings/${bId}/runsheet`, { token: tokenA, body: { day: new Date(Date.now() + 30 * 86400000).toISOString(), title: "T".repeat(10000) } });
    ok("9 10k-char runsheet title -> 400", rsGiant.status === 400, `status ${rsGiant.status}`);
    const rsBadStatus = await api("POST", `/venues/${A}/bookings/${bId}/runsheet`, { token: tokenA, body: { day: new Date(Date.now() + 30 * 86400000).toISOString(), title: "ok", status: "exploded" } });
    ok("9 bad runsheet status enum -> 400", rsBadStatus.status === 400, `status ${rsBadStatus.status}`);
    const reorderForeign = await api("POST", `/venues/${A}/bookings/${bId}/runsheet/reorder`, { token: tokenA, body: { day: new Date(Date.now() + 30 * 86400000).toISOString(), ids: [leadId] } });
    ok("9 reorder with foreign ids -> 400", reorderForeign.status === 400, `status ${reorderForeign.status}`);

    // tenancy: venue B's owner cannot touch venue A's PMS surfaces
    const idor = await api("POST", `/venues/${A}/rooms`, { token: tokenB, body: { name: "Intruder" } });
    ok("9 cross-venue room write -> 403", idor.status === 403, `status ${idor.status}`);
    const idorOcc = await api("GET", `/venues/${A}/occupancy`, { token: tokenB });
    ok("9 cross-venue occupancy read -> 403", idorOcc.status === 403, `status ${idorOcc.status}`);
  }

  finish();
}

function finish() {
  console.log(`\n[hardening] perf: ${JSON.stringify(PERF)}`);
  console.log(`[hardening] ${pass} passed, ${fail} failed, ${flag} flagged`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error("[hardening] crashed:", e); process.exit(1); });
