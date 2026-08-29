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
    subject: (v) => `Your booking terms — ${v.venue_name}`,
    defaultMessage: (c) =>
      `Thank you for your interest in ${c.venueName}.\n\nOur booking terms and conditions are attached to this email. Please read through them before confirming your booking.`,
  },
  quote: {
    slug: "venue_quote_sent",
    env: "MAILJET_TEMPLATE_VENUE_QUOTE",
    label: "Quote",
    subject: (v) => `Your quote from ${v.venue_name}`,
    defaultMessage: (c) =>
      `Thank you for considering ${c.venueName} for your wedding.\n\nOur quote${c.version ? ` (v${c.version})` : ""} is attached. It sets out what is included and the amount payable. We would be glad to walk you through it or adjust it — reply to this email or call us on ${c.venuePhone || "the number below"}.`,
  },
  booking_confirmation: {
    slug: "venue_booking_confirmed",
    env: "MAILJET_TEMPLATE_VENUE_BOOKING_CONFIRMED",
    label: "Booking confirmation",
    subject: (v) => `Your booking is confirmed — ${v.venue_name}`,
    defaultMessage: (c) =>
      `We are delighted to confirm your booking with ${c.venueName}.\n\nYour booking confirmation is attached. It records the dates, the spaces reserved for you and the agreed amount. Please keep it safe and let us know straight away if anything on it is not as you expected.`,
  },
  invoice: {
    slug: "venue_invoice_sent",
    env: "MAILJET_TEMPLATE_VENUE_INVOICE",
    label: "Invoice",
    subject: (v) => `Your invoice from ${v.venue_name}`,
    defaultMessage: (c) =>
      `Please find your invoice from ${c.venueName} attached.\n\nIt shows the amount due and how to pay. If you have already paid, thank you — please ignore this reminder. For any question about the invoice, reply to this email or call us on ${c.venuePhone || "the number below"}.`,
  },
  statement: {
    slug: "venue_statement_sent",
    env: "MAILJET_TEMPLATE_VENUE_STATEMENT",
    label: "Statement of account",
    subject: (v) => `Your statement of account — ${v.venue_name}`,
    defaultMessage: (c) =>
      `Please find your statement of account from ${c.venueName} attached.\n\nIt lists the agreed amount, everything billed, everything received so far and the balance outstanding, all on one page. If any line does not match your records, tell us and we will look into it.`,
  },
};

const DEFAULT_VENUE_SENDER = "partner_venue@wedsy.in";
const BODY_ALLOWANCE_BYTES = 256 * 1024;
const TEMPLATE_CACHE_MS = 5 * 60 * 1000;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// ─── Venue identity (who the email is from, in words) ──────────────────────
async function resolveOwnerName(venue) {
  const owner = await VenueOwner.findOne({ venueId: venue._id, role: "owner", isActive: { $ne: false } })
    .sort({ createdAt: 1 })
    .select("name")
    .lean();
  if (owner && owner.name) return owner.name;
  const contact = venue.contact || {};
  return contact.primaryName || venue.name || "";
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
function repoTemplate(kind) {
  const base = path.join(__dirname, "..", "emails", KINDS[kind].slug);
  const tree = JSON.parse(fs.readFileSync(`${base}.mjml.json`, "utf8"));
  const html = require("mjml")(tree, { validationLevel: "soft" }).html;
  const text = fs.readFileSync(`${base}.txt`, "utf8");
  return { html, text, subject: undefined, updatedAt: null };
}
/**
 * The template body to render from, and where it came from. Mailjet is the
 * source of truth for the live design; the repo is the fallback so a send is
 * never blocked on a read of the template, and the row records which.
 */
async function templateSource(kind, templateId, { allowMailjet = true } = {}) {
  if (allowMailjet && templateId && process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY && process.env.VENUE_MAIL_RENDER !== "repo") {
    try {
      return { ...(await fetchMailjetTemplate(templateId)), from: "mailjet" };
    } catch (e) {
      console.warn(`[VenueMail] could not read template ${templateId} from Mailjet (${e.message}); rendering from the repo starting point`);
    }
  }
  return { ...repoTemplate(kind), from: "repo" };
}

// ─── Variables ──────────────────────────────────────────────────────────────
async function buildVariables({ venue, lead, kind, message, document }) {
  const coupleName = (lead && (lead.coupleName || lead.name)) || "";
  const spec = KINDS[kind];
  const vars = {
    venue_name: venue.name || "",
    couple_name: coupleName,
    owner_name: await resolveOwnerName(venue),
    venue_phone: resolvePhone(venue),
    venue_logo: resolveLogoUrl(venue),
    document_label: spec.label,
    document_name: (document && document.filename) || "",
    document_version: document && document.version ? String(document.version) : "",
    message_text: String(message || ""),
    message_html: messageToHtml(message || ""),
  };
  return vars;
}

/** The default owner message for a kind, in the venue's words. */
function defaultMessage(kind, { venue, document } = {}) {
  return KINDS[kind].defaultMessage({
    venueName: (venue && venue.name) || "",
    venuePhone: resolvePhone(venue || {}),
    version: document && document.version,
  });
}

/**
 * Render the email as it WOULD be sent — used by the modal preview and by the
 * send itself, so what the owner saw is what the record holds.
 */
async function renderPreview({ venue, lead, kind, message, document, allowMailjet = true }) {
  const spec = KINDS[kind];
  const templateId = Number(process.env[spec.env]) || 0;
  const vars = await buildVariables({ venue, lead, kind, message, document });
  const src = await templateSource(kind, templateId, { allowMailjet });
  const subject = renderTemplate(src.subject || spec.subject(vars), vars);
  return {
    subject,
    html: renderTemplate(src.html, vars),
    text: renderTemplate(src.text, vars),
    renderedFrom: src.from,
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
async function sendDocumentEmail({ venue, lead, kind, document, email, name, message, attachment, actor, transport, allowMailjet = true } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown venue email kind "${kind}"`);
  const to = { email: String(email || "").trim().toLowerCase(), name: name || (lead && (lead.coupleName || lead.name)) || "" };
  const finalMessage = String(message == null || String(message).trim() === "" ? defaultMessage(kind, { venue, document }) : message);

  // 1 — the record, before anything can fail.
  const rendered = await renderPreview({ venue, lead, kind, message: finalMessage, document, allowMailjet });
  const send = await VenueEmailSend.create({
    venue: venue._id,
    enquiry: lead._id,
    document: document && document._id ? document._id : undefined,
    documentKind: kind,
    documentVersion: document && document.version,
    subject: rendered.subject,
    to,
    from: { email: rendered.from.Email, name: rendered.from.Name },
    message: finalMessage,
    renderedHtml: rendered.html,
    renderedText: rendered.text,
    renderedFrom: rendered.renderedFrom,
    templateId: rendered.templateId || undefined,
    templateUpdatedAt: rendered.templateUpdatedAt || undefined,
    variables: rendered.variables,
    attachment: { url: "", filename: "", sizeBytes: undefined },
    delivered: false,
    deliveryError: "in flight",
    triggeredBy: actor && actor.id ? actor.id : undefined,
    triggeredByName: (actor && actor.name) || "",
  });

  // 2 — the verdict.
  let verdict;
  let att = attachment;
  try {
    verdict = await (async () => {
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

  // 3 — finalise the row (the one permitted post-insert write).
  send.$locals.allowVerdict = true;
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
  resolveOwnerName,
  resolvePhone,
  resolveLogoUrl,
  venueFrom,
  templateSource,
  escapeHtml,
  BODY_ALLOWANCE_BYTES,
  DEFAULT_VENUE_SENDER,
};
