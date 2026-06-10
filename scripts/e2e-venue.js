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
