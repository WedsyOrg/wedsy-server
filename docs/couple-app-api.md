# The couple-app API — foundation

What this milestone built, why each model is new or reused, how permissions are
enforced, where the four cross-screen invariants live, and every endpoint still
to build with its contract.

The spec is `design-handoff/06-data-model-and-api.md` (§ 06.1 entities, § 06.2
endpoints, § 06.3 sync rules, § 06.4 permissions). The **contract** is
`wedsy-user`'s `lib/plan/api.js` and `lib/plan/api-public.js` — the finished
frontend declares every path, body and response shape it expects, and its
fixtures in `lib/plan/seed.js` are what the screens were built against.

---

## 1. How `weddingId` resolves

**A couple's wedding IS the existing `Event` document.** `weddingId` in every
couple-app route is an `Event._id`.

`models/Event.js` already holds the couple (`user`, `brideName`, `groomName`,
`eventDate`) and `eventDays[]` with per-day venue and `decorItems`, and it is
what the CRM, the admin event tool and the vendor apps already read. A parallel
`Wedding` collection would give the business two records per wedding and a sync
problem — which is exactly what § 06.3 exists to prevent.

Nothing on `Event` changed. One **new optional sub-document** was added,
`Event.coupleApp`, absent on every existing document and read by nothing that
exists today:

| Field | Why it is there |
|---|---|
| `coupleApp.partners[]` | `Event.user` is the account the wedding was created under. The second partner signs in with an account of their own and **both are full members** (§ 06.4), so the second id needs somewhere to live. |
| `coupleApp.city`, `muhurthamTime`, `coverPhoto` | Couple-facing wedding facts the CRM has no field for. |
| `coupleApp.budget` | `{ estimate, target, estimateAnswers, lines[] }`. **There is no `committed` field** — see invariant 3. |

### Who is on a wedding

`middlewares/coupleAuth.js` resolves exactly three ways in:

1. `Event.user` — the account it was created under
2. `Event.coupleApp.partners[].user` — the other partner
3. An **accepted, un-revoked** `SharedMember` whose `user` is the caller

Anyone else is refused. A `SharedMember` row that was invited and never opened
(`acceptedAt: null`), or one that was revoked, is **not** access.

---

## 2. Models: new, reused, and why

### New (8)

| Model | Why it is new |
|---|---|
| `Guest` | Nothing in this repo models a couple's guest list. Carries `phoneNormalised` — the indexed match key the website RSVP needs (invariant 4). |
| `Website` | New concept. It also owns the wedding's one **public identity, the slug**: both public routes (`/site/:slug`, `/registry/:slug`) resolve on this document, so the slug is unique across the collection. |
| `RegistryItem` | New. `funded` is a denormalised running total, moved in the contribution's transaction. |
| `RegistryFund` | New, and separate from `RegistryItem` rather than a flag on it: an item can be bought out (the `409 already_funded` the client expects), a fund cannot be over-subscribed into an error. |
| `Contribution` | New. § 06.1 sketches it as an embedded `contributions[]` array; it is a collection here because (a) the couple thanks **people**, not line items, so `PATCH /contributions/:id { thanked }` needs it addressable, and (b) group gifting grows the array without bound on a document every guest page-view reads. |
| `WalletTxn` | New, and **append-only with no stored balance** — see invariant 2. |
| `SharedMember` | New. `LeadTeamMember` and `VenueTeamMember` are Wedsy **staff** on a lead or a venue, keyed to an `Admin`. This is the bride's mother, with a `User` account, holding access to two sections of one wedding. |
| `CoupleTask` | New — see the note under `WeddingMilestone` below. |

Every one carries `weddingId` (ref `Event`) and is indexed on it.

### Reused

