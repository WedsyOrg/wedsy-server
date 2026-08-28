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

| slug | script | env var carrying the ID |
|---|---|---|
| `venue_terms_sent` | `node scripts/mailjet-template-venue-terms.js` | `MAILJET_TEMPLATE_VENUE_TERMS` |

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
