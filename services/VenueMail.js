/**
 * services/VenueMail.js — THE ONE WAY a venue emails a couple.
 *
 * Every couple-facing venue email — terms, quote, booking confirmation,
 * invoice, statement — goes through `sendDocumentEmail`. There is no second
 * path. What this layer owns, lifted out of the terms-only service it grew
 * from:
 *
 *   - the VOICE: sent from partner_venue@wedsy.in with the VENUE's name as the
 *     display name, signed by the owner; Wedsy appears only as "Powered by
 *     Wedsy" in the template footer
 *   - the VERDICT: `delivered` is Mailjet's answer, awaited, never "we called
 *     send()" — `verdictFromResponse` / `verdictFromThrown`
 *   - the SIZE GUARD: refuses BEFORE sending when the base64 attachment cannot
 *     fit Mailjet's 15 MB message, naming the sizes
 *   - the ATTACHMENT: always the PDF; never an email saying "attached" with
 *     nothing attached
 *   - the RECORD: one VenueEmailSend row PER SEND with the rendered body as
 *     sent, inserted before the transport call and finalised with the verdict
 *   - the ACTIVITY: an `email_sent` row on the lead pointing at the record
 *
 * Templates are Mailjet's; their IDs live in env vars, one per kind (below).
 * The rendered body is produced here from the template's Html-part as fetched
 * from Mailjet at send time (read-only, cached briefly), falling back to the
 * repo's starting point when Mailjet cannot be read — and the row says which.
 */
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const VenueOwner = require("../models/VenueOwner");
const VenueEmailSend = require("../models/VenueEmailSend");
const NotificationService = require("./NotificationService");
const { renderTemplate, messageToHtml, escapeHtml } = require("../utils/mailjetTemplateRender");
const { eventWindowLabel } = require("../utils/venueTime");
const { formatINR } = require("../utils/venueMoney");

// ─── The five kinds ────────────────────────────────────────────────────────
// slug = the Mailjet template name (account convention audience_thing_action);
// env  = where its ID lives; label = how the kind reads on screen and in the
// activity line; subject = the default subject (the template's own Headers
// win on the wire, this is what the record and the preview show).
const KINDS = {
  terms: {
    slug: "venue_terms_sent",
    env: "MAILJET_TEMPLATE_VENUE_TERMS",
    label: "Terms & conditions",
    subject: (v) => `${v.venue_name} — terms for your booking`,
    defaultMessage: (c) =>
      `Thank you for considering ${c.venueName} for your event — we would be delighted to host you.\n\nOur booking terms and conditions are attached. Please do read through them before you confirm your booking.\n\nIf anything needs explaining or you would like to talk it through, do give us a call. We look forward to hearing from you.`,
  },
  quote: {
    slug: "venue_quote_sent",
    env: "MAILJET_TEMPLATE_VENUE_QUOTE",
    label: "Quote",
    subject: (v) => `${v.venue_name} — quote for your event`,
    defaultMessage: (c) =>
      `Thank you for considering ${c.venueName} for your event — it would be a pleasure to host you.\n\n${c.dates ? `Please find your quote attached, for ${c.dates}.` : "Please find your quote attached."}\n\nWe would be glad to talk it through or make adjustments if anything needs changing. Do give us a call — we look forward to hearing from you.`,
  },
  booking_confirmation: {
    slug: "venue_booking_confirmed",
    env: "MAILJET_TEMPLATE_VENUE_BOOKING_CONFIRMED",
    label: "Booking confirmation",
    subject: (v) => `${v.venue_name} — your booking is confirmed`,
    defaultMessage: (c) =>
      `Congratulations — and thank you for choosing ${c.venueName}.\n\n${c.dates ? `We are delighted to confirm your booking for ${c.dates}. ` : "We are delighted to confirm your booking. "}Your booking confirmation is attached; do keep it safe, and let us know straight away if anything on it is not as you expected.\n\nWe could not be happier to be part of your celebration, and we look forward to welcoming you.`,
  },
  invoice: {
    slug: "venue_invoice_sent",
    env: "MAILJET_TEMPLATE_VENUE_INVOICE",
    label: "Invoice",
    subject: (v) => `${v.venue_name} — your invoice`,
    defaultMessage: (c) =>
      `Please find your invoice from ${c.venueName} attached.\n\nDo have a look through it, and if anything needs clarifying, give us a call — we are happy to help.\n\nThank you.`,
  },
  statement: {
    slug: "venue_statement_sent",
    env: "MAILJET_TEMPLATE_VENUE_STATEMENT",
    label: "Statement of account",
    subject: (v) => `${v.venue_name} — your statement of account`,
    defaultMessage: (c) =>
      `${c.dates ? `Please find your statement of account from ${c.venueName} attached, covering your booking for ${c.dates}.` : `Please find your statement of account from ${c.venueName} attached.`}\n\nDo look it over, and if any line does not match your records, tell us and we will look into it.\n\nThank you.`,
  },
  // A per-payment receipt. Copy and template are settled and committed; the
  // PDF generator does NOT exist yet, so nothing files a "receipt" document,
  // VenueLeadDocument has no such kind, and the template is not created in
  // Mailjet. `amount` is the payment row's amount, formatted, when it exists.
  receipt: {
    slug: "venue_receipt_sent",
    env: "MAILJET_TEMPLATE_VENUE_RECEIPT",
    label: "Payment receipt",
    subject: (v) => `${v.venue_name} — payment received`,
    defaultMessage: (c) =>
      `Thank you — we have received your payment${c.amount ? ` of ${c.amount}` : ""} towards your booking with ${c.venueName}${c.dates ? ` for your event on ${c.dates}` : ""}.\n\nYour receipt is attached for your records. If anything on it does not look right, do give us a call.\n\nWe look forward to welcoming you.`,
  },
};