| Concept | What it uses | Reasoning |
|---|---|---|
| **Payments** | `models/Payment` | Already the row Razorpay writes, the CRM reads and the invoice is cut from. A second payments collection is the two-records-per-thing problem again. What it lacked was the *schedule* half of a couple-facing row, so **one additive optional sub-document** was added: `Payment.coupleApp = { weddingId, label, vendor, ref, dueDate, walletApplied, sourceKey }`. No existing field or default changed. `sourceKey` carries a unique sparse index — that is what makes the schedule generation idempotent. |
| **Décor drafts** | `Event.eventDays[]` + `PlanSnapshot` + `DecorTheme` | The couple's décor already lives on the Event day (`decorItems`, `packages`, `customItems`, `status.finalized`) and the published-to-couple view is already `PlanSnapshot` via the `routes/plan.js` internal seam. **`models/DecorDraft` is not this** — despite the name it is the A2S Pinterest→catalogue approval queue. Do not point the couple's décor at it. |
| **Store draft → quote** | `models/QuoteRequest` | § 06.3 is explicit that a sent store draft and a concierge pick converge on **one** pricing pipeline. `QuoteRequest` already is that pipeline (`userId`, `payload`, `status: pending/priced`), worked from the Store/CS queue. `POST /wedding/:id/store/draft/send` must create one of these, not open a second. |
| **Venues** | `models/Venue`, `VenueShortlist`, `VenueHold` | All three exist and are already the venue team's records. `VenueShortlist` is keyed by `crmEnquiryId` (a string, by binding decision) — the couple app reaches it through `Event.leadId`, and must not re-key it. |
| **Activity feed** | `models/ActivityLog` | Reused with its indexes and 400-day retention. Mapped as `entityType: "wedding"`, `entityId: String(weddingId)`. **`ActivityLog.actorId` is `ref: "Admin"`**, so it holds a Wedsy team member only; a partner, shared member or guest goes in `meta.actor` and `meta.actorType`. Writing a `User._id` into an Admin ref would populate to nothing. |
| **Team** | `LeadTeamMember` + `Admin` | The couple's team is the current roster on `Event.leadId` (`activeTo: null`). |
| **Tasks (read)** | `CoupleTask` ∪ `WeddingMilestone` | See below. |

### `Task` and `WeddingMilestone` — why `CoupleTask` exists anyway

- `models/Task` is an admin task (`category`, `deadline`), with **no wedding
  scope at all**. It cannot answer "whose?".
- `models/WeddingMilestone` is the AI/planner-authored **timeline** for an Event
  and is already rendered inside the CRM lead page
  (`leadPageV3.ListClientTasks`). Its `source` enum is `["AI","Custom"]`; it has
  no `remind`, no couple-side authorship, and its rows are *the team's plan for
  the couple*, not the couple's own reminders.

Widening it would bend a model the CRM reads. So: **`GET /wedding/:id/tasks`
returns the union** — `CoupleTask` rows (`source: "couple"`) and
`WeddingMilestone` rows (`source: "milestone"`, read-only) — and every
couple-app **write** lands on `CoupleTask`. The CRM's timeline is untouched.

### The registry note

`Website.registry = { intro, layout }` (§ 05.1 "A note from the couple", and the
grid/list choice). It sits on `Website` because it belongs to the registry *as a
page*, and `Website` is the document that owns that page's slug, palette and
font. § 05.1's "works on its own — no website needed" is honoured by the read
rule: **`/registry/:slug` resolves on a `Website` document whose `publishedAt`
is still null**; only `/site/:slug` requires `publishedAt`.

---

## 3. Permissions (§ 06.4)

`services/CouplePermissions.js` — pure, no mongoose, no express — is the whole
matrix. `middlewares/coupleAuth.js` is the only thing that mounts it.

```
router.get ("/:id/guests", CoupleAuth, RequireSection("guests", "view"),  …)
router.post("/:id/guests", CoupleAuth, RequireSection("guests", "edit"),  …)
router.post("/payments/:id/pay",       CoupleAuth, RequirePayout,         …)
```

### The matrix

| Caller | guests | website | decor | registry | payments | tasks | payouts |
|---|---|---|---|---|---|---|---|
| Partner (either) | edit | edit | edit | edit | edit | edit | **yes** |
| SharedMember | their `access.guests` | `access.website` | `access.decor` | `access.registry` | `access.payments` | `access.tasks` | **never** |
| Invited, not accepted | — | — | — | — | — | — | — (403 on the wedding itself) |
| Revoked | — | — | — | — | — | — | — (403, immediately) |
| Anyone else | 403 on the wedding |

Levels rank `none < view < edit`. An endpoint asks for what it needs; anything
above passes. **Fail closed**: an unknown section, an unknown level, a missing
member row and a value outside the enum all resolve to `none`.

### `edit` on payments never implies a payout — structurally

This is not a check that a call site could forget:

- The grantable sections are exactly six. `"payouts"` is not one of them.
- `SharedMember.access` has exactly six keys — there is **no seventh key** a
  payout right could be set in.
