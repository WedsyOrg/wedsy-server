#!/usr/bin/env node
/**
 * scripts/mailjet-template-venue-terms.js — create or update the
 * `venue_terms_sent` Mailjet template FROM THE REPO, via the API.
 *
 *   node scripts/mailjet-template-venue-terms.js            # create/update, print ID
 *   node scripts/mailjet-template-venue-terms.js --dry-run  # say what it would do
 *
 * Idempotent: finds the template by exact name, creates it only if it does not
 * exist, then pushes emails/venue_terms_sent.{html,txt} and the headers as the
 * template's content every time. The HTML is versioned here so a change is a
 * diff in a PR, not an edit in Mailjet's editor nobody can review.
 *
 * Prints the template ID. Put it in MAILJET_TEMPLATE_VENUE_TERMS on the box —
 * the code reads the ID from that env var and never hardcodes it.
 *
 * Needs MAILJET_API_KEY / MAILJET_SECRET_KEY in the environment (dotenv is
 * loaded, so the local .env works).
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
const HTML = fs.readFileSync(path.join(__dirname, "..", "emails", `${NAME}.html`), "utf8");
const TEXT = fs.readFileSync(path.join(__dirname, "..", "emails", `${NAME}.txt`), "utf8");

const dryRun = process.argv.includes("--dry-run");

async function findByName(client, name) {
  // The list endpoint's Name parameter is not an exact filter, so page the
  // account's own templates and match the name ourselves.
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await client.get("template", { version: "v3" }).request({ OwnerType: "user", Limit: limit, Offset: offset });
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

  let template = await findByName(client, NAME);
  if (template) {
    console.log(`found "${NAME}" — ID ${template.ID} (created ${template.CreatedAt})`);
  } else if (dryRun) {
    console.log(`would create "${NAME}"`);
  } else {
    const created = await client.post("template", { version: "v3" }).request({
      Name: NAME,
      Author: "wedsy-server/emails",
      Description: "Venue → couple: booking terms & conditions, PDF attached. Managed by scripts/mailjet-template-venue-terms.js.",
      Locale: "en_US",
      OwnerType: "user",
      Purposes: ["transactional"],
      EditMode: 4, // HTML — content is pushed from the repo, not the MJML editor
    });
    template = created.body.Data[0];
    console.log(`created "${NAME}" — ID ${template.ID}`);
  }

  const content = {
    "Html-part": HTML,
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
    console.log(`would push ${HTML.length} bytes html, ${TEXT.length} bytes text, subject "${SUBJECT}"`);
  } else {
    await client.post("template", { version: "v3" }).id(template.ID).action("detailcontent").request(content);
    console.log(`content pushed: ${HTML.length} bytes html, ${TEXT.length} bytes text, subject "${SUBJECT}"`);
  }
  console.log(`\nMAILJET_TEMPLATE_VENUE_TERMS=${template ? template.ID : "<pending>"}`);
}

main().catch((e) => {
  const body = e.response && e.response.body;
  console.error("FAILED:", e.statusCode || "", e.message, body ? JSON.stringify(body).slice(0, 400) : "");
  process.exit(1);
});