const DEFAULT_VENUE_SENDER = "partner_venue@wedsy.in";
const BODY_ALLOWANCE_BYTES = 256 * 1024;
const TEMPLATE_CACHE_MS = 5 * 60 * 1000;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// ─── Who signs: the TEAM MEMBER who pressed send ────────────────────────────
// VenueOwner and VenueTeamMember are different identities with the same two
// required fields (name, phone — the OTP login number). The request carries
// only ids, so the signature is a lookup: memberId → VenueTeamMember, else
// venueOwnerId → VenueOwner. A row that no longer resolves (deleted, bad
// token) falls back to the venue itself rather than a blank signature.
async function resolveSender(actor, venue) {
  const VenueTeamMember = require("../models/VenueTeamMember");
  if (actor && actor.memberId) {
    const m = await VenueTeamMember.findById(actor.memberId).select("name phone").lean();
    if (m && m.name) return { name: m.name, phone: m.phone || "", id: m._id, via: "member" };
  }
  if (actor && (actor.venueOwnerId || actor.id)) {
    const o = await VenueOwner.findById(actor.venueOwnerId || actor.id).select("name phone").lean();
    if (o && o.name) return { name: o.name, phone: o.phone || "", id: o._id, via: "owner" };
  }
  return { name: venue.name || "", phone: resolvePhone(venue), id: null, via: "venue" };
}
function resolvePhone(venue) {
  const contact = venue.contact || {};
  return contact.primaryPhone || venue.phone || "";
}
/** http(s) only — a data: URI is blocked by inboxes; the template then shows the name. */
function resolveLogoUrl(venue) {
  const logo = venue.logo;
  return typeof logo === "string" && /^https?:\/\//.test(logo) ? logo : "";
}
function venueFrom(venue) {
  return { Email: process.env.MAILJET_VENUE_FROM_EMAIL || DEFAULT_VENUE_SENDER, Name: venue.name || "" };
}

// ─── The verdict ────────────────────────────────────────────────────────────
function attachmentVerdict(buffer, filename, limit = NotificationService.MAILJET_MESSAGE_LIMIT_BYTES) {
  const raw = buffer ? buffer.length : 0;
  const encoded = Math.ceil(raw / 3) * 4;
  if (encoded + BODY_ALLOWANCE_BYTES <= limit) return { ok: true, raw, encoded };
  return {
    ok: false,
    raw,
    encoded,
    reason:
      `The PDF ${filename ? `(${filename}) ` : ""}is ${mb(raw)} — ${mb(encoded)} once encoded for email — ` +
      `which is over Mailjet's ${mb(limit)} message limit. The send was recorded but not emailed.`,
  };
}
function verdictFromResponse(response) {
  const body = response && response.body;
  const msg = body && Array.isArray(body.Messages) ? body.Messages[0] : null;
  if (!msg) return { delivered: false, deliveryError: "Mailjet returned no message status." };
  if (msg.Status === "success") {
    const to = Array.isArray(msg.To) && msg.To[0];
    return { delivered: true, deliveryError: "", messageId: to && to.MessageID ? String(to.MessageID) : "" };
  }
  const err = Array.isArray(msg.Errors) && msg.Errors[0];
  const detail = err
    ? `${err.ErrorMessage || err.ErrorIdentifier || "unknown error"}${err.ErrorRelatedTo ? ` (${[].concat(err.ErrorRelatedTo).join(", ")})` : ""}`
    : "no detail";
  return { delivered: false, deliveryError: `Mailjet refused the email: ${detail}` };
}
function verdictFromThrown(e) {
  const body = e && e.response && e.response.body;
  const detail =
    (body && (body.ErrorMessage || (Array.isArray(body.Messages) && body.Messages[0] && body.Messages[0].Errors && body.Messages[0].Errors[0] && body.Messages[0].Errors[0].ErrorMessage))) ||
    (e && e.message) ||
    "unknown error";
  const status = e && e.statusCode ? ` (HTTP ${e.statusCode})` : "";
  return { delivered: false, deliveryError: `Email transport failed${status}: ${String(detail).trim().replace(/\.+$/, "")}. The send was recorded but not emailed.` };
}