- `canInitiatePayout(couple)` takes **one argument** and reads no access map at
  all. It answers "is this one of the two people getting married".
- `RequirePayout` is mounted **instead of** `RequireSection("payments","edit")`
  on `POST /payments/:id/pay` and `POST /wedding/:id/wallet/claim`.

A shared family member with all six sections at `edit` may reschedule and
annotate payments, and cannot pay or claim. Asserted in
`tests/couple-permissions.test.js`.

### 401 vs 403

`wedsy-user`'s `read()` in `lib/plan/api.js` distinguishes them and both mean
"never substitute the seed":

- **401** `{ error: "unauthenticated", message }` — no token, a token that does
  not verify, or a token that is not a `User`'s (an admin or vendor token is
  refused here even though it verifies).
- **403** `{ error: "forbidden", section, required, held, message }` — a real
  signed-in person who is not on this wedding, or is and lacks the section.
  Payouts refuse with `{ error: "forbidden_payout", … }` so the client can word
  it properly.
- **400** a malformed wedding id. **404** a wedding that does not exist.

### The digest is narrowed too

Home summarises five sections, so it cannot be gated on one of them. Instead
`CoupleWeddingService.getHome` narrows its **contents** per section: a member
who cannot see payments gets no payment decision card, and `budgetPaid: null` —
**null, not 0**. Zero is a number they would believe.

---

## 4. The four invariants (§ 06.3)

All four are **pure functions over plain documents** in `services/`, unit-tested
with no database, and called from the controllers.

### 1 · Headcount — `services/CoupleHeadcountService.js`

`headcount = Σ guest.party where rsvp ≠ "no"`, computed server-side.

- `tally(guests)` → `{ invited, yes, no, pending, headcount }`.
  `invited` counts **invitations**; `headcount` counts **people**.
- `tallyForEvent(guests, key)` — the same rule narrowed to one function, so the
  planner's per-day expected guests is the guest list and not a second figure.
- A missing party is **1** (an invitation covers at least the person invited); a
  blank string is also 1 (`Number("")` is 0, and an empty form field is "they did
  not say"); a negative never subtracts from the room; an unrecognised `rsvp`
  counts, i.e. it fails toward feeding people.
- **Consumed by** Budget catering, the Home stat, the website RSVP tally and the
  Payments estimate. Never recomputed client-side.

### 2 · Registry → Wallet → Payments — `services/CoupleWalletService.js`

- **No stored balance anywhere.** `balance(txns)` is Σ settled credits and
  reversals − Σ settled debits and claims, floored at 0. A stored balance and a
  ledger are two numbers that eventually disagree, and the one that disagrees is
  the couple's money.
- `contributionWrites(...)` returns the `Contribution` **and** its `WalletTxn`
  **together**, so the controller writes both in one transaction. A contribution
  without its credit is money the couple cannot see.
- `contributionAmount(gift, "full")` is **re-derived** as price − funded, so two
  guests paying "in full" at once cannot both succeed — the second re-derives to
  0, which the controller turns into `409 already_funded`.
- `applyWallet(amountDue, walletBalance, useWallet)` — **three arguments, none
  of them a client amount.** `useWallet === true` (strictly; a truthy string does
  not count) applies `min(balance, due)`. When it covers the row there is no
  gateway intent at all.
- `claimWrite(...)` refuses more than the balance and refuses zero, as values,
  not exceptions. A claim sits `pending` for the 2–3 working days § 05.1
  promises — it leaves the balance on request and only returns if it fails.

### 3 · Décor finalise → Budget → Payments — `services/CoupleDecorFinaliseService.js`

- `committedTotal(event)` is **Σ `coupleApp.budget.lines[].amount`**. There is
  no `committed` field, so Home and the Budget tracker have nothing to drift
  between.
- `plan({ event, dayId, amount, … })` returns the budget line to **upsert** on
  `sourceKey: "decor:<dayId>"` and the payment rows to upsert on
  `"decor:<dayId>:<n>"`. Finalising twice lands on the same keys and changes
  nothing; `alreadyFinalised: true` comes back as a **value, not an error** — a
  couple who tapped twice has finalised, and the second answer should equal the
  first.
- Re-finalising at a different amount **replaces** the line rather than adding
  one.
- The default schedule (25% / 50% / 25%, at +7 days, 45 days out, 7 days out) is
  a **product decision** living in one function; the last row absorbs the
  rounding so the schedule sums to the committed amount exactly. A caller with a
  real schedule passes it in.
- `Payment.coupleApp.sourceKey` carries a unique sparse index, so idempotence
  survives two concurrent requests, not just two sequential ones.

### 4 · Website RSVP → Guests — `services/CoupleRsvpService.js`

- **Both sides normalised** through `utils/phone.normalisePhone` — this repo's
  one phone implementation, deliberately not re-implemented here. The couple
  types `"+91 98450 11223"`; the form posts `"+919845011223"`; a raw comparison
  creates a duplicate row, and a duplicate row is an extra party on the
  headcount, in the catering estimate and on the payment that feeds.
- A stored row with no `phoneNormalised` still matches — the column is an index,
  not the truth.
- Matched → update. Unmatched → create, with `source: "website"` so the Guests
  tab knows to ask which side they are, and with `phoneNormalised` written so
  the *next* reply matches.
- A second reply from a guest who already answered is `409 already_replied` —
  silently overwriting would let a stranger with a guessed number edit somebody
  else's party size.
- **Always** an `activity` object comes back, matched or not; it is built in one
  place so no branch can return without one.
- `response.headcount` is recomputed **with the reply applied**, from the same
  `CoupleHeadcountService` every other screen uses.

### Also: activity and decisions

- `services/CoupleActivityService.js` — `buildLog` (pure) maps a couple-app
  action onto `ActivityLog`; `toDigest(logs, viewerId, 4)` produces Home's
  "While you were away" with `unread = !readBy.includes(me)`.
- `services/CoupleDecisionsService.js` — `candidates(...)` generates decision
  cards from the wedding's state (décor priced / needs input, unreacted venue
  holds, payments due within a fortnight, overdue tasks); `rank(...)` keeps only
  the blocking ones, orders by urgency then by irreversibility, **caps at 3**,
  and stamps `position` and `variant`. `openCount` — what the top bar's pill
  shows — is **every** blocking item, not the capped three.

