#!/usr/bin/env node
/**
 * scripts/mailjet-template-venue-terms.js — create the `venue_terms_sent`
 * Mailjet template ONCE, from the repo, as a Passport (drag-and-drop) template.
 *
 *   node scripts/mailjet-template-venue-terms.js            # create if absent, print ID
 *   node scripts/mailjet-template-venue-terms.js --dry-run  # say what it would do
 *
 * ── CREATE-ONCE, THEN HANDS OFF ─────────────────────────────────────────────
 * MAILJET IS THE SOURCE OF TRUTH FOR THE DESIGN. The repo holds the STARTING
 * POINT (emails/venue_terms_sent.mjml.json + .txt); the owner edits the live
 * template in Mailjet's Passport editor after that. So this script REFUSES to
 * touch a template that already exists — it will not push content, not even
 * with a flag. A script that silently overwrote a design edited by hand would
 * be worse than no script. To start over deliberately: delete the template in
 * Mailjet, run this again, and put the NEW ID on the box.
 *
 * What it creates: EditMode 1 (Passport, drag-and-drop — the only mode the
 * owner can redesign in), with all three parts pushed — MJMLContent (what
 * Passport opens), the compiled Html-part (what sends), and the Text-part.
 * Mailjet's EditMode values, per dev.mailjet.com/content/guides/email-templates:
 *   1 = Drag-and-drop builder (Passport)   2 = HTML builder
 *   3 = Saved Section builder              4 = MJML builder
 *
 * Prints the template ID. Put it in MAILJET_TEMPLATE_VENUE_TERMS — the code
 * reads the ID from that env var and never hardcodes it.
 *
 * Needs MAILJET_API_KEY / MAILJET_SECRET_KEY in the environment, and `mjml`
 * (devDependency) to compile the Html-part.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client: MailjetClient } = require("node-mailjet");

const NAME = "venue_terms_sent";
const SUBJECT = "Your booking terms — {{var:venue_name}}";
// The Active sender for venue-voiced mail. The per-send From (the venue's
// name) is set by services/VenueTermsMail at send time and overrides this.
const SENDER_EMAIL = process.env.MAILJET_VENUE_FROM_EMAIL || "partner_venue@wedsy.in";
const SENDER_NAME = "Venue";
const EDIT_MODE_PASSPORT = 1;

const SRC = path.join(__dirname, "..", "emails");
const MJML_JSON = JSON.parse(fs.readFileSync(path.join(SRC, `${NAME}.mjml.json`), "utf8"));
const TEXT = fs.readFileSync(path.join(SRC, `${NAME}.txt`), "utf8");

const dryRun = process.argv.includes("--dry-run");

function compileHtml() {
  // Passport's mj-body carries color/font-family, which strict MJML rejects
  // but Passport itself emits — so validation is soft, and only that one
  // warning is tolerated.
  const mjml2html = require("mjml");
  const out = mjml2html(MJML_JSON, { validationLevel: "soft" });
  const real = out.errors.filter((e) => !/mj-body\) — Attributes color, font-family are illegal/.test(e.formattedMessage));
  if (real.length) throw new Error(`MJML did not compile cleanly:\n${real.map((e) => e.formattedMessage).join("\n")}`);
  return out.html;
}

async function findByName(client, name) {
  // node-mailjet: query parameters are request()'s SECOND argument; passed as
  // the first they are silently ignored and the default page of 10 comes back.
  // The list endpoint's Name parameter is not an exact filter either, so page
  // the account's own templates and match the name here.
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await client.get("template", { version: "v3" }).request({}, { OwnerType: "user", Limit: limit, Offset: offset });
    const rows = (res.body && res.body.Data) || [];
    const hit = rows.find((t) => t.Name === name);
    if (hit) return hit;
    if (rows.length < limit) return null;
    offset += limit;
  }
}

async function main() {
  if (!process.env.MAILJET_API_KEY || !process.env.MAILJET_SECRET_KEY) {
    throw new Error("MAILJET_API_KEY and MAILJET_SECRET_KEY are required");
  }
  const client = new MailjetClient({ apiKey: process.env.MAILJET_API_KEY, apiSecret: process.env.MAILJET_SECRET_KEY });

  const existing = await findByName(client, NAME);
  if (existing) {
    console.log(`"${NAME}" already exists — ID ${existing.ID}, EditMode ${existing.EditMode}, created ${existing.CreatedAt}.`);
    console.log("REFUSING to touch it: the live design in Mailjet is the source of truth and may have been edited by hand.");
    console.log("To start over deliberately, delete it in Mailjet and run this again (the ID will change).");
    console.log(`\nMAILJET_TEMPLATE_VENUE_TERMS=${existing.ID}`);
    return;
  }

  const html = compileHtml();
  const content = {
    MJMLContent: JSON.stringify(MJML_JSON),
    "Html-part": html,
    "Text-part": TEXT,
    Headers: {
      Subject: SUBJECT,
      SenderName: SENDER_NAME,
      SenderEmail: SENDER_EMAIL,
      From: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      ReplyEmail: "",
      "Reply-To": "",
      "X-MJ-TemplateLanguage": "1",
    },
  };
  if (dryRun) {
    console.log(`would create "${NAME}" as EditMode ${EDIT_MODE_PASSPORT} and push mjml ${content.MJMLContent.length} / html ${html.length} / text ${TEXT.length} bytes, subject "${SUBJECT}"`);
    return;
  }

  const created = await client.post("template", { version: "v3" }).request({
    Name: NAME,
    Author: "wedsy-server/emails",
    Description: "Venue → couple: booking terms & conditions, PDF attached. Starting point from scripts/mailjet-template-venue-terms.js; edited in Passport thereafter.",
    Locale: "en_US",
    OwnerType: "user",
    Purposes: ["transactional"],
    EditMode: EDIT_MODE_PASSPORT,
  });
  const template = created.body.Data[0];
  console.log(`created "${NAME}" — ID ${template.ID}, EditMode ${template.EditMode}`);
  await client.post("template", { version: "v3" }).id(template.ID).action("detailcontent").request(content);
  console.log(`content pushed: mjml ${content.MJMLContent.length} / html ${html.length} / text ${TEXT.length} bytes, subject "${SUBJECT}"`);

  // Read back rather than assume.
  const back = (await client.get("template", { version: "v3" }).id(template.ID).action("detailcontent").request()).body.Data[0];
  const ok = back.MJMLContent && (back["Html-part"] || "").length > 0 && (back["Text-part"] || "").length > 0;
  console.log(`read back: MJMLContent ${back.MJMLContent ? "present" : "MISSING"}, Html-part ${(back["Html-part"] || "").length} bytes, Text-part ${(back["Text-part"] || "").length} bytes → ${ok ? "OK" : "INCOMPLETE"}`);
  console.log(`\nMAILJET_TEMPLATE_VENUE_TERMS=${template.ID}`);
}

main().catch((e) => {
  const body = e.response && e.response.body;
  console.error("FAILED:", e.statusCode || "", e.message, body ? JSON.stringify(body).slice(0, 400) : "");
  process.exit(1);
});