// ─── Template source: Mailjet as it stands, else the repo's starting point ──
const templateCache = new Map();
async function fetchMailjetTemplate(templateId) {
  const hit = templateCache.get(templateId);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.value;
  const { Client } = require("node-mailjet");
  const client = new Client({ apiKey: process.env.MAILJET_API_KEY, apiSecret: process.env.MAILJET_SECRET_KEY });
  const [meta, content] = await Promise.all([
    client.get("template", { version: "v3" }).id(templateId).request(),
    client.get("template", { version: "v3" }).id(templateId).action("detailcontent").request(),
  ]);
  const d = (content.body.Data && content.body.Data[0]) || {};
  const m = (meta.body.Data && meta.body.Data[0]) || {};
  const value = {
    html: d["Html-part"] || "",
    text: d["Text-part"] || "",
    subject: d.Headers && d.Headers.Subject,
    updatedAt: m.LastUpdatedAt ? new Date(m.LastUpdatedAt) : null,
  };
  if (!value.html) throw new Error("template has no Html-part");
  templateCache.set(templateId, { at: Date.now(), value });
  return value;
}
/**
 * The repo's fallback body is a PRECOMPILED ARTEFACT — emails/compiled/<slug>.html,
 * written by `scripts/mailjet-template-venue.js --compile` from the
 * .mjml.json source at dev time — not compiled here. The MJML compiler is a
 * devDependency: 123 packages and a deprecated glob with published CVEs, on
 * a box that installs with --omit=dev. Requiring it at runtime made the
 * fallback indistinguishable from a missing module in production. Nothing
 * under services/ requires "mjml"; the suite asserts that, and asserts the
 * artefact matches a fresh compile of its source so a stale copy fails.
 */
const COMPILED_DIR = path.join(__dirname, "..", "emails", "compiled");
function repoTemplate(kind) {
  const slug = KINDS[kind].slug;
  const htmlPath = path.join(COMPILED_DIR, `${slug}.html`);
  const html = fs.readFileSync(htmlPath, "utf8");
  const text = fs.readFileSync(path.join(__dirname, "..", "emails", `${slug}.txt`), "utf8");
  return { html, text, subject: undefined, updatedAt: null };
}
/**
 * The template body to render from, and where it came from. Mailjet is the
 * source of truth for the live design; the compiled repo artefact is the
 * fallback so a send is never blocked on a read of the template. When
 * neither can be read this returns `null` rather than throwing — the caller
 * turns that into a VERDICT on the record, never a 500.
 */
async function templateSource(kind, templateId, { allowMailjet = true } = {}) {
  if (allowMailjet && templateId && process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY && process.env.VENUE_MAIL_RENDER !== "repo") {
    try {
      return { ...(await fetchMailjetTemplate(templateId)), from: "mailjet" };
    } catch (e) {
      console.warn(`[VenueMail] could not read template ${templateId} from Mailjet (${e.message}); rendering from the compiled repo artefact`);
    }
  }
  try {
    return { ...repoTemplate(kind), from: "repo" };
  } catch (e) {
    console.error(`[VenueMail] no fallback body for ${KINDS[kind].slug}: ${e.message}`);
    return null;
  }
}

// ─── Variables ──────────────────────────────────────────────────────────────
async function buildVariables({ venue, lead, kind, message, document, recipientName, sender, amount }) {
  const coupleName = (lead && (lead.coupleName || lead.name)) || "";
  const spec = KINDS[kind];
  const who = sender || { name: venue.name || "", phone: resolvePhone(venue) };
  const vars = {
    venue_name: venue.name || "",
    sender_name: who.name || venue.name || "",
    sender_phone: who.phone || resolvePhone(venue),
    event_window: eventWindowLabel(lead),
    amount: amount ? formatINR(amount) : "",
    // The greeting addresses the PERSON the email goes to. A document sent to
    // the bride's father must not open "Dear Priya & Arjun" — that is the
    // couple's name on someone else's email. The couple's name stays
    // available as its own variable for templates that want it.
    couple_name: (recipientName && String(recipientName).trim()) || coupleName,
    couple_full_name: coupleName,
    venue_phone: resolvePhone(venue),
    venue_logo: resolveLogoUrl(venue),
    document_label: spec.label,
    document_version: document && document.version ? String(document.version) : "",
    message_text: String(message || ""),
    message_html: messageToHtml(message || ""),
  };
  return vars;
}