---

## 5. Endpoints

### Built

| Endpoint | Notes |
|---|---|
| `GET /wedding/:id` | Wedding + `events[]` (from `Event.eventDays`) + `team[]` + `viewer` (`role`, `access` map, `canInitiatePayout`). Matches `api.wedding()`. |
| `GET /wedding/:id/home` | `{ decisions[] (≤3), activity[] (4), stats }`. Matches `api.home()`. |

Routes: `routes/coupleApp.js`, mounted at `/wedding` in `routes/router.js`.
Controller: `controllers/coupleApp.js` (every handler wrapped in try/catch).
Service: `services/CoupleWeddingService.js`.

### Still to build

Every one needs `CoupleAuth` + the section gate named, and a try/catch.

| Endpoint | Section / level | Contract notes |
|---|---|---|
| `PATCH /wedding/:id` | — (partner only) | Couple details, `coupleApp` fields. |
| `GET /wedding/:id/guests` `?side&rsvp&event&q` | guests / view | Returns the Guest rows as the client shapes them. |
| `POST /wedding/:id/guests` | guests / edit | Must write `phoneNormalised`. |
| `PATCH /guests/:id` | guests / edit | Resolve `weddingId` **from the document**, then `resolveMembership` — the URL does not carry it. Re-derive `phoneNormalised` on a phone edit. |
| `DELETE /guests/:id` | guests / edit | |
| `GET /wedding/:id/guests/headcount` | guests / view | `CoupleHeadcountService.tally`. |
| `GET /wedding/:id/venues` | decor / view | Concierge shortlist + holds, via `Event.leadId` → `VenueShortlist`. |
| `POST /venues/:id/react` | decor / edit | `{ reaction: "love"\|"maybe"\|"pass" }` — note `VenueShortlist.items.reaction` stores `"no"`, not `"pass"`; map at the seam. |
| `POST /venues/:id/offer/accept` | decor / edit | |
| `GET /wedding/:id/decor` | decor / view | Per-day drafts + state. `decorStatus` is derived (`CoupleWeddingService.decorStateOf`) — **`"needs_input"` is the one enum value nothing on the Event records yet**; these endpoints must supply it. |
| `POST /decor/:id/heart` | decor / edit | `{ themeId \| productId }` |
| `POST /decor/:id/select-tier` | decor / edit | `{ tier }` |
| `POST /decor/:id/finalise` | decor / edit | Irreversible; requires the hold-confirm. Calls `CoupleDecorFinaliseService.plan` and upserts both sets of rows in one transaction. |
| `GET /wedding/:id/store/draft` | decor / view | |
| `POST /wedding/:id/store/draft/items` | decor / edit | |
| `POST /wedding/:id/store/draft/send` | decor / edit | Creates a **`QuoteRequest`**, not a second pipeline (§ 06.3). |
| `GET /wedding/:id/budget` | decor / view | `committed` = `committedTotal(event)`. |
| `POST /wedding/:id/budget/estimate` | decor / edit | Stores the wizard's answers in `coupleApp.budget.estimateAnswers`. |
| `PUT /wedding/:id/budget/target` | decor / edit | |
| `GET /wedding/:id/website` | website / view | Never serialise `privacy.password`. |
| `PUT /wedding/:id/website` | website / edit | theme, palette, font, sections |
| `PUT /wedding/:id/website/content` | website / edit | `{ blockId: value }`, debounced client-side |
| `POST /wedding/:id/website/photos` | website / edit | multipart → `{ slotId, mediaId }` |
| `GET /wedding/:id/website/slug/check?slug=` | website / view | Unique across the `Website` collection. |
| `POST /wedding/:id/website/publish` | website / edit | Stamps `publishedAt`. |
| `GET /wedding/:id/registry` | registry / view | Items + funds + contributions + `intro`. |
| `POST /wedding/:id/registry/fetch-link` | registry / edit | `{ url }` → `{ image, title, price, source, sourceUrl }` — **every field optional**; a missing price and image are the normal case. |
| `POST /wedding/:id/registry/items` | registry / edit | |
| `PATCH /registry-items/:id` | registry / edit | pin, price, title, image |
| `DELETE /registry-items/:id` | registry / edit | Archive (`archivedAt`) once money has arrived against it. |
| `POST /wedding/:id/registry/funds` | registry / edit | |
| `GET /wedding/:id/wallet` | registry / view + payments / view | Balance from the ledger. |
| `POST /wedding/:id/wallet/claim` | **`RequirePayout`** | Never a section gate. |
| `GET /wedding/:id/payments` | payments / view | |
| `POST /payments/:id/pay` | **`RequirePayout`** | `{ method, useWallet: boolean }` → gateway intent. Server computes the offset. |
| `GET /wedding/:id/tasks` | tasks / view | The `CoupleTask` ∪ `WeddingMilestone` union. |
| `POST /wedding/:id/tasks` | tasks / edit | Writes `CoupleTask`. |
| `PATCH /tasks/:id`, `DELETE /tasks/:id` | tasks / edit | `weddingId` from the document. Refuse a `WeddingMilestone` id — those are the team's. |
| `GET /wedding/:id/members` | — (partner only) | |
| `POST /wedding/:id/members` | — (partner only) | `{ name, relation, access }` |
| `PATCH /members/:id`, `DELETE /members/:id` | — (partner only) | Removal sets `revokedAt`, never a hard delete. |

