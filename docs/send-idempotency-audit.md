# #194 — send idempotency: audit and fix shape

Audit only, 6 Sep 2026. No code changed.

## 1 · Reproduced, on both of Kiara's channels

A send where Meta **accepts and delivers** but the response is lost on the way
back — a socket hang-up, a read timeout, an ECONNRESET. All transport failures
the retry loop correctly treats as retryable.

```
Kiara → Instagram (sendInstagramDM)    delivered 3x   failureLog: attempts=3
Kiara → WhatsApp  (sendWhatsAppText)   delivered 3x   failureLog: attempts=3
HUMAN → Instagram (human-agent)        delivered 1x   (mitigated in #195)
```

Both automated paths still deliver up to three copies of one message.

### The transcript records one row, always

`saveMessage` runs **before** the send on both channels
(`InstagramAgentService:570`, `WhatsAppAgentService:298`). So the CRM shows one
message while the customer may have received three, and nobody auditing the
thread afterwards can reconstruct what happened.

## 2 · Measured — and the honest answer is that it is largely unmeasurable

This is the finding that matters most, because it changes what "how often" can
mean.

**The most likely duplicate case leaves no trace at all.** Deliver → lose the
response → retry → **succeed**:

```
delivered to the customer : 2
function returned         : SUCCESS
failure-log rows written  : 0
```

Two copies, and the database records nothing. There is no row to count, on
either channel. Any number produced from existing data is therefore a **floor**,
not a measurement.

### What *can* be counted

Retry episodes that ended in **total** failure leave a `NotificationFailureLog`
row carrying `attempts`. That is a proxy for how often the transport flakes, and
an upper bound on duplicates *from those episodes only*.

It must be split by error class, because most retries deliver nothing:

| class | delivered? |
|---|---|
| `API error: 4xx` — Meta answered and rejected | **no** — zero duplicate risk |
| `API error: 5xx` — Meta errored | maybe |
| no HTTP answer (ECONNRESET, timeout) | **maybe** — this is the risk class |

On dev, 11 of 13 retry episodes were 4xx and only 2 were transport. If that
ratio holds in production, **the duplicate-risk class is a small minority of
retries** — which is what makes the fix below affordable.

Note also that #195 stopped Instagram retrying 4xx at all, so that whole class is
already gone forward; historical rows predate it.

### The query (SSH is gated — hand this over)

```js
// Retry episodes that ended in total failure, split by whether they could
// possibly have delivered. Read-only.
db.notificationfailurelogs.aggregate([
  { $match: { service: { $in: ["WhatsApp", "Instagram"] }, attempts: { $gt: 1 } } },
  { $addFields: { cls: { $switch: { branches: [
      { case: { $regexMatch: { input: "$error", regex: "API error: 4\\d\\d" } }, then: "4xx-delivered-nothing" },
      { case: { $regexMatch: { input: "$error", regex: "API error: 5\\d\\d" } }, then: "5xx-may-have-delivered" }
    ], default: "transport-may-have-delivered" } } } },
  { $group: { _id: { service: "$service", cls: "$cls" },
              episodes: { $sum: 1 },
              maxExtraCopies: { $sum: { $subtract: ["$attempts", 1] } } } },
  { $sort: { episodes: -1 } }
])
```

`maxExtraCopies` is a ceiling, not a count: it assumes every retried attempt
delivered, which is the worst case.

**Read the `transport` and `5xx` rows only.** The 4xx rows delivered nothing and
would inflate the figure several-fold.

## 3 · Fix shape

### Not available: an idempotency key

Meta's messaging send APIs do not accept one. `idempotency_key` exists on the
**Commerce Platform Orders** API and is documented there in exactly the terms we
would want — *"multiple identical requests using the same idempotency_key have
the same effect as making a single request"* — but no equivalent is offered on
Messenger/Instagram or WhatsApp Cloud sends. So the Stripe-shaped answer is off
the table, and the remaining options are all local.

### Recommended: two changes, in this order

**(a) Store the provider message id — cheap, and it closes the blindness.**

Both APIs return one (`message_id` on Instagram, `wamid…` on WhatsApp) and both
are discarded today. `WAAgentMessage` has no field for it. Storing it does not
prevent a duplicate, but it makes duplicates **detectable afterwards**, which is
the gap section 2 is about. It is also the prerequisite for (b).

Worth doing on its own even if (b) never happens: today we cannot answer "did
this customer get three copies" for any thread, past or future.

**(b) Verify before re-POSTing, on transport failures only.**

The dangerous case is precisely "we do not know whether it landed". Rather than
guess, ask: on a transport failure, read the thread's recent messages from Meta
and re-send only if ours is absent.

This is affordable **because of the measurement**: the transport class is a small
minority of retries, so the extra read happens rarely. It would have been hard to
justify against all retries.

WhatsApp has a second route to the same answer: Cloud API already sends
**`statuses` webhooks** reporting delivery per `wamid`. `controllers/whatsappAgent.js`
reads only `value.messages` and ignores `value.statuses` entirely. Consuming
those gives delivery confirmation without an extra read — and would also fix the
transcript, which currently cannot show whether anything was delivered.

### Considered and rejected

- **Stop retrying Kiara's sends** (symmetric with the human path). A dropped
  automated reply means a lead is never answered and nobody notices — no human
  is watching that send. Rejected in #195 for that reason; the reasoning holds.
- **Dedupe on the returned `message_id`.** Does not help: the failure case is
  precisely not receiving one.

## 4 · Adjacent finding, not part of #194

`utils/whatsapp.js` has the truncate-then-log pattern that #192 fixed in
`utils/instagram.js`, and **no sanitisation at all** — `redactSecrets` and
`sanitizeError` are not used anywhere in that file, and `error.message` (which
embeds up to 300 characters of Meta's response body) is written straight to
`NotificationFailureLog`.

Materially lower risk than Instagram's was: the WhatsApp token travels in an
`Authorization` header, not in the URL, so the main #192 vector is absent. But
the defence is absent too. Worth its own ticket rather than folding into #194.
