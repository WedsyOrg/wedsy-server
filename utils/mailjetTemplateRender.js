/**
 * utils/mailjetTemplateRender.js — render a Mailjet template body locally with
 * the SAME variables the send carries, so the stored copy of an email is the
 * email.
 *
 * Mailjet renders on its side and returns nothing of the body, so "the HTML as
 * sent" has to be produced here from the template's Html-part. This covers
 * the subset of Mailjet's template language these templates use:
 *
 *   {{var:name}}                 substitution (empty when missing)
 *   {{var:name:"default"}}       substitution with a default
 *   {% if var:name %} … {% else %} … {% endif %}
 *                                truthiness = non-empty string / non-zero
 *
 * Anything else is left untouched, so an unsupported construct is visible in
 * the stored copy rather than silently blanked. Values are inserted RAW —
 * that is what Mailjet does — so callers must pre-escape anything untrusted
 * (VenueMail escapes the owner's message into `message_html`).
 */

const VAR_RE = /\{\{\s*var:([A-Za-z0-9_]+)(?::"((?:[^"\\]|\\.)*)")?\s*\}\}/g;
const IF_RE = /\{%\s*if\s+var:([A-Za-z0-9_]+)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g;

function truthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return v !== 0;
  return Boolean(v);
}

function renderTemplate(source, vars = {}) {
  let out = String(source || "");
  // Innermost-first is not needed for the flat conditionals these templates
  // use; one pass resolves each if/else/endif, then variables.
  let prev;
  do {
    prev = out;
    out = out.replace(IF_RE, (_, name, yes, no) => (truthy(vars[name]) ? yes : no || ""));
  } while (out !== prev);
  out = out.replace(VAR_RE, (_, name, dflt) => {
    const v = vars[name];
    if (v === undefined || v === null || v === "") return dflt !== undefined ? dflt.replace(/\\"/g, '"') : "";
    return String(v);
  });
  return out;
}

/** The {{var:}} names a template body references, for asserting coverage. */
function templateVariables(source) {
  const names = new Set();
  String(source || "").replace(VAR_RE, (_, name) => { names.add(name); return ""; });
  String(source || "").replace(/\{%\s*if\s+var:([A-Za-z0-9_]+)/g, (_, name) => { names.add(name); return ""; });
  return [...names];
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Owner-typed prose → safe HTML paragraphs with line breaks preserved. */
function messageToHtml(message) {
  const paras = String(message || "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return paras
    .filter((p) => p.trim() !== "")
    .map((p) => `<p class="text-build-content" style="margin: 10px 0;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

module.exports = { renderTemplate, templateVariables, escapeHtml, messageToHtml };