### Public, unauthenticated — and rate-limited (§ 06.4)

| Endpoint | Contract |
|---|---|
| `GET /site/:slug` | SSR. Honour `privacy.linkOnly` (`noindex`). `privacy.password` **never crosses the wire** — send `privacy.passwordRequired: boolean`. When protected and unlocked-token-less, return only `slug`, `publishedAt`, `themeId`, `paletteId`, `fontId`, `privacy`, `wedding.partners`. |
| `POST /site/:slug/rsvp` | `{ name, phone, attending, events[], party, note }` → `200 { ok, matched, guestId, rsvp, party, headcount }`, `409 already_replied`, `422 validation`, `429 rate_limited`. `CoupleRsvpService.applyRsvp` returns every one of those bodies. |
| `POST /site/:slug/unlock` | § 04.10. `{ password }` → `200 { ok: true }` / `401 { ok: false }` / 429. `bcrypt.compare` server-side; called only from the Next API route. |
| `GET /registry/:slug` | Public registry view — resolves on the `Website` slug **regardless of `publishedAt`**. |
| `POST /registry/:slug/contribute` | `{ itemId\|fundId, amount, mode, guest }` → `200 { ok, contributionId, amount, walletCredited, gift }`, `409 already_funded`, `422`, `429`. Contribution + `WalletTxn` + `Activity` in **one transaction**. |

### Not in § 06.2 at all — named by the finished frontend