/** The default owner message for a kind, in the venue's words. */
function defaultMessage(kind, { venue, document, lead, amount } = {}) {
  return KINDS[kind].defaultMessage({
    venueName: (venue && venue.name) || "",
    venuePhone: resolvePhone(venue || {}),
    version: document && document.version,
    // The sentence carrying the window DROPS when there is no window — a
    // window nobody typed is never invented (a lone eventDate renders as a day).
    dates: eventWindowLabel(lead),
    amount: amount ? formatINR(amount) : "",
  });
}

/**
 * Render the email as it WOULD be sent — used by the modal preview and by the
 * send itself, so what the owner saw is what the record holds.
 */
async function renderPreview({ venue, lead, kind, message, document, recipientName, sender, amount, allowMailjet = true }) {
  const spec = KINDS[kind];
  const templateId = Number(process.env[spec.env]) || 0;
  const vars = await buildVariables({ venue, lead, kind, message, document, recipientName, sender, amount });
  const src = await templateSource(kind, templateId, { allowMailjet });
  const subject = renderTemplate((src && src.subject) || spec.subject(vars), vars);
  if (!src) {
    return {
      subject,
      html: "",
      text: "",
      renderedFrom: "",
      renderError: `The ${spec.label} email could not be rendered: the template could not be read from Mailjet and the repo has no compiled fallback (emails/compiled/${spec.slug}.html).`,
      templateId,
      templateUpdatedAt: null,
      variables: vars,
      from: venueFrom(venue),
    };
  }
  return {
    subject,
    html: renderTemplate(src.html, vars),
    text: renderTemplate(src.text, vars),
    renderedFrom: src.from,
    renderError: "",
    templateId,
    templateUpdatedAt: src.updatedAt,
    variables: vars,
    from: venueFrom(venue),
  };
}

/**
 * Send one document to one address, and record it.
 *
 * Never throws for transport reasons — the record is the point, and the
 * verdict goes on it. Returns { send, verdict }.
 *
 * @param p.attachment  {filename, buffer, url?, sizeBytes?} or an async
 *                      function producing that — run only after the config
 *                      checks pass, so a box with no template never fetches
 *                      a 10 MB file to then not send it.
 * @param p.transport   sendEmail override (tests)
 */
