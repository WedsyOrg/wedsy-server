// TERMS EMAIL — the venue_terms_sent send, and the delivery verdict on the
// dispute record. Run:
//   DATABASE_URL=mongodb://127.0.0.1:27017/<testdb> node tests/venue-terms-mail.test.js
//
// THE CENTRAL FIX: `delivered` used to be set true the moment the transport
// was CALLED. With no template behind it that line never ran and nothing lied.
// With one, every transport failure would have written a false delivery onto
// the quote round. Every section here reads the STORED round, not the
// response, because the round is what a dispute reads.
//
// Runs without network: the transport is the module-level
// NotificationService.sendEmail, which VenueTermsMail looks up at call time,
// so each section swaps it for a fake that records the payload or throws.
// Section F opts into a REAL transport failure (bad credentials → Mailjet 401)
// when the network is there; it is the only section that touches the wire.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const NotificationService = require("../services/NotificationService");
const Mail = require("../services/VenueTermsMail");
const terms = require("../controllers/venueTerms");
const rounds = require("../controllers/venueQuoteRound");

const TAG = `tmail-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const created = { venues: [], owners: [], leads: [] };

// A Mailjet v3.1 success body, the shape verdictFromResponse reads.
const MJ_OK = { body: { Messages: [{ Status: "success", To: [{ Email: "x", MessageID: 1234567890, MessageUUID: "u" }] }] } };
const MJ_REFUSED = { body: { Messages: [{ Status: "error", Errors: [{ ErrorIdentifier: "e", ErrorCode: "mj-0013", StatusCode: 400, ErrorMessage: "\"partner_venue@wedsy.in\" is an invalid email address.", ErrorRelatedTo: ["From.Email"] }] }] } };

const realSendEmail = NotificationService.sendEmail;
const withTransport = async (fake, fn) => {
  NotificationService.sendEmail = fake;
  try { return await fn(); } finally { NotificationService.sendEmail = realSendEmail; }
};
const withEnv = async (patch, fn) => {
  const prev = {};
  for (const k of Object.keys(patch)) { prev[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(patch)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ A. EVERY EXISTING CALLER STILL PRODUCES THE SAME PAYLOAD ═════════════
    console.log("\n[A. sendEmail's old four-argument form is byte-identical after the extension]");
    await withEnv({ MAILJET_FROM_EMAIL: undefined, MAILJET_FROM_NAME: undefined }, async () => {
      // This literal is the message the pre-change sendEmail built. If the
      // extension changed it for auth.js / admin.js / send(), this fails.
      const before = {
        From: { Email: "notifications@wedsy.in", Name: "Wedsy" },
        To: [{ Email: "a@b.c", Name: "Asha" }],
        TemplateID: 6647480,
        TemplateLanguage: true,
        Variables: { otp: "123456" },
      };
      const now = NotificationService.buildEmailMessage("a@b.c", 6647480, { otp: "123456" }, "Asha");
      eq(JSON.stringify(now), JSON.stringify(before), "🔴 four-arg call → the exact pre-change message, no Attachments key, account From");
      const withEnvFrom = await withEnv({ MAILJET_FROM_EMAIL: "hello@wedsy.in", MAILJET_FROM_NAME: "Hello" }, () =>
        NotificationService.buildEmailMessage("a@b.c", 1, {}, ""));
      ok(withEnvFrom.From.Email === "hello@wedsy.in" && withEnvFrom.From.Name === "Hello", "…and the env-var From still wins for them");

      const ext = NotificationService.buildEmailMessage("a@b.c", 77, { v: 1 }, "Asha", {
        from: { Email: "partner_venue@wedsy.in", Name: "Crown Estate" },
        attachments: [{ filename: "t.pdf", contentType: "application/pdf", base64: "JVBERi0=" }],
      });
      eq(ext.From.Name, "Crown Estate", "🔴 a per-send From overrides the display name");
      eq(ext.From.Email, "partner_venue@wedsy.in", "…and the address");
      eq(ext.Attachments.length, 1, "🔴 attachments map onto Mailjet's Attachments[]");
      eq(ext.Attachments[0].Filename, "t.pdf", "…with the filename");
      eq(ext.Attachments[0].ContentType, "application/pdf", "…and content type");
      eq(ext.TemplateID, 77, "…alongside TemplateID — template sends carry attachments too");
      const partial = NotificationService.buildEmailMessage("a@b.c", 1, {}, "", { from: { Name: "Only Name" } });
      eq(partial.From.Email, "notifications@wedsy.in", "a Name-only override keeps the default address");
      ok(!("Attachments" in NotificationService.buildEmailMessage("a@b.c", 1, {}, "", { attachments: [] })), "an empty attachments list adds no key");
    });

    // ══ FIXTURE ══════════════════════════════════════════════════════════════
    const venue = await Venue.create({
      name: `${TAG} Crown Estate`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      logo: "https://example.com/crown.png",
      contact: { primaryName: "Reception", primaryPhone: "+91 98450 00000" },
      policyDoc: { policies: ["No fireworks after 10pm."], terms: ["Payment in three instalments."], refund: [] },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Meera Rao", phone: `${TAG}o`, role: "owner", isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", couplePhone: `9${Date.now()}`.slice(0, 10), stage: "negotiating",
      contacts: [{ name: "Priya", email: "priya@example.com", relation: "bride", isPrimary: true }],
    });
    created.leads.push(lead._id);
    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) }, query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
    });
    const storedRound = async () => VenueQuoteRound.findOne({ enquiry: lead._id }).sort({ termsSentAt: -1 }).lean();
    const ENV_OK = { MAILJET_TEMPLATE_VENUE_TERMS: "9999999", MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s" };

    // ══ B. NO TEMPLATE CONFIGURED — the honest failure, now naming the env var ══
    console.log("\n[B. no MAILJET_TEMPLATE_VENUE_TERMS → recorded, not emailed, transport never called]");
    let calls = 0;
    await withEnv({ MAILJET_TEMPLATE_VENUE_TERMS: undefined, MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s" }, () =>
      withTransport(async () => { calls++; return MJ_OK; }, async () => {
        const r = await call(terms.sendTerms, req({ body: { email: "priya@example.com" } }));
        eq(r.code, 200, "the send is RECORDED (200) — the record never depends on transport");
        eq(r.body.delivered, false, "🔴 delivered:false");
        ok(/template is configured/.test(r.body.deliveryError) && /MAILJET_TEMPLATE_VENUE_TERMS/.test(r.body.deliveryError), `…naming the env var: "${r.body.deliveryError}"`);
        eq(calls, 0, "transport was not called");
        const s = await storedRound();
        ok(s && s.termsSentAt && s.termsSentTo === "priya@example.com", "STORED: termsSentAt/termsSentTo written");
        eq(s.termsDelivered, false, "🔴 STORED: termsDelivered false");
        ok(/MAILJET_TEMPLATE_VENUE_TERMS/.test(s.termsDeliveryError), "🔴 STORED: the reason is on the round");
        const lr = await call(rounds.listRounds, req());
        const shaped = lr.body.rounds ? lr.body.rounds[0] : (lr.body[0] || lr.body.data && lr.body.data[0]);
        ok(shaped && shaped.termsDelivered === false && /MAILJET/.test(shaped.termsDeliveryError), "…and the thread API carries the verdict for the screen");
      }));

    // ══ C. SUCCESS — delivered from Mailjet's ANSWER, as the venue, PDF attached ══
    console.log("\n[C. Mailjet says success → delivered true; the payload is the venue's voice with the PDF]");
    let payload = null;
    await withEnv(ENV_OK, () =>
      withTransport(async (email, templateId, variables, name, opts) => { payload = { email, templateId, variables, name, opts }; return MJ_OK; }, async () => {
        const r = await call(terms.sendTerms, req({ body: { email: "priya@example.com" } }));
        eq(r.code, 200, "send recorded");
        eq(r.body.delivered, true, "🔴 delivered:true ONLY because the fake Mailjet answered success");
        eq(r.body.deliveryError, "", "no error");
        const s = await storedRound();
        eq(s.termsDelivered, true, "🔴 STORED: termsDelivered true");
        eq(s.termsMessageId, "1234567890", "🔴 STORED: Mailjet's MessageID, so a dispute can be traced to the wire");
        ok(s.termsDeliveredAt instanceof Date, "STORED: termsDeliveredAt");
        eq(payload.templateId, 9999999, "template ID came from the env var, not a map");
        eq(payload.opts.from.Name, venue.name, "🔴 From display name is THE VENUE");
        eq(payload.opts.from.Email, "partner_venue@wedsy.in", "🔴 From address is partner_venue@wedsy.in");
        eq(payload.variables.venue_name, venue.name, "var venue_name");
        eq(payload.variables.couple_name, "Priya & Arjun", "var couple_name");
        eq(payload.variables.owner_name, "Meera Rao", "🔴 var owner_name is the VenueOwner, not 'Wedsy'");
        eq(payload.variables.venue_phone, "+91 98450 00000", "var venue_phone from contact.primaryPhone");
        eq(payload.variables.venue_logo, "https://example.com/crown.png", "var venue_logo is the http URL");
        ok(!Object.values(payload.variables).some((v) => /wedsy/i.test(v)), "no variable carries 'Wedsy' — the voice is the venue's");
        const att = payload.opts.attachments[0];
        ok(att && att.contentType === "application/pdf", "🔴 a PDF is attached on the GENERATED path");
        ok(/^terms-.*\.pdf$/.test(att.filename), `…named ${att.filename}`);
        const bytes = Buffer.from(att.base64, "base64");
        ok(bytes.slice(0, 5).toString() === "%PDF-", "🔴 …and the bytes ARE a PDF");
        // pdfkit writes text as hex strings (<...> Tj); decode them to read it.
        const pdfText = (bytes.toString("latin1").match(/<([0-9a-fA-F]+)>/g) || []).map((h) => Buffer.from(h.replace(/[^0-9a-fA-F]/g, ""), "hex").toString("latin1")).join("");
        ok(/No\s*fireworks\s*after\s*10pm/.test(pdfText), "🔴 …containing the venue's actual clauses");
      }));

    // ══ C2. THE MASTHEAD — the venue's, identical across sends, never Wedsy ═══
    console.log("\n[C2. masthead: Venue.logo → image, else the venue's NAME; the same for every send; never the Wedsy logo]");
    {
      const fs = require("fs");
      const html = fs.readFileSync(require("path").join(__dirname, "..", "emails", "venue_terms_sent.html"), "utf8");
      const text = fs.readFileSync(require("path").join(__dirname, "..", "emails", "venue_terms_sent.txt"), "utf8");
      const imgs = html.match(/<img[^>]*>/g) || [];
      eq(imgs.length, 1, "🔴 the template carries exactly ONE image");
      ok(/src="\{\{var:venue_logo\}\}"/.test(imgs[0]), "🔴 …and its src is {{var:venue_logo}} — the venue's, never a fixed asset");
      ok(!/mjt\.lu|wedsy\.in\/|wedsy.*\.(png|jpg|svg)/i.test(html), "🔴 no Wedsy-hosted or Wedsy-named asset anywhere in the HTML");
      const wedsyMentions = (html.match(/wedsy/gi) || []).length;
      ok(wedsyMentions === 1 && /POWERED BY WEDSY/.test(html), `'Wedsy' appears exactly once in the HTML, as 'Powered by Wedsy' in the footer (${wedsyMentions})`);
      ok(/\{% if var:venue_logo %\}[\s\S]*<img[\s\S]*\{% else %\}[\s\S]*\{\{var:venue_name\}\}[\s\S]*\{% endif %\}/.test(html), "🔴 the image is inside {% if var:venue_logo %}, with the venue NAME in the else branch");
      ok(html.indexOf("{% endif %}") < html.indexOf("Dear {{var:couple_name}}"), "…and that conditional IS the masthead — it sits above the greeting");
      ok(!/<img/.test(text) && text.trim().startsWith("{{var:venue_name}}"), "the text part's masthead is the venue name, flattened");

      // Same venue, two sends that differ ONLY in From: the masthead input is identical.
      const seen = [];
      const fake = async (email, templateId, variables, name, opts) => { seen.push({ logo: variables.venue_logo, from: opts.from.Name }); return MJ_OK; };
      await withEnv(ENV_OK, async () => {
        await Mail.sendVenueTermsEmail({ venue: venue.toObject(), lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.from("%PDF-1.4 x") }, transport: fake });
        await Mail.sendVenueTermsEmail({ venue: { ...venue.toObject(), name: "A Different Display Name" }, lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.from("%PDF-1.4 x") }, transport: fake });
      });
      ok(seen[0].from !== seen[1].from, `two sends, two From names (${seen[0].from} / ${seen[1].from})`);
      ok(seen[0].logo === seen[1].logo && seen[0].logo === venue.logo, "🔴 …and the SAME masthead input: venue_logo is Venue.logo on both, untouched by From");

      // Both fallback states, from stored fixtures.
      const withLogo = await Venue.create({ name: `${TAG} Logo Venue`, slug: `${TAG}-logo`, logo: "https://cdn.example.com/venues/logo-venue.jpg" });
      const noLogo = await Venue.create({ name: `${TAG} Plain Venue`, slug: `${TAG}-plain` });
      created.venues.push(withLogo._id, noLogo._id);
      const vars = [];
      const capture = async (e, t, variables) => { vars.push(variables); return MJ_OK; };
      await withEnv(ENV_OK, async () => {
        await Mail.sendVenueTermsEmail({ venue: (await Venue.findById(withLogo._id).lean()), lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.from("%PDF-1.4 x") }, transport: capture });
        await Mail.sendVenueTermsEmail({ venue: (await Venue.findById(noLogo._id).lean()), lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.from("%PDF-1.4 x") }, transport: capture });
      });
      eq(vars[0].venue_logo, "https://cdn.example.com/venues/logo-venue.jpg", "🔴 a venue WITH a logo → venue_logo is that URL → the if-branch renders the image");
      eq(vars[1].venue_logo, "", "🔴 a venue WITHOUT a logo → venue_logo is '' → the else-branch renders the venue's name as text");
      eq(vars[1].venue_name, noLogo.name, "…and that name is the venue's");
      ok(!vars.some((v) => /mjt\.lu|wedsy/i.test(v.venue_logo)), "🔴 neither send carries a Wedsy image as the logo");
    }

    // ══ D. MAILJET REFUSES IN-BAND (200 with Status:error) ═══════════════════
    console.log("\n[D. Mailjet answers Status:error → not delivered, its reason on the record]");
    await withEnv(ENV_OK, () =>
      withTransport(async () => MJ_REFUSED, async () => {
        const r = await call(terms.sendTerms, req({ body: { email: "priya@example.com" } }));
        eq(r.body.delivered, false, "🔴 delivered:false even though the HTTP call succeeded");
        ok(/Mailjet refused/.test(r.body.deliveryError) && /From\.Email/.test(r.body.deliveryError), `…with Mailjet's own reason: "${r.body.deliveryError}"`);
        const s = await storedRound();
        ok(s.termsDelivered === false && /Mailjet refused/.test(s.termsDeliveryError), "🔴 STORED: not delivered, reason kept");
        eq(s.termsMessageId, "", "STORED: no message id for a refused send");
      }));

    // ══ E. TRANSPORT THROWS ══════════════════════════════════════════════════
    console.log("\n[E. transport throws → not delivered, the error in deliveryError, record intact]");
    await withEnv(ENV_OK, () =>
      withTransport(async () => { const e = new Error("Unauthorized"); e.statusCode = 401; e.response = { body: { ErrorMessage: "API key authentication/authorization failure." } }; throw e; }, async () => {
        const r = await call(terms.sendTerms, req({ body: { email: "priya@example.com" } }));
        eq(r.code, 200, "the RECORD still succeeds — losing it because Mailjet was down is the worst trade");
        eq(r.body.delivered, false, "🔴 delivered:false");
        ok(/HTTP 401/.test(r.body.deliveryError) && /authentication/.test(r.body.deliveryError), `…reason names the failure: "${r.body.deliveryError}"`);
        const s = await storedRound();
        ok(s.termsDelivered === false && /HTTP 401/.test(s.termsDeliveryError), "🔴 STORED: the transport failure is on the dispute record");
        const l = await VenueEnquiry.findById(lead._id).select("activities").lean();
        const last = l.activities[l.activities.length - 1];
        ok(last.type === "terms_sent" && /recorded, not emailed/.test(last.description), `activity says so too: "${last.description}"`);
      }));

    // ══ F. THE OVERSIZE PDF — a real fixture, refused before any transport ═══
    console.log("\n[F. an attachment that cannot fit Mailjet's 15 MB message refuses BEFORE sending]");
    {
      const limit = NotificationService.MAILJET_MESSAGE_LIMIT_BYTES;
      eq(limit, 15 * 1024 * 1024, "the limit constant is Mailjet's 15 MB");
      // 11.5 MB on disk is UNDER the 15 MB limit — and 15.3 MB once base64'd,
      // which is what the wire carries. The guard has to reason in encoded bytes.
      const big = Buffer.alloc(Math.floor(11.5 * 1024 * 1024), 0x41);
      big.write("%PDF-1.4");
      const v = Mail.attachmentVerdict(big, "Scanned-Terms.pdf");
      eq(v.ok, false, "🔴 11.5 MB raw → refused (15.3 MB encoded + body > 15 MB)");
      ok(/11\.5 MB/.test(v.reason) && /15\.3 MB/.test(v.reason) && /15\.0 MB/.test(v.reason), `…the reason names all three sizes: "${v.reason}"`);
      ok(/recorded but not emailed/.test(v.reason), "…and reads like the missing-template case");
      const fine = Buffer.alloc(900000, 0x41); // Crown Estate's real PDF size
      eq(Mail.attachmentVerdict(fine, "Crown-TCs.pdf").ok, true, "a 0.9 MB PDF (the real one on record) is fine");
      const ten = Buffer.alloc(10 * 1024 * 1024, 0x41); // the upload cap
      eq(Mail.attachmentVerdict(ten, "max.pdf").ok, true, "a PDF at the 10 MB upload cap still fits (13.3 MB encoded)");

      let hit = 0;
      const verdict = await withEnv(ENV_OK, () =>
        Mail.sendVenueTermsEmail({ venue: venue.toObject(), lead, email: "priya@example.com", attachment: { filename: "Scanned-Terms.pdf", buffer: big }, transport: async () => { hit++; return MJ_OK; } }));
      eq(verdict.delivered, false, "🔴 sendVenueTermsEmail refuses the oversize attachment");
      eq(hit, 0, "🔴 …and the transport was NEVER called — no stripped email, no link fallback");
      const round = await VenueQuoteRound.findOne({ enquiry: lead._id }).sort({ termsSentAt: -1 });
      Mail.recordDelivery(round, verdict);
      await round.save();
      const s = await storedRound();
      ok(s.termsDelivered === false && /11\.5 MB/.test(s.termsDeliveryError), "🔴 STORED: undelivered with the size in the reason");
    }

    // ══ G. NEVER AN EMAIL WITH NOTHING ATTACHED ══════════════════════════════
    console.log("\n[G. no attachment bytes → refuses; the body says 'attached' and must not lie]");
    {
      let hit = 0;
      const v = await withEnv(ENV_OK, () => Mail.sendVenueTermsEmail({ venue: venue.toObject(), lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.alloc(0) }, transport: async () => { hit++; return MJ_OK; } }));
      ok(v.delivered === false && hit === 0 && /could not be prepared/.test(v.deliveryError), "🔴 empty attachment → not sent, transport untouched");
      const lazyFail = await withEnv(ENV_OK, () => Mail.sendVenueTermsEmail({ venue: venue.toObject(), lead, email: "p@x.y", attachment: async () => { throw new Error("Could not fetch the terms document: 503"); }, transport: async () => { hit++; return MJ_OK; } }));
      ok(lazyFail.delivered === false && hit === 0 && /Could not fetch/.test(lazyFail.deliveryError), `a storage failure while fetching the PDF is a VERDICT, not a 500: "${lazyFail.deliveryError}"`);
      let prepared = 0;
      const notConfigured = await withEnv({ MAILJET_TEMPLATE_VENUE_TERMS: undefined }, () => Mail.sendVenueTermsEmail({ venue: venue.toObject(), lead, email: "p@x.y", attachment: async () => { prepared++; return { filename: "t.pdf", buffer: Buffer.from("%PDF-") }; } }));
      ok(notConfigured.delivered === false && prepared === 0, "…and with no template configured the PDF is never even fetched");
    }

    // ══ H. OWNER NAME FALLBACKS ══════════════════════════════════════════════
    console.log("\n[H. owner_name: VenueOwner → contact.primaryName → venue name; never blank, never Wedsy]");
    {
      const v2 = await Venue.create({ name: `${TAG} No Owner`, slug: `${TAG}-v2`, contact: { primaryName: "Front Desk" } });
      created.venues.push(v2._id);
      eq(await Mail.resolveOwnerName(v2.toObject()), "Front Desk", "no VenueOwner → contact.primaryName");
      const v3 = await Venue.create({ name: `${TAG} Bare`, slug: `${TAG}-v3` });
      created.venues.push(v3._id);
      eq(await Mail.resolveOwnerName(v3.toObject()), v3.name, "nothing at all → the venue's name");
      const noLogo = await withEnv(ENV_OK, () => Mail.sendVenueTermsEmail({ venue: { ...v3.toObject(), logo: "data:image/png;base64,AAAA" }, lead, email: "p@x.y", attachment: { filename: "t.pdf", buffer: Buffer.from("%PDF-1.4 x") }, transport: async (e, t, vars) => { payload = vars; return MJ_OK; } }));
      ok(noLogo.delivered && payload.venue_logo === "", "a data: URI logo is sent as EMPTY, so the template falls back to the name in text");
    }

    // ══ I. REAL TRANSPORT FAILURE (network) ══════════════════════════════════
    console.log("\n[I. the REAL transport with bad credentials — Mailjet's actual 401 on the record]");
    await withEnv({ MAILJET_TEMPLATE_VENUE_TERMS: "9999999", MAILJET_API_KEY: "not-a-key", MAILJET_SECRET_KEY: "not-a-secret" }, async () => {
      const r = await call(terms.sendTerms, req({ body: { email: "priya@example.com" } }));
      eq(r.body.delivered, false, "🔴 delivered:false from the real client");
      ok(/Email transport failed/.test(r.body.deliveryError), `…with the real reason: "${r.body.deliveryError}"`);
      const s = await storedRound();
      ok(s.termsDelivered === false && s.termsDeliveryError === r.body.deliveryError, "🔴 STORED = what the owner was shown");
    });
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    NotificationService.sendEmail = realSendEmail;
    try {
      await VenueQuoteRound.deleteMany({ enquiry: { $in: created.leads } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