These are backend work, not design choices. Each is marked `⛏ STUB` or
`⛏ CONTRACT ADDITION` at its call site in `wedsy-user/lib/plan/api.js`.

| Endpoint | Why the client needs it |
|---|---|
| `GET /venues?<filters>` | The venue **marketplace** — § 06.2's `/wedding/:id/venues` is only the concierge shortlist. A real `/venues` route already exists on this server with its own shape; the client normalises it (`lib/plan/normalise.js`). |
| `POST /venues/:id/enquire` | The couple enquiring directly, outside the concierge thread. |
| `GET /wedding/:id/makeup` | The whole makeup bidding model (§ 3.5) is absent from § 06.2. Returns `{ brief, bids[], trial, artists[] }`. `models/Bidding`, `BiddingBid`, `BiddingBooking` already exist — this is a couple-facing read over them. |
| `PUT /wedding/:id/makeup/brief` | The brief the couple posts. |
| `POST /makeup-bids/:id/accept` | Accepting a bid (and the trial booking that follows). |
| `GET /wedding/:id/store/catalogue` | § 06.2 defines only the draft. The server owns the category list, the products and their starting prices. |
| `DELETE /wedding/:id/store/draft/items/:itemId` | Removing one item. |
| `PATCH /wedding/:id/registry` `{ intro }` | The couple's note above their gifts (§ 05.1). Belongs to the registry, not the website — a couple can share the registry with no website published. |
| `PATCH /registry-funds/:id`, `DELETE /registry-funds/:id` | § 06.2 lists only the POST. A fund the couple cannot rename or retire is a fund they will not create. |
| `PATCH /contributions/:id` `{ thanked }` | § 06.1 hangs `thanked` off `RegistryItem`; one gift can carry several contributions from several people, and the couple thanks **people**. |

---

## 6. Notifications

**None were added in this milestone.** Per the project's hard rules,
notifications are **TRIGGERS ONLY**, all through
`services/NotificationService.js`, and WhatsApp is **Meta Cloud API only —
never Aisensy**. Read the Notification System spec in Notion before adding any
of these.

Where one belongs, a marked comment names it. The triggers this feature will
need, when it is time:

| Moment | Proposed trigger |
|---|---|
| A shared member is invited | `couple_member_invite` — the invite link |
| A guest RSVPs | (couple-side digest, not per-reply — an in-app Activity already covers it) |
| A contribution arrives | `couple_registry_gift` |
| A wallet claim is requested / settles | `couple_wallet_claim` |
| A payment falls due | reuse the existing `event_pmnt_rmnd` family rather than a new one |
| `CoupleTask.remind` | `couple_task_remind` — the flag is stored; nothing sends it yet |

---

## 7. Untested seams

Honest list. See § 8 for what *is* tested.

- **Everything that needs a database.** There is no MongoDB in the build
  container, so the two integration tests
  (`tests/couple-auth-membership.int.test.js`,
  `tests/couple-wedding-home.int.test.js`) were written and **not run**. They
  need `DATABASE_URL` pointed at a **dev** database (rule 7: never production).
- **The `Payment.coupleApp.sourceKey` unique index** — its behaviour under two
  concurrent finalises is asserted by design, not by a test.
- **Transactionality.** The invariant services return the documents to write
  together; that the controllers actually write them in one MongoDB transaction
  is a property of endpoints not yet built.
- **`GET /wedding/:id` team block.** `blurb`, `quote`, `presence` and
  `responseTime` (§ 03.1) have nowhere to live yet and come back empty/null
  rather than invented.
- **`decorStatus: "needs_input"`** is not derivable from the Event; a day
  needing a palette currently reads as `"drafted"`, which understates it rather
  than inventing it.

## 8. Tests

Pure, no database — **these run and pass**:

```
node tests/couple-headcount.test.js        # invariant 1
node tests/couple-wallet-ledger.test.js    # invariant 2
node tests/couple-decor-finalise.test.js   # invariant 3
node tests/couple-rsvp-match.test.js       # invariant 4
node tests/couple-permissions.test.js      # § 06.4, the whole matrix
node tests/couple-decisions-rank.test.js   # § 06.3 decisions
node tests/couple-activity-digest.test.js  # § 06.3 activity feed
```

Integration, **need a dev database, not yet run**:

```
node tests/couple-auth-membership.int.test.js
node tests/couple-wedding-home.int.test.js
```