async function sendDocumentEmail({ venue, lead, kind, document, email, name, message, attachment, actor, amount, transport, allowMailjet = true } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown venue email kind "${kind}"`);
  const to = { email: String(email || "").trim().toLowerCase(), name: name || (lead && (lead.coupleName || lead.name)) || "" };
  const finalMessage = String(message == null || String(message).trim() === "" ? defaultMessage(kind, { venue, document, lead, amount }) : message);
  const sender = await resolveSender(actor, venue);

  // 1 — THE RECORD, BEFORE ANYTHING CAN FAIL. Inserted bare: the render is
  // not trusted to succeed — it reads Mailjet or a repo artefact, either can
  // be missing — and a failure there must become a verdict on this row, not
  // a 500 with no row. (The first version rendered before inserting; a
  // missing module produced no row, no verdict and a 500 in the modal — the
  // build's own honest-failure rule broken in its own code.)
  const send = await VenueEmailSend.create({
    venue: venue._id,
    enquiry: lead._id,
    document: document && document._id ? document._id : undefined,
    documentKind: kind,
    documentVersion: document && document.version,
    subject: spec.subject({ venue_name: venue.name || "" }),
    to,
    from: { email: venueFrom(venue).Email, name: venueFrom(venue).Name },
    message: finalMessage,
    attachment: { url: "", filename: "", sizeBytes: undefined },
    delivered: false,
    deliveryError: "in flight",
    triggeredBy: (sender && sender.id) || (actor && actor.id) || undefined,
    triggeredByName: (sender && sender.via !== "venue" && sender.name) || (actor && actor.name) || "",
  });

  // 2 — render, then the verdict. Everything in here degrades to a verdict.
  let verdict;
  let rendered = null;
  let att = attachment;
  try {
    verdict = await (async () => {
      try {
        rendered = await renderPreview({ venue, lead, kind, message: finalMessage, document, recipientName: to.name, sender, amount, allowMailjet });
      } catch (e) {
        console.error(`[VenueMail] render failed for lead ${lead._id}: ${e.message}`);
        return { delivered: false, deliveryError: `The ${spec.label} email could not be rendered (${e.message}). The send was recorded but not emailed.` };
      }
      if (rendered.renderError) return { delivered: false, deliveryError: `${rendered.renderError} The send was recorded but not emailed.` };
      const templateId = rendered.templateId;
      if (!templateId) {
        return { delivered: false, deliveryError: `No "${spec.slug}" email template is configured (${spec.env}) — the send was recorded but not emailed.` };
      }
      if (!process.env.MAILJET_API_KEY || !process.env.MAILJET_SECRET_KEY) {
        return { delivered: false, deliveryError: "Email transport is not configured on this environment — the send was recorded but not emailed." };
      }
      if (typeof att === "function") {
        try {
          att = await att();
        } catch (e) {
          console.warn(`[VenueMail] could not prepare the ${spec.label} PDF for lead ${lead._id}: ${e.message}`);
          return { delivered: false, deliveryError: `The ${spec.label} PDF could not be prepared (${e.message}), so nothing was emailed. The send was recorded.` };
        }
      }
      if (!att || !att.buffer || !att.buffer.length) {
        return { delivered: false, deliveryError: `The ${spec.label} PDF could not be prepared, so nothing was emailed. The send was recorded.` };
      }
      const size = attachmentVerdict(att.buffer, att.filename);
      if (!size.ok) return { delivered: false, deliveryError: size.reason };
      const sendEmail = transport || NotificationService.sendEmail;
      try {
        const response = await sendEmail(to.email, templateId, rendered.variables, to.name, {
          from: rendered.from,
          attachments: [{ filename: att.filename || `${kind}.pdf`, contentType: "application/pdf", base64: att.buffer.toString("base64") }],
        });
        return verdictFromResponse(response);
      } catch (e) {
        console.warn(`[VenueMail] send failed for lead ${lead._id}: ${e.message}`);
        return verdictFromThrown(e);
      }
    })();
  } catch (e) {
    verdict = { delivered: false, deliveryError: `Unexpected failure before the email left: ${e.message}. The send was recorded.` };
  }

  // 3 — finalise the row (the one permitted post-insert write): what was
  // rendered, if anything, and the verdict.
  send.$locals.allowVerdict = true;
  if (rendered) {
    send.subject = rendered.subject;
    send.renderedHtml = rendered.html;
    send.renderedText = rendered.text;
    send.renderedFrom = rendered.renderedFrom;
    send.templateId = rendered.templateId || undefined;
    send.templateUpdatedAt = rendered.templateUpdatedAt || undefined;
    send.variables = rendered.variables;
  }
  send.delivered = Boolean(verdict.delivered);
  send.deliveryError = verdict.delivered ? "" : verdict.deliveryError || "";
  send.messageId = verdict.delivered ? verdict.messageId || "" : "";
  send.deliveredAt = verdict.delivered ? new Date() : undefined;
  if (att && typeof att === "object") {
    send.attachment = {
      url: att.url || (document && document.url) || "",
      filename: att.filename || (document && document.filename) || "",
      sizeBytes: att.buffer ? att.buffer.length : att.sizeBytes,
    };
  } else if (document) {
    send.attachment = { url: document.url || "", filename: document.filename || "", sizeBytes: document.sizeBytes };
  }
  await send.save();

  // 4 — the activity, pointing at the record.
  if (lead && Array.isArray(lead.activities)) {
    lead.activities.push({
      type: "email_sent",
      description: `${spec.label}${document && document.version ? ` v${document.version}` : ""} emailed to ${to.email}${verdict.delivered ? "" : " — recorded, not emailed"}`,
      actor: actor && actor.id ? actor.id : null,
      timestamp: new Date(),
      ref: send._id,
      refModel: "VenueEmailSend",
    });
  }

  return { send, verdict };
}

module.exports = {
  KINDS,
  sendDocumentEmail,
  renderPreview,
  defaultMessage,
  buildVariables,
  attachmentVerdict,
  verdictFromResponse,
  verdictFromThrown,
  resolveSender,
  resolvePhone,
  resolveLogoUrl,
  venueFrom,
  templateSource,
  escapeHtml,
  BODY_ALLOWANCE_BYTES,
  DEFAULT_VENUE_SENDER,
  COMPILED_DIR,
};
