// BUILD A — Send to client. Run:
//   DATABASE_URL=mongodb://127.0.0.1:27017/<testdb> node tests/venue-document-send.test.js
//
// Every claim is read off the STORED VenueEmailSend row / VenueLeadDocument /
// lead, not the response. No network: the transport is swapped for a fake
// that records the payload, and VENUE_MAIL_RENDER=repo keeps template
// rendering off Mailjet. Section G proves the record does not change when the
// template does.
require("dotenv").config();
process.env.VENUE_MAIL_RENDER = "repo";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueQuote = require("../models/VenueQuote");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueEmailSend = require("../models/VenueEmailSend");
const NotificationService = require("../services/NotificationService");
const VenueMail = require("../services/VenueMail");
const VenueTermsMail = require("../services/VenueTermsMail");
const { recipientOptions, isOnLead } = require("../utils/venueRecipients");
const { renderTemplate, messageToHtml } = require("../utils/mailjetTemplateRender");
const send = require("../controllers/venueDocumentSend");
const rounds = require("../controllers/venueQuoteRound");
const s3 = require("../utils/s3Upload");

const TAG = `stc-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const created = { venues: [], owners: [], leads: [] };

const MJ_OK = (id = 777) => ({ body: { Messages: [{ Status: "success", To: [{ Email: "x", MessageID: id }] }] } });
const realSendEmail = NotificationService.sendEmail;
const withTransport = async (fake, fn) => { NotificationService.sendEmail = fake; try { return await fn(); } finally { NotificationService.sendEmail = realSendEmail; } };
const withEnv = async (patch, fn) => {
  const prev = {};
  for (const k of Object.keys(patch)) { prev[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(patch)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};
const ENV_OK = { MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s", MAILJET_TEMPLATE_VENUE_QUOTE: "1001", MAILJET_TEMPLATE_VENUE_INVOICE: "1002", MAILJET_TEMPLATE_VENUE_STATEMENT: "1003", MAILJET_TEMPLATE_VENUE_BOOKING_CONFIRMED: "1004", MAILJET_TEMPLATE_VENUE_TERMS: "1005" };

// S3 is not on the table: the upload is faked to a URL and the fetch is
// faked to bytes, both recorded.
const realUpload = s3.uploadBufferToS3;
const uploads = [];
s3.uploadBufferToS3 = async ({ buffer, key }) => { uploads.push({ key, bytes: buffer.length }); return `https://bucket.test/${key}`; };
const pdfStitch = require("../utils/pdfStitch");
const realFetch = pdfStitch.fetchSourcePdf;
const fetched = [];
pdfStitch.fetchSourcePdf = async (url) => { fetched.push(url); return Buffer.from(`%PDF-1.4 fake bytes for ${url}`); };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ A. THE PRESELECT RULE — all four branches, real fixtures ═════════════
    console.log("\n[A. who is preselected: decision maker → primary → first with email → nobody]");
    const mk = (contacts) => ({ contacts: contacts.map((c, i) => ({ _id: new mongoose.Types.ObjectId(), relation: "other", ...c })) });
    let r = recipientOptions(mk([{ name: "Bride", email: "bride@x.y", isPrimary: true }, { name: "Father", email: "father@x.y", isDecisionMaker: true }]));
    eq(r.preselected, "father@x.y", "🔴 the DECISION MAKER is preselected over the primary");
    eq(r.reason, "decision_maker", "…and says why");
    eq(r.recipients.filter((c) => c.preselected).length, 1, "exactly one preselected");
    r = recipientOptions(mk([{ name: "Bride", email: "bride@x.y", isPrimary: true }, { name: "Groom", email: "groom@x.y" }]));
    eq(r.preselected, "bride@x.y", "🔴 ZERO decision makers → the primary");
    eq(r.reason, "primary", "…reason primary");
    r = recipientOptions(mk([{ name: "Uncle", phone: "9", isPrimary: true }, { name: "Aunt", email: "aunt@x.y" }]));
    eq(r.preselected, "aunt@x.y", "🔴 primary has no email → the first WITH an email");
    eq(r.reason, "first_with_email", "…reason first_with_email");
    r = recipientOptions(mk([{ name: "Uncle", phone: "9", isPrimary: true }]));
    eq(r.preselected, "", "🔴 nobody has an email → nothing preselected (the screen focuses free entry)");
    eq(r.reason, "none", "…reason none");
    r = recipientOptions(mk([{ name: "Bride", email: "bride@x.y", isPrimary: true }, { name: "Father", email: "father@x.y", isDecisionMaker: true }, { name: "Mother", email: "mother@x.y", isDecisionMaker: true }]));
    eq(r.preselected, "father@x.y", "🔴 TWO decision makers → the first preselected");
    eq(r.recipients.filter((c) => c.isDecisionMaker).length, 2, "…and the second is still listed, marked as deciding");
    r = recipientOptions(mk([{ name: "Father", email: "notanemail", isDecisionMaker: true }, { name: "Bride", email: "bride@x.y", isPrimary: true }]));
    eq(r.preselected, "bride@x.y", "a decision maker with a malformed email is skipped, not preselected");
    ok(isOnLead(mk([{ email: "A@X.Y" }]), "a@x.y") && !isOnLead(mk([{ email: "a@x.y" }]), "b@x.y"), "isOnLead is case-insensitive");

    // ══ B. THE RENDERER ══════════════════════════════════════════════════════
    console.log("\n[B. the local renderer matches Mailjet's syntax for what the templates use]");
    eq(renderTemplate("Hi {{var:name}}!", { name: "Priya" }), "Hi Priya!", "{{var:x}}");
    eq(renderTemplate("{{var:missing}}|{{var:d:\"dflt\"}}", {}), "|dflt", "missing → empty; default honoured");
    eq(renderTemplate("{% if var:logo %}IMG{% else %}NAME{% endif %}", { logo: "" }), "NAME", "empty string is false");
    eq(renderTemplate("{% if var:logo %}IMG{% else %}NAME{% endif %}", { logo: "https://x/y.png" }), "IMG", "non-empty is true");
    eq(messageToHtml("Line one\nLine two\n\nPara two <b>"), '<p class="text-build-content" style="margin: 10px 0;">Line one<br>Line two</p><p class="text-build-content" style="margin: 10px 0;">Para two &lt;b&gt;</p>', "🔴 the owner's message is escaped and paragraphed — it cannot break the frame");

    // ══ FIXTURE ══════════════════════════════════════════════════════════════
    const venue = await Venue.create({ name: `${TAG} Crown Estate`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka", contact: { primaryName: "Reception", primaryPhone: "+91 98450 00000" }, spaces: [{ name: "Lawn" }] });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Meera Rao", phone: `${TAG}o`, role: "owner", isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", couplePhone: `9${Date.now()}`.slice(0, 10), stage: "negotiating",
      contacts: [
        { name: "Priya", email: "priya@example.com", relation: "bride", isPrimary: true },
        { name: "Mr Rao", email: "rao@example.com", relation: "other", isDecisionMaker: true },
      ],
    });
    created.leads.push(lead._id);
    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, name: "Meera Rao" }, venueMember: null,
    });

    // ══ C. QUOTE — filed as a document, quoteRound written ═══════════════════
    console.log("\n[C. the quote gets a stored artefact, linked to its round]");
    r = await call(send.storeQuoteDocument, req());
    eq(r.code, 400, "no quote yet → 400");
    eq(r.body.code, "no_quote", "…with a code");
    const quote = await VenueQuote.create({ venue: venue._id, enquiry: lead._id, version: 1, lineItems: [{ label: "Lawn hire", qty: 1, unitPrice: 450000 }], totals: { subtotal: 450000, taxable: 450000, gst: 81000, grandTotal: 531000 }, status: "sent" });
    const round = await VenueQuoteRound.create({ venue: venue._id, enquiry: lead._id, roundNumber: 1, amount: 531000, reasoning: "first quote", outcome: "pending", sentAt: new Date(), sentVia: "call", quoteRef: quote._id });
    r = await call(send.storeQuoteDocument, req());
    eq(r.code, 201, "quote filed");
    const qdoc = await VenueLeadDocument.findById(r.body.documentId).lean();
    eq(qdoc.kind, "quote", "🔴 STORED: kind quote");
    ok(/^https:\/\/bucket\.test\/venues\/.*\/quotes\/.*\.pdf$/.test(qdoc.url), "STORED: a url under venues/{id}/quotes/");
    ok(uploads[uploads.length - 1].bytes > 1000, "…and real PDF bytes were uploaded");
    eq(String(qdoc.quoteRound), String(round._id), "🔴 STORED: quoteRound is WRITTEN — the round whose quoteRef is this quote");
    ok(/^quote-Priya-Arjun-v1\.pdf$/.test(qdoc.filename), `filename ${qdoc.filename}`);
    let l = await VenueEnquiry.findById(lead._id).lean();
    let last = l.activities[l.activities.length - 1];
    ok(last.type === "document_generated" && String(last.ref) === String(qdoc._id) && last.refModel === "VenueLeadDocument", "🔴 activity row points at the document via ref/refModel");
    r = await call(send.quoteOptions, req());
    eq(r.body.quotes.length, 1, "quote options lists the lead's quotes");

    // ══ D. SEND PREVIEW ══════════════════════════════════════════════════════
    console.log("\n[D. the preview: decision maker preselected, default copy, the email as it will go]");
    await withEnv(ENV_OK, async () => {
      r = await call(send.sendPreview, req({ params: { documentId: String(qdoc._id) } }));
      eq(r.code, 200, "preview answers");
      eq(r.body.preselected, "rao@example.com", "🔴 the decision maker (not the primary) is preselected");
      eq(r.body.recipients.length, 2, "both email-bearing contacts listed");
      ok(/Thank you for considering/.test(r.body.defaultMessage), "the default copy is the quote's");
      ok(!/quote-Priya-Arjun-v1\.pdf|Attached:/.test(r.body.html), "🔴 the internal filename stays out of the email — the mail client shows the attachment");
      ok(new RegExp(venue.name).test(r.body.html) && /Meera Rao/.test(r.body.html), "…carries the venue name and the owner's signature");
      ok(!/Team Wedsy|help@wedsy\.in/.test(r.body.html) && /POWERED BY WEDSY/.test(r.body.html), "🔴 venue voice: no Team Wedsy, no help@, Powered by Wedsy only");
      eq(r.body.messageSupported, true, "the template carries the message region");
      ok(/Dear Mr Rao,/.test((await call(send.sendPreview, req({ params: { documentId: String(qdoc._id) }, query: { to: "rao@example.com" } }))).body.html), "preview ?to= a contact → greeting is that contact");
      ok(/Dear Kavya,/.test((await call(send.sendPreview, req({ params: { documentId: String(qdoc._id) }, query: { to: "new@x.y", toName: "Kavya" } }))).body.html), "preview ?to= a typed address with a name → greeting is that name");
      ok(/Dear Priya & Arjun,/.test((await call(send.sendPreview, req({ params: { documentId: String(qdoc._id) }, query: { to: "new@x.y" } }))).body.html), "…a typed address with no name → the couple");
      eq(r.body.from.name, venue.name, "From display name is the venue");
      const custom = await call(send.sendPreview, req({ params: { documentId: String(qdoc._id) }, query: { message: "Hello <script>alert(1)</script>\n\nSecond para" } }));
      ok(/Hello &lt;script&gt;/.test(custom.body.html) && !/<script>/.test(custom.body.html), "🔴 a typed message is escaped into the frame");
      ok(/Second para/.test(custom.body.html), "…paragraphs kept");
    });

    // ══ E. THE SEND — the stored record IS the email ═════════════════════════
    console.log("\n[E. send: one row per send, rendered body stored, verdict from Mailjet's answer]");
    let payload = null;
    await withEnv(ENV_OK, () =>
      withTransport(async (email, templateId, variables, name, opts) => { payload = { email, templateId, variables, name, opts }; return MJ_OK(424242); }, async () => {
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "rao@example.com", message: "Dear Mr Rao, here is our quote.\nCall me anytime." } }));
        eq(r.code, 201, "sent");
        eq(r.body.delivered, true, "delivered because the fake Mailjet said success");
        const s = await VenueEmailSend.findById(r.body.send._id).lean();
        ok(s, "🔴 STORED: a VenueEmailSend row exists");
        eq(String(s.document), String(qdoc._id), "STORED: document id");
        eq(s.documentKind, "quote", "STORED: kind");
        eq(s.documentVersion, 1, "STORED: version");
        eq(s.to.email, "rao@example.com", "STORED: recipient");
        eq(s.to.name, "Mr Rao", "STORED: recipient name resolved from the contact");
        eq(s.from.name, venue.name, "🔴 STORED: sender display name is the venue");
        eq(s.from.email, "partner_venue@wedsy.in", "STORED: sender address");
        ok(new RegExp(`^${venue.name} — quote for your event$`).test(s.subject), `STORED: subject "${s.subject}" — the {{venue}} — <thing> pattern`);
        eq(s.variables.sender_name, "Meera Rao", "🔴 the signature is the SENDER (the owner row this actor resolves to)");
        eq(s.variables.sender_phone, owner.phone, "…with the sender's OTP phone");
        ok(!("owner_name" in s.variables), "🔴 owner_name is gone from the wire — the live templates no longer reference it");
        eq(s.message, "Dear Mr Rao, here is our quote.\nCall me anytime.", "STORED: the owner's words");
        ok(/Dear Mr Rao, here is our quote\.<br>Call me anytime\./.test(s.renderedHtml), "🔴 STORED: the rendered HTML carries the message inside the frame");
        ok(/Dear Mr Rao,/.test(s.renderedText) && /Dear Mr Rao, here is our quote\./.test(s.renderedText), "STORED: the text part too");
        ok(/Dear Mr Rao,<\/p>/.test(s.renderedHtml) && !/Dear Priya & Arjun/.test(s.renderedHtml), "🔴 the greeting addresses the RECIPIENT (Mr Rao), not the couple — found by driving");
        eq(s.variables.couple_full_name, "Priya & Arjun", "…the couple's name is still a variable of its own");
        eq(s.renderedFrom, "repo", "STORED: where the body was rendered from");
        eq(s.templateId, 1001, "STORED: the template id from the env var");
        eq(s.attachment.filename, "quote-Priya-Arjun-v1.pdf", "STORED: attachment filename");
        eq(s.attachment.url, qdoc.url, "STORED: attachment url");
        eq(s.delivered, true, "🔴 STORED: delivered");
        eq(s.messageId, "424242", "🔴 STORED: Mailjet's MessageID");
        ok(s.deliveredAt instanceof Date && s.sentAt instanceof Date, "STORED: timestamps");
        eq(s.triggeredByName, "Meera Rao", "STORED: who pressed send");
        eq(String(s.triggeredBy), String(owner._id), "…and their id");
        // What went over the wire matches the record.
        eq(payload.email, "rao@example.com", "wire: to");
        eq(payload.templateId, 1001, "wire: template");
        eq(payload.opts.from.Name, venue.name, "🔴 wire: From display name is the venue");
        eq(payload.variables.message_html, s.variables.message_html, "🔴 wire variables === stored variables (what Mailjet rendered is what we rendered)");
        eq(payload.opts.attachments[0].filename, "quote-Priya-Arjun-v1.pdf", "wire: attachment");
        ok(Buffer.from(payload.opts.attachments[0].base64, "base64").toString().startsWith("%PDF-1.4 fake bytes for https://bucket.test/"), "🔴 wire: the attachment is the STORED file, fetched at send time");
        eq(fetched[fetched.length - 1], qdoc.url, "…from the document's url");
        l = await VenueEnquiry.findById(lead._id).lean();
        last = l.activities[l.activities.length - 1];
        ok(last.type === "email_sent" && String(last.ref) === String(s._id) && last.refModel === "VenueEmailSend", "🔴 activity row 'email_sent' points at the send record");
        ok(/Quote v1 emailed to rao@example\.com$/.test(last.description), `…"${last.description}"`);
        // Immutable.
        const doc = await VenueEmailSend.findById(s._id);
        doc.message = "tampered";
        let threw = false; try { await doc.save(); } catch (e) { threw = true; }
        ok(threw, "🔴 the record is immutable once written");
      }));

    // ══ F. TWO SENDS, TWO ROWS — and the failure verdicts ════════════════════
    console.log("\n[F. every send is its own row; refusals are recorded, never claimed]");
    await withEnv(ENV_OK, () =>
      withTransport(async () => { const e = new Error("Unauthorized"); e.statusCode = 401; throw e; }, async () => {
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "priya@example.com" } }));
        eq(r.body.delivered, false, "transport threw → not delivered");
        const rows = await VenueEmailSend.find({ enquiry: lead._id }).sort({ sentAt: 1 }).lean();
        eq(rows.length, 2, "🔴 two sends → TWO rows; the first is untouched");
        eq(rows[0].delivered, true, "…first still delivered");
        ok(rows[1].delivered === false && /HTTP 401/.test(rows[1].deliveryError), `…second records the failure: "${rows[1].deliveryError}"`);
        ok(rows[1].message.startsWith("Thank you for considering"), "an empty message falls back to the default copy, and the DEFAULT is what is stored");
        eq(rows[1].to.name, "Priya", "recipient name from the contact");
      }));
    await withEnv({ ...ENV_OK, MAILJET_TEMPLATE_VENUE_QUOTE: undefined }, () =>
      withTransport(async () => { throw new Error("must not be called"); }, async () => {
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "priya@example.com" } }));
        ok(r.body.delivered === false && /MAILJET_TEMPLATE_VENUE_QUOTE/.test(r.body.deliveryError), "🔴 no template for this KIND → recorded, not emailed, names the env var");
        eq(fetched.length, 2, "…and the PDF was not fetched from storage");
      }));
    {
      let hit = 0;
      const big = Buffer.alloc(Math.floor(11.5 * 1024 * 1024), 0x41);
      const v = await withEnv(ENV_OK, async () => VenueMail.sendDocumentEmail({ venue: venue.toObject(), lead: await VenueEnquiry.findById(lead._id), kind: "quote", document: qdoc, email: "p@x.y", attachment: { filename: "big.pdf", buffer: big }, actor: { id: owner._id, name: "Meera" }, transport: async () => { hit++; return MJ_OK(); } }));
      ok(v.verdict.delivered === false && hit === 0 && /11\.5 MB/.test(v.verdict.deliveryError), "🔴 oversize PDF refused before transport, size named");
      const s = await VenueEmailSend.findById(v.send._id).lean();
      ok(s.delivered === false && /11\.5 MB/.test(s.deliveryError), "…and STORED as such");
    }

    // ══ G. THE RECORD OUTLIVES THE TEMPLATE ══════════════════════════════════
    console.log("\n[G. changing the template afterwards does not change what a past email said]");
    {
      const first = await VenueEmailSend.findOne({ enquiry: lead._id, delivered: true }).lean();
      const before = first.renderedHtml;
      // The runtime fallback body is the COMPILED artefact (the compiler is not
      // on the request path); editing it is what "the template changed" means here.
      const tplPath = path.join(__dirname, "..", "emails", "compiled", "venue_quote_sent.html");
      const original = fs.readFileSync(tplPath, "utf8");
      try {
        fs.writeFileSync(tplPath, original.replace("Dear {{var:couple_name}},", "Namaste {{var:couple_name}},"));
        const fresh = await withEnv(ENV_OK, () => VenueMail.renderPreview({ venue: venue.toObject(), lead, kind: "quote", message: "x", document: qdoc }));
        ok(/Namaste Priya/.test(fresh.html), "the template changed: a NEW render says Namaste");
        const again = await VenueEmailSend.findById(first._id).lean();
        eq(again.renderedHtml, before, "🔴 …and the stored email still says exactly what it said");
        ok(/Dear Mr Rao/.test(again.renderedHtml), "…Dear, not Namaste");
      } finally { fs.writeFileSync(tplPath, original); }
    }

    // ══ H. FREE-ENTRY ADDRESS → ADDED AS A CONTACT ═══════════════════════════
    console.log("\n[H. a typed address not on the lead is added as a contact when asked]");
    await withEnv(ENV_OK, () =>
      withTransport(async () => MJ_OK(1), async () => {
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "planner@agency.in", name: "Kavya", addContact: { name: "Kavya" } } }));
        eq(r.code, 201, "sent to the new address");
        eq(r.body.contactAdded, true, "…reported as added");
        l = await VenueEnquiry.findById(lead._id).lean();
        const kav = l.contacts.find((c) => c.email === "planner@agency.in");
        ok(kav && kav.name === "Kavya" && kav.relation === "other" && !kav.isPrimary && !kav.isDecisionMaker, "🔴 STORED: the contact exists, not primary, not deciding");
        eq(l.contacts.filter((c) => c.isPrimary).length, 1, "…and the one-primary invariant held");
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "planner@agency.in", addContact: { name: "Kavya" } } }));
        eq(r.body.contactAdded, false, "sending again to the same address does not duplicate the contact");
        eq((await VenueEnquiry.findById(lead._id).lean()).contacts.length, 3, "…three contacts, not four");
        r = await call(send.sendDocument, req({ params: { documentId: String(qdoc._id) }, body: { email: "not-an-email" } }));
        eq(r.code, 400, "a malformed address is refused");
      }));

    // ══ I. THE EMAILS LIST AND THE RECEIPT ═══════════════════════════════════
    console.log("\n[I. Emails sent: newest first, verdict per row; the detail carries the body as sent]");
    r = await call(send.listEmails, req());
    eq(r.code, 200, "list answers");
    ok(r.body.emails.length >= 5, `${r.body.emails.length} rows`);
    ok(r.body.emails.every((e, i, a) => i === 0 || new Date(a[i - 1].sentAt) >= new Date(e.sentAt)), "newest first");
    ok(r.body.emails.every((e) => e.documentLabel === "Quote" && typeof e.delivered === "boolean"), "each row: document label + verdict");
    ok(!("renderedHtml" in r.body.emails[0]), "the list does not carry bodies");
    const firstId = r.body.emails[r.body.emails.length - 1]._id;
    r = await call(send.getEmail, req({ params: { sendId: String(firstId) } }));
    eq(r.code, 200, "detail answers");
    ok(/Dear Mr Rao, here is our quote/.test(r.body.email.renderedHtml), "🔴 the detail is the email exactly as sent");
    ok(r.body.email.attachment.hasFile && r.body.email.attachment.filename === "quote-Priya-Arjun-v1.pdf", "…with its attachment reference");
    r = await call(send.getEmail, req({ params: { sendId: String(new mongoose.Types.ObjectId()) } }));
    eq(r.code, 404, "unknown send → 404");

    // ══ J. TERMS GOES THROUGH THE SAME PATH ══════════════════════════════════
    console.log("\n[J. terms is a thin caller: same record, same verdict shape]");
    await withEnv(ENV_OK, () =>
      withTransport(async () => MJ_OK(5), async () => {
        const v = await VenueTermsMail.sendVenueTermsEmail({ venue: venue.toObject(), lead: await VenueEnquiry.findById(lead._id), email: "priya@example.com", attachment: { filename: "T.pdf", buffer: Buffer.from("%PDF-1.4 t") }, actor: { id: owner._id, name: "Meera" } });
        eq(v.delivered, true, "verdict shape unchanged (delivered)");
        eq(v.messageId, "5", "…messageId");
        const s = await VenueEmailSend.findById(v.send._id).lean();
        ok(s && s.documentKind === "terms" && /Our booking terms and conditions are attached/.test(s.message), "🔴 a terms send is a VenueEmailSend row with the default terms message");
        ok(/Team Wedsy/.test(s.renderedHtml) === false, "…venue voice");
        const rnd = await VenueQuoteRound.findById(round._id);
        VenueTermsMail.recordDelivery(rnd, v); await rnd.save();
        eq((await VenueQuoteRound.findById(round._id).lean()).termsDelivered, true, "recordDelivery still writes the round pill fields");
      }));

    // ══ K. SEND-ONLY-WHAT-WE-GENERATED, AND THE ROUND PICKER ═════════════════
    console.log("\n[K. guards]");
    const clientDoc = await VenueLeadDocument.create({ venue: venue._id, enquiry: lead._id, kind: "client_document", version: 1, url: "https://bucket.test/x.pdf", filename: "aadhaar.pdf" });
    r = await call(send.sendPreview, req({ params: { documentId: String(clientDoc._id) } }));
    eq(r.code, 400, "a CLIENT document cannot be 'sent to client'");
    eq(r.body.code, "not_sendable", "…with a code");
    ok(rounds.SENT_VIA.includes("email") && rounds.SENT_VIA.includes("pdf"), "the round enum still accepts email/pdf — existing rows read back");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    NotificationService.sendEmail = realSendEmail;
    s3.uploadBufferToS3 = realUpload;
    pdfStitch.fetchSourcePdf = realFetch;
    try {
      await VenueEmailSend.deleteMany({ enquiry: { $in: created.leads } });
      await VenueLeadDocument.deleteMany({ enquiry: { $in: created.leads } });
      await VenueQuoteRound.deleteMany({ enquiry: { $in: created.leads } });
      await VenueQuote.deleteMany({ enquiry: { $in: created.leads } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
