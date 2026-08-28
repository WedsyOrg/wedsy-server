# emails/

Mailjet templates whose markup is versioned HERE and pushed to the account by
a script, rather than edited in Mailjet's editor. One pair per template:
`<slug>.html` and `<slug>.txt` (the plain-text alternative — a message with no
text part scores worse with spam filters).

| slug | script | env var carrying the ID |
|---|---|---|
| `venue_terms_sent` | `node scripts/mailjet-template-venue-terms.js` | `MAILJET_TEMPLATE_VENUE_TERMS` |

The scripts are idempotent: they find the template by exact name, create it
only if absent, and always push the current content. They print the ID; put it
in the env var. IDs are never hardcoded in the code.

`venue_terms_sent.html` was derived from `cx_bid_confrm` (6636379) — table-based,
inline-styled markup emitted by Mailjet's MJML editor and proven in real
inboxes — with the copy replaced. The voice is the venue's: no "Team Wedsy",
no help@wedsy.in; Wedsy appears only as "Powered by Wedsy" in the footer.
