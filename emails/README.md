# emails/

STARTING POINTS for Mailjet templates. One pair per template: `<slug>.mjml.json`
(the MJML tree in Passport's JSON shape — what the drag-and-drop editor opens)
and `<slug>.txt` (the plain-text alternative — a message with no text part
scores worse with spam filters).

**Mailjet is the source of truth for the design.** The script creates the
template ONCE (EditMode 1, Passport) with MJMLContent + compiled Html-part +
Text-part, then hands off: the owner edits the live template in Passport, and
the script REFUSES to touch a template that already exists. What is in this
directory is where the design started, not what it currently is.

One script, `node scripts/mailjet-template-venue.js <slug>` (`--list` prints
this table from the code):

| slug | document | env var carrying the ID |
|---|---|---|
| `venue_terms_sent` | Terms & conditions | `MAILJET_TEMPLATE_VENUE_TERMS` |
| `venue_quote_sent` | Quote | `MAILJET_TEMPLATE_VENUE_QUOTE` |
| `venue_booking_confirmed` | Booking confirmation | `MAILJET_TEMPLATE_VENUE_BOOKING_CONFIRMED` |
| `venue_invoice_sent` | Invoice | `MAILJET_TEMPLATE_VENUE_INVOICE` |
| `venue_statement_sent` | Statement of account | `MAILJET_TEMPLATE_VENUE_STATEMENT` |

All five are COUPLE-FACING and white-label: sent from partner_venue@wedsy.in
with the venue's name as display name, signed by the owner, Wedsy only as
"Powered by Wedsy". The body has ONE variable region, `{{var:message_html}}`
(`{{var:message_text}}` in the text part) — the owner's message from the
Send-to-client modal; masthead, greeting, attachment line, signature and
footer are the fixed frame. `services/VenueMail` renders the same template with
the same variables into the send record, so what a past email said is stored,
not recomputed.

The scripts find the template by exact name and create it only if absent; an
existing one is never overwritten. They print the ID; put it in the env var.
IDs are never hardcoded in the code. To start over: delete in Mailjet, re-run,
put the NEW ID on the box.

`venue_terms_sent.mjml.json` was derived from `cx_bid_confrm` (6636379)'s own
MJMLContent — the block structure Passport built and has proven in real
inboxes — with the images replaced by the venue masthead and the copy replaced.
(A first pass used the COMPILED HTML as the skeleton; compiled output cannot be
fed back into a block editor, which left the template blank in Passport.) The voice is the venue's: no "Team Wedsy",
no help@wedsy.in; Wedsy appears only as "Powered by Wedsy" in the footer.
