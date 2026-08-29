// VenueMail on a box that installs with --omit=dev. Run:
//   DATABASE_URL=mongodb://127.0.0.1:27017/<testdb> node tests/venue-mail-runtime.test.js
//
// THE RULE UNDER TEST: nothing on the request path requires the MJML
// compiler, and no failure to render can ever produce "no row, no verdict,
// a 500". The first version of VenueMail required "mjml" (a devDependency)
// inside the fallback and rendered BEFORE inserting the record — on the box
// that was Cannot find module 'mjml' → no row → 500 in the modal. These are
// failing expectations, not comments.
require("dotenv").config();
process.env.VENUE_MAIL_RENDER = "repo";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueEmailSend = require("../models/VenueEmailSend");
const VenueMail = require("../services/VenueMail");
const send = require("../controllers/venueDocumentSend");

const TAG = `vmrt-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const created = { venues: [], owners: [], leads: [] };
const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); } else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  try {
    // ══ A. THE COMPILER IS NOT ON THE REQUEST PATH ═══════════════════════════
    console.log("\n[A. no runtime code requires \"mjml\"]");
    const runtimeDirs = ["services", "controllers", "utils", "models", "routes", "middleware"].filter((d) => fs.existsSync(path.join(ROOT, d)));
    const offenders = runtimeDirs.flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /require\(\s*["']mjml["']\s*\)/.test(fs.readFileSync(f, "utf8")));
    eq(offenders.length, 0, `🔴 no file under ${runtimeDirs.join("/")} requires "mjml"${offenders.length ? ` — ${offenders.map((f) => path.relative(ROOT, f)).join(", ")}` : ""}`);
    ok(/require\(\s*["']mjml["']\s*\)/.test(fs.readFileSync(path.join(ROOT, "server.js"), "utf8")) === false, "…nor server.js");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    ok(!(pkg.dependencies || {}).mjml && (pkg.devDependencies || {}).mjml, "🔴 mjml is a devDependency and NOT a dependency — it stays off the box");

    // ══ B. THE ARTEFACT MATCHES ITS SOURCE ═══════════════════════════════════
    console.log("\n[B. emails/compiled/<slug>.html is exactly what its .mjml.json compiles to]");
    const mjml2html = require("mjml"); // devDependency — tests may use it
    for (const [kind, spec] of Object.entries(VenueMail.KINDS)) {
      const src = JSON.parse(fs.readFileSync(path.join(ROOT, "emails", `${spec.slug}.mjml.json`), "utf8"));
      const fresh = mjml2html(src, { validationLevel: "soft" }).html;
      const artefactPath = path.join(VenueMail.COMPILED_DIR, `${spec.slug}.html`);
      ok(fs.existsSync(artefactPath), `${spec.slug}: compiled artefact exists`);
      const artefact = fs.existsSync(artefactPath) ? fs.readFileSync(artefactPath, "utf8") : "";
      eq(artefact === fresh, true, `🔴 ${spec.slug}: artefact === fresh compile (a hand-edited artefact or a stale one after a source change fails here)`);
      ok(/\{\{var:message_html\}\}/.test(artefact) || kind === "terms", `${spec.slug}: carries the message region`);
    }
    // Prove B can fail: a one-byte edit to the artefact is caught.
    {
      const p = path.join(VenueMail.COMPILED_DIR, "venue_quote_sent.html");
      const orig = fs.readFileSync(p, "utf8");
      const src = JSON.parse(fs.readFileSync(path.join(ROOT, "emails", "venue_quote_sent.mjml.json"), "utf8"));
      const fresh = mjml2html(src, { validationLevel: "soft" }).html;
      ok(orig.replace("POWERED BY WEDSY", "POWERED BY WEDSY ") !== fresh, "…a hand edit to the artefact would not equal the fresh compile");
    }

    // ══ B2. THE SETTLED COPY — rules that must hold in every template and default ══
    console.log("\n[B2. copy rules: event not wedding; no reply-to; no owner_name; the {{venue}} — <thing> subject; the window sentence]");
    {
      const sources = [];
      for (const spec of Object.values(VenueMail.KINDS)) {
        sources.push(fs.readFileSync(path.join(ROOT, "emails", `${spec.slug}.txt`), "utf8"));
        sources.push(fs.readFileSync(path.join(ROOT, "emails", `${spec.slug}.mjml.json`), "utf8"));
        sources.push(fs.readFileSync(path.join(VenueMail.COMPILED_DIR, `${spec.slug}.html`), "utf8"));
      }
      eq(Object.keys(VenueMail.KINDS).length, 6, "six kinds (terms, quote, booking_confirmation, invoice, statement, receipt)");
      const venue = { name: "Crown Estate", contact: { primaryPhone: "+91 98450 00000" } };
      const withWindow = { checkIn: "2026-08-30T10:30:00Z", checkOut: "2026-08-31T10:30:00Z" };
      const defaults = Object.keys(VenueMail.KINDS).map((k) => VenueMail.defaultMessage(k, { venue, lead: withWindow, amount: 250000 }));
      const everything = sources.concat(defaults).join("\n");
      eq((everything.match(/wedding/gi) || []).length, 0, "🔴 'wedding' appears nowhere — corporate and social bookings are events");
      eq((everything.match(/reply to this email/gi) || []).length, 0, "🔴 no 'reply to this email' — the sender is unmonitored");
      eq((everything.match(/owner_name/g) || []).length, 0, "🔴 no owner_name — the signature is the sender");
      eq((everything.match(/do not reply/gi) || []).length, 0, "the old footer line is gone");
      for (const src of sources.filter((x) => /^\{\{var:venue_name\}\}/.test(x))) {
        ok(/Warm regards,\n\{\{var:sender_name\}\}\n\{\{var:venue_name\}\}\n\{\{var:sender_phone\}\}/.test(src), "text signature: Warm regards / sender / venue / sender phone");
        ok(/This is an automated email which cannot take replies\.\nFor any queries contact \{\{var:venue_name\}\} on \{\{var:venue_phone\}\}\./.test(src) && /Powered by Wedsy/.test(src), "text footer as settled, then Powered by Wedsy");
      }
      for (const spec of Object.values(VenueMail.KINDS)) {
        ok(/^\{\{var:venue_name\}\} — /.test(spec.subject({ venue_name: "{{var:venue_name}}" })), `${spec.slug}: subject starts "{{var:venue_name}} — " ("${spec.subject({ venue_name: "{{var:venue_name}}" })}")`);
      }
      // The window sentence: present with a window, a single day when only a day, DROPPED when nothing.
      const q = (lead) => VenueMail.defaultMessage("quote", { venue, lead });
      ok(/Please find your quote attached, for 30 Aug 2026, 4:00 PM to 31 Aug 2026, 4:00 PM\./.test(q(withWindow)), "🔴 quote: the window renders as '30 Aug 2026, 4:00 PM to 31 Aug 2026, 4:00 PM'");
      ok(/Please find your quote attached, for 30 Aug 2026\./.test(q({ eventDate: "2026-08-30T10:30:00Z" })), "🔴 only a day known → '30 Aug 2026', no invented times");
      ok(/Please find your quote attached\./.test(q({})) && !/ for /.test(q({}).split("\n")[2]), "🔴 no dates → the sentence carrying them is DROPPED, not blanked");
      const b = (lead) => VenueMail.defaultMessage("booking_confirmation", { venue, lead });
      ok(/confirm your booking for 30 Aug 2026, 4:00 PM to 31 Aug 2026, 4:00 PM\. Your booking confirmation is attached/.test(b(withWindow)), "booking: window inside the sentence");
      ok(/confirm your booking\. Your booking confirmation is attached/.test(b({})), "booking: no dates → 'confirm your booking.'");
      const st = (lead) => VenueMail.defaultMessage("statement", { venue, lead });
      ok(/attached, covering your booking for 30 Aug 2026/.test(st(withWindow)) && /attached\.\n/.test(st({})), "statement: 'covering your booking for …' only with dates");
      const r = VenueMail.defaultMessage("receipt", { venue, lead: withWindow, amount: 250000 });
      ok(/received your payment of ₹2,50,000 towards your booking with Crown Estate for your event on 30 Aug 2026/.test(r), `🔴 receipt: amount formatted in INR and the event date ("${r.split("\n")[0]}")`);
      ok(/received your payment towards your booking with Crown Estate\./.test(VenueMail.defaultMessage("receipt", { venue, lead: {} })), "receipt: no amount, no dates → both phrases dropped, sentence still whole");
      ok(!("receipt" in { terms: 1, quote: 1, booking_confirmation: 1, invoice: 1, statement: 1 }) && !require("../models/VenueLeadDocument").schema.path("kind").enumValues.includes("receipt"), "receipt has NO document kind yet — nothing can file or send one");
    }

    // ══ FIXTURE ══════════════════════════════════════════════════════════════
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG} Venue`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, role: "owner", isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: "P & A", couplePhone: `9${Date.now()}`.slice(0, 10), stage: "negotiating", contacts: [{ name: "P", email: "p@example.com", relation: "bride", isPrimary: true }] });
    created.leads.push(lead._id);
    const doc = await VenueLeadDocument.create({ venue: venue._id, enquiry: lead._id, kind: "invoice", version: 1, url: "https://bucket.test/inv.pdf", filename: "inv.pdf", sizeBytes: 10 });
    const req = (extra = {}) => ({ params: { slug: venue.slug, enquiryId: String(lead._id), documentId: String(doc._id), ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, name: "Owner" }, venueMember: null });
    const ENV = { MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s", MAILJET_TEMPLATE_VENUE_INVOICE: "1002" };
    const withEnv = async (patch, fn) => { const prev = {}; for (const k of Object.keys(patch)) { prev[k] = process.env[k]; process.env[k] = patch[k]; } try { return await fn(); } finally { for (const k of Object.keys(patch)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } } };

    // ══ C. NO FALLBACK BODY → A VERDICT, NEVER A 500, ALWAYS A ROW ═══════════
    console.log("\n[C. the compiled artefact is missing: the preview answers, the send records]");
    const artefact = path.join(VenueMail.COMPILED_DIR, "venue_invoice_sent.html");
    const hidden = `${artefact}.hidden-${TAG}`;
    fs.renameSync(artefact, hidden);
    try {
      await withEnv(ENV, async () => {
        const pv = await call(send.sendPreview, req());
        eq(pv.code, 200, "🔴 preview does NOT 500 with no template body");
        ok(/could not be rendered/.test(pv.body.renderError) && /venue_invoice_sent\.html/.test(pv.body.renderError), `…it names the missing artefact: "${pv.body.renderError}"`);
        eq(pv.body.html, "", "…html empty, not a throw");
        eq(pv.body.messageSupported, false, "…message region reported unsupported rather than guessed");
        eq(pv.body.recipients.length, 1, "…recipients still offered");
        const before = await VenueEmailSend.countDocuments({ enquiry: lead._id });
        let transportHit = 0;
        const NS = require("../services/NotificationService");
        const real = NS.sendEmail; NS.sendEmail = async () => { transportHit++; return {}; };
        let r;
        try { r = await call(send.sendDocument, req({ body: { email: "p@example.com" } })); } finally { NS.sendEmail = real; }
        eq(r.code, 201, "🔴 the send does NOT 500");
        eq(r.body.delivered, false, "…delivered false");
        ok(/could not be rendered/.test(r.body.deliveryError) && /recorded but not emailed/.test(r.body.deliveryError), `…verdict on the response: "${r.body.deliveryError}"`);
        eq(transportHit, 0, "…transport never called with nothing to send");
        const after = await VenueEmailSend.countDocuments({ enquiry: lead._id });
        eq(after, before + 1, "🔴 A ROW EXISTS — the record was inserted before the render could fail");
        const row = await VenueEmailSend.findOne({ enquiry: lead._id }).sort({ sentAt: -1 }).lean();
        ok(row.delivered === false && /could not be rendered/.test(row.deliveryError), "🔴 STORED: the verdict names the render failure");
        eq(row.renderedHtml, "", "STORED: no body, honestly");
        eq(row.to.email, "p@example.com", "STORED: the recipient, so the attempt is traceable");
        const l = await VenueEnquiry.findById(lead._id).lean();
        const last = l.activities[l.activities.length - 1];
        ok(last.type === "email_sent" && /recorded, not emailed/.test(last.description) && String(last.ref) === String(row._id), "…and the activity row points at it");
      });
    } finally {
      fs.renameSync(hidden, artefact);
    }

    // ══ D. WITH THE ARTEFACT BACK, THE SAME SEND RENDERS FROM IT ═════════════
    console.log("\n[D. the artefact restored: the fallback renders without a compiler]");
    await withEnv(ENV, async () => {
      const NS = require("../services/NotificationService");
      const real = NS.sendEmail; NS.sendEmail = async () => ({ body: { Messages: [{ Status: "success", To: [{ MessageID: 1 }] }] } });
      // The attachment fetch is faked through its module.
      const pdfStitch = require("../utils/pdfStitch"); const realFetch = pdfStitch.fetchSourcePdf; pdfStitch.fetchSourcePdf = async () => Buffer.from("%PDF-1.4 x");
      let r;
      try { r = await call(send.sendDocument, req({ body: { email: "p@example.com", message: "Hello" } })); } finally { NS.sendEmail = real; pdfStitch.fetchSourcePdf = realFetch; }
      eq(r.body.delivered, true, "delivered from the fake Mailjet");
      const row = await VenueEmailSend.findById(r.body.send._id).lean();
      eq(row.renderedFrom, "repo", "🔴 rendered from the compiled artefact");
      ok(/Hello/.test(row.renderedHtml) && /mj-column-per-100/.test(row.renderedHtml), "…the body is the compiled frame with the message in it");
    });
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueEmailSend.deleteMany({ enquiry: { $in: created.leads } });
      await VenueLeadDocument.deleteMany({ enquiry: { $in: created.leads } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    if (mongoose.connection.readyState) await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
