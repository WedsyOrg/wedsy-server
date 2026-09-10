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

---

# People — guests, tasks and family sharing

*Appended by the people milestone. Nothing above this line was edited.*

Files owned by this milestone:

```
routes/coupleApp-people.js          the routes and their gates
controllers/coupleAppPeople.js      thirteen handlers, each wrapped
services/CouplePeopleRules.js       PURE — filters, validation, shaping, denials
services/CoupleGuestService.js      the guest list
services/CoupleTaskService.js       the union, and the writes that stay on one side of it
services/CoupleMemberService.js     family sharing
```

## P1 · Endpoints and their gates

| Endpoint | Gate | Notes |
|---|---|---|
| `GET /wedding/:id/guests` `?side&rsvp&event&q` | `guests / view` | Returns a **bare array** — `api.guests()` reads `res.data` as one. |
| `POST /wedding/:id/guests` | `guests / edit` | `201` + the created row. Writes `phoneNormalised`. |
| `PATCH /guests/:id` | `guests / edit` | `weddingId` from the document. |
| `DELETE /guests/:id` | `guests / edit` | |
| `GET /wedding/:id/guests/headcount` | `guests / view` | `{ invited, yes, no, pending, headcount }`, unfiltered. |
| `GET /wedding/:id/tasks` | `tasks / view` | `CoupleTask ∪ WeddingMilestone`. Bare array. |
| `POST /wedding/:id/tasks` | `tasks / edit` | Always a `CoupleTask`. |
| `PATCH /tasks/:id` | `tasks / edit` + `RefuseMilestone` | |
| `DELETE /tasks/:id` | `tasks / edit` + `RefuseMilestone` | |
| `GET /wedding/:id/members` | **`RequirePartner`** | Bare array. Revoked members are not on it. |
| `POST /wedding/:id/members` | **`RequirePartner`** | `{ name, relation, access }` |
| `PATCH /members/:id` | **`RequirePartner`** | |
| `DELETE /members/:id` | **`RequirePartner`** | Sets `revokedAt`. Never a hard delete. |

`RequirePartner` lives in `routes/coupleApp-people.js` and its body comes from
`CouplePeopleRules.partnerDenial()`. It is mounted **instead of**
`RequireSection`, exactly as `RequirePayout` is — and for the same structural
reason: `"members"` is not one of the six grantable sections, `SharedMember.access`
has no key for it, and `accessMapFrom` emits six keys and never a seventh. A
member with all six sections at `edit` cannot invite anybody, cannot raise their
own access, and cannot revoke the person who let them in. Asserted in
`tests/couple-people-permissions.test.js` and `tests/couple-member-access.test.js`.

### Refusal bodies

Unchanged from § 3. `401 { error: "unauthenticated", message }` for a missing or
invalid token; `403 { error: "forbidden", section, required, held, message }` for
a real person without the section — including the members gate
(`section: "members"`, `required: "partner"`) and a write aimed at the CRM's
timeline (`section: "tasks"`, and a message that says whose row it is).
Validation is `422 { error: "validation", fields: { … } }` and the duplicate
guards are `409 { error: "duplicate_guest" | "duplicate_member", guestId | memberId }`.

## P2 · The invariants are called, never reimplemented

| Invariant | Where it is called |
|---|---|
| **Headcount** (§ 06.3 #1) | `CoupleGuestService.headcount` is four lines: read the wedding's guests, hand them to `CoupleHeadcountService.tally`, answer. `guestFields`' "a missing party is 1" mirrors the same rule at the door, and nothing anywhere in these files sums `party`. `tests/couple-guests-tasks.int.test.js` asserts the endpoint and the service agree over the same rows. |
| **Phone match** (§ 06.3 #4) | `CoupleGuestService.assertNotDuplicate` calls `CoupleRsvpService.matchGuest`, which calls `utils/phone.normalisePhone`. Typed, imported and website-posted guests therefore collide on the one rule — including a stored row that predates `phoneNormalised`. A phone edit re-derives the key so the *next* website reply still matches. |
| **Events defined once** (§ 06.3) | `CoupleGuestService.eventKeysOf` derives the wedding's function keys through `CoupleWeddingService.dayKey`, and a guest cannot be invited to a function this wedding does not have. |
| **Activity** (§ 06.3) | Every mutation goes through `CoupleActivityService.record`: `guest.added`, `guest.rsvp`, `guest.removed`, `task.added`, `task.completed`, `task.reopened`, `task.removed`, `member.invited`, `member.access`, `member.removed`. A partner or member's identity rides in `meta.actor` — `ActivityLog.actorId` is `ref: "Admin"` and stays null. A party size nudged by one is deliberately **not** logged; four of those crowd the venue out of the digest. |
| **Task shaping** | `CoupleTaskService.unite` calls `CoupleWeddingService.shapeTask` / `shapeMilestone`, the same two Home renders its task card with. |

## P3 · The tasks union, and why the CRM's timeline is safe

`GET /wedding/:id/tasks` returns both collections. `CoupleTask` rows carry
`source: "couple"`, `readOnly: false`; `WeddingMilestone` rows carry
`source: "milestone"`, `readOnly: true`, `createdBy: "Your planner"`.

`readOnly` is a **courtesy, not the control**. The control is that no line in
any file this milestone owns aims a write verb at `WeddingMilestone`:
`tests/couple-tasks-union.test.js` reads the six source files and asserts it,
in the manner of `tests/objectid-strict.test.js`. The only two calls that exist
are `WeddingMilestone.find` (the union) and `WeddingMilestone.findById` (so the
refusal can name the row instead of 404ing something the couple can see).

`RefuseMilestone` is mounted **after** `CoupleAuth` and `RequireSection`. A
stranger is refused on the wedding first and never learns the row exists; only a
member who really can edit tasks is told whose task it is.

`createdBy` is the one viewer-relative field in the whole feature: it reads
`"you"` to its own author and the author's real name to the other partner,
because `Tasks.js` hides the attribution line when it reads `"you"`. What is
**stored** is always the real name — the client's `createdBy: "you"` is a
rendering and is never written.

## P4 · Child-resource routes, and the one line `routes/router.js` still needs

`PATCH /guests/:id`, `/tasks/:id` and `/members/:id` carry no wedding id.
`FromDocument(load, message)` loads the row, rewrites `req.params.id` to the
`weddingId` **on the document**, and hands over to the ordinary `CoupleAuth` —
so these routes run the *same* membership test as every other route, not a
second one. It refuses a missing token **before** the lookup, so the route
cannot be used to probe which ids exist.

**The mounting gap.** `wedsy-user`'s `lib/plan/api.js` calls these at the API
root (`PATCH /guests/:id`), and `routes/coupleApp` is mounted at `/wedding`, so
today they answer at `/wedding/guests/:id`. `routes/router.js` was out of scope
for this milestone, so the child routes are exported separately:

```js
// routes/router.js — one line, next to the existing /wedding mount
router.use("/", require("./coupleApp-people").itemRoutes);
```

That serves the client's exact paths and touches nothing else. **The same gap
applies to every other root-level path the client names** — `/registry-items/:id`,
`/registry-funds/:id`, `/contributions/:id`, `/payments/:id/pay`,
`/decor/:id/heart`, `/venues/:id/react`, `/makeup-bids/:id/accept` — so this is a
merge-time decision for the whole couple app, not a people-only one.

## P5 · Family sharing, in detail

- **Relation** must be one of the seventeen presets, matched case-insensitively
  and stored in the list's own spelling. `models/SharedMember` allows free text
  and **this endpoint does not**: `You.js` renders a chip picker over exactly
  those seventeen and compares `form.relation === r`, so a value outside the
  list would render as no chip selected — an invitation the couple cannot then
  edit.
- **Access** is always exactly six keys, each `none | view | edit`. A key that
  was not sent is `none`, so a partial map can only ever *reduce* what a member
  holds. An unknown key is not an error to work around; it simply has nowhere to
  go. An invitation with no `access` at all gets § 05.5's default — guest list at
  `view`, everything else `none`.
- **Removal is `revokedAt`**, never a delete: their Activity rows still name
  them, and `CouplePermissions.isActiveMember` refuses them on their very next
  request.
- **`inviteTokenHash` never crosses the wire**, hashed or not (`select: false`
  on the model, and `shapeMember` does not carry it).

## P6 · Notifications

**None were added.** Triggers only, through `services/NotificationService.js`,
WhatsApp via the Meta Cloud API — never Aisensy — after the Notification System
spec in Notion. Two marked comments name the ones this feature wants:

| Moment | Trigger | Marked at |
|---|---|---|
| A shared member is invited | `couple_member_invite` — the invite link | `CoupleMemberService.create` |
| `CoupleTask.remind` comes due | `couple_task_remind` — the flag is stored, nothing sends it | `CoupleTaskService.create` |

The one-time token that invite link needs is deliberately **not minted** either:
a credential with nothing to deliver it is a credential nobody revokes.

## P7 · Contracts the client names that this milestone could not fully satisfy

1. **Root-level child paths.** See P4. Reachable at `/wedding/guests/:id` today;
   one line in `routes/router.js` gives the client's own paths.
2. **A member has no way to accept.** § 05.5's invite form posts `{ name,
   relation, access }` and nothing else — no phone, no email. `SharedMember.user`
   is therefore null, `acceptedAt` stays null, and
   `CouplePermissions.isActiveMember` correctly refuses them. `POST
   /wedding/:id/members` accepts an optional `phone` when a caller sends one, but
   **there is no accept endpoint in this milestone**, so the loop closes only
   when the invite trigger and its accept route are built together. The
   integration test binds the account directly to exercise the rest of the loop.
   (There is deliberately no `email`: the model has no such field, and a value
   mongoose would silently drop is worse than one the API never promised.)
3. **`Tasks.js` offers its controls on every row.** The milestone half now comes
   back with `readOnly: true`, but the finished screen does not read that flag
   yet: toggling a planner's milestone optimistically flips the row, gets the
   403, and rolls back with the generic error copy. Correct, and one line of
   client work away from being graceful.
4. **`?side&rsvp&event&q` is server-side and the screen filters locally anyway.**
   `Guests.js` fetches the unfiltered list and narrows it in a `useMemo`. The
   query is implemented, tested and faithful to what the box does; nothing calls
   it yet.
5. **A guest's `group` is free text.** § 05.2 shows a fixed-ish list
   (`Family | Friends | Work | …`); the client sends whatever the couple typed,
   and the server stores it. No enum was invented for it.

## P8 · Tests

Pure, no database — **these run and pass**:

```
node tests/couple-guest-filter.test.js        # 77 assertions — the ?side&rsvp&event&q filter and the guest body
node tests/couple-tasks-union.test.js         # 43 — the union, its ordering, and source-level write isolation
node tests/couple-member-access.test.js       # 86 — six sections, three levels, seventeen relations, fail closed
node tests/couple-people-permissions.test.js  # 170 — every refusal path, through the REAL middlewares
```

Integration, **need a dev database (`DATABASE_URL`, never production — rule 7),
and were not run**:

```
node tests/couple-guests-tasks.int.test.js    # the filter as mongo executes it, the duplicate guard,
                                              # headcount agreement, and the milestone left byte-for-byte intact
node tests/couple-members-sharing.int.test.js # the whole sharing loop: grant → the door opens → narrow →
                                              # it closes on the next request → revoke → they stop resolving
```

Both integration files mount the real app the way `routes/router.js` does, plus
`itemRoutes` at the root, and drive it over HTTP.

## P9 · Untested seams (honest list)

- **Everything that needs a database**, as above.
- **Concurrency on the duplicate guard.** `assertNotDuplicate` is a read then a
  write. Two simultaneous `POST /wedding/:id/guests` with the same number can
  both pass the read. `Guest` has `{ weddingId, phoneNormalised }` as a plain
  index, not a unique one, and making it unique is a migration this milestone
  did not take — an existing wedding may already hold duplicates, and a unique
  index would fail to build against them. The same is true of the member guard.
- **Transactionality.** None of these endpoints writes two collections at once,
  so none needs a transaction; the Activity append is deliberately fire-and-safe
  (`ActivityLogService` swallows its own failures) so a feed row that cannot be
  written never fails the couple's write.
- **`?q=` collation.** The search is a case-insensitive regex, so it is not
  accent- or transliteration-aware: "Meera" does not find "Mīra". No index
  serves it either — acceptable at a guest list's size, wrong at a mailing
  list's.

---

# Website — the builder, the public site and the guest RSVP

*Appended by the website milestone. Nothing above this line was edited.*

Files owned by this milestone:

```
routes/coupleApp-website.js         the six couple routes and the three public ones
controllers/coupleAppWebsite.js     nine handlers, each wrapped
services/CoupleWebsiteRules.js      PURE — the withholding rule, the slug, the settings whitelist, the unlock token
services/CoupleWebsiteService.js    the couple's builder: settings, content, photographs, slug, publish
services/CouplePublicSiteService.js the guest's door: the public read, the password compare, the RSVP
utils/coupleSiteRateLimit.js        § 06.4's rate limits, keyed on IP AND slug
```

No model was changed. `models/Website` already carried everything this needed,
including the sparse-unique `slug` index the whole design rests on.

## W1 · Endpoints and their gates

| Endpoint | Gate | Notes |
|---|---|---|
| `GET /wedding/:id/website` | `website / view` | Creates the document on first read, with **no slug**. Never serialises `privacy.password`. |
| `PUT /wedding/:id/website` | `website / edit` | `{ themeId, paletteId, fontId, sections, slug, privacy }`. `409 slug_taken` comes from the **index**. |
| `PUT /wedding/:id/website/content` | `website / edit` | Two shapes — see W4. |
| `POST /wedding/:id/website/photos` | `website / edit` | multipart → `{ slotId, mediaId, url, original }`. `201`. |
| `GET /wedding/:id/website/slug/check?slug=` | `website / view` | `{ available, slug, reason, message }`. A **courtesy**, not the control. |
| `POST /wedding/:id/website/publish` | `website / edit` | Stamps `publishedAt`. Idempotent: `alreadyPublished: true` is a value, not an error. |
| `GET /site/:slug` | **none — public** | SSR read. Withholds (W2). Sends `X-Robots-Tag: noindex, nofollow` itself. |
| `POST /site/:slug/rsvp` | **none — public, rate-limited** | `CoupleRsvpService.applyRsvp` decides everything. |
| `POST /site/:slug/unlock` | **none — public, rate-limited** | `bcrypt.compare` server-side; mints the token `GET` accepts. |

The three public routes are exported as `.itemRoutes` and mounted at the API
root by `routes/router.js` (that line already exists), so a guest's link is
`/site/:slug` and not `/wedding/site/:slug`.

Refusal bodies are unchanged from § 3: `401 { error: "unauthenticated" }`,
`403 { error: "forbidden", section: "website", required, held, message }`,
`422 { error: "validation", fields }`, `409 { error: "slug_taken" | "already_replied", … }`,
`404 { error: "not_found" }`, `429 { error: "rate_limited", retryAfter }`.

## W2 · The withholding rule — the security-critical piece

§ 06.4 and the `⛏ STUB` in `wedsy-user/lib/plan/api-public.js`: a
password-protected site that has not proved an unlock gets **exactly seven
keys** —

```
slug, publishedAt, themeId, paletteId, fontId, privacy, wedding.partners
```

— and `content`, `photos`, `events`, `registry` and `sections` are **not put in
the object at all**. Not emptied, not nulled, not stripped afterwards.

Three things make that hold rather than merely happen:

1. **One function builds the body.** `CoupleWebsiteRules.publicPayload` is the
   only thing that can produce a public response, and the withholding branch
   `return`s the shell before the full object is ever constructed.
   `tests/couple-site-rsvp-seam.test.js` reads the source and asserts
   `publicPayload` is called **exactly once** in the whole milestone, and never
   from the controller or the route.
2. **The query does not happen.** `CouplePublicSiteService.site` only reads the
   registry when it is going to be sent. A locked visitor's request never
   touches `RegistryItem`.
3. **The test asserts absence, not emptiness.**
   `tests/couple-site-withholding.test.js` checks `!(key in body)` for all five
   withheld keys, then checks that no word the couple typed, no venue, no
   function name, no gift, no phone, no email and not even the city appears
   anywhere in `JSON.stringify(body)`. `tests/couple-public-site.int.test.js`
   repeats it on the **raw HTTP text**.

**An unpublished site is withheld the same way**, and for the same reason: a
draft the couple has not sent out is not a draft a stranger who guessed the
address may read. It returns `200` with `publishedAt: null` rather than a 404
because the client renders "not out yet" and "no such address" as two different
pages — an unknown slug is the 404.

**The password never crosses the wire.** `privacy.password` is a bcrypt hash,
`select: false` on the model, loaded only where `bcrypt.compare` needs it, and
read by `isGated` for its **length** and nothing else. Every response carries
`privacy: { linkOnly, passwordRequired }` — two booleans, no third key. Asserted
on the locked body, the unlocked body and the couple's own read.

**`noindex` is the server's answer.** The response carries `privacy.linkOnly`
and `privacy.passwordRequired` so the page has the state it needs, *and* the
route sets `X-Robots-Tag: noindex, nofollow` whenever the site is link-only,
gated or unpublished — the header a crawler that never runs JavaScript obeys.
A gated site is also `Cache-Control: private, no-store, must-revalidate` with
`Vary: Cookie, X-Site-Unlock`, so one guest's unlock cannot become everybody's
at the edge.

### The unlock token

§ 06.2 never defined `POST /site/:slug/unlock`; the contract is in
`api-public.js`. It answers `200 { ok: true, unlockToken, expiresAt }` /
`401 { ok: false }`, and additionally sets an httpOnly, `SameSite=Lax`,
per-slug cookie.

The token is `<expiry>.<hmac(slug.expiry)>` signed with `SITE_UNLOCK_SECRET`,
falling back to `JWT_SECRET`. It is not the password, it names the slug it was
minted for (unlocking one wedding never unlocks another — asserted twice), and
its expiry is inside the signed payload so a holder cannot push it forward.
**With no secret configured nothing verifies**, so a misconfigured deploy leaves
a gated site shut rather than opening it. `GET /site/:slug` accepts the proof
from three doors: `X-Site-Unlock`, `?unlock=`, or the cookie.

## W3 · The RSVP invariant is called, never reimplemented

| Invariant | Where it is called |
|---|---|
| **Phone match** (§ 06.3 #4) | `CouplePublicSiteService.rsvp` reads the wedding's guests, derives the function keys through `CoupleWeddingService.dayKey`, and hands the lot to `CoupleRsvpService.applyRsvp`. It then writes the `update` or the `create` it was given. There is **no phone comparison, no normalisation and no matching branch** in any file this milestone owns — `tests/couple-site-rsvp-seam.test.js` reads all six source files and asserts that no `normalisePhone` call, no digit-stripping regex and no literal country code exists in any of them. |
| **Headcount** (§ 06.3 #1) | `response.headcount` is whatever `applyRsvp` computed from `CoupleHeadcountService.tally` **with the reply applied**. No file here sums a `party`; the seam test asserts that too, in both directions and through `reduce`. |
| **Activity** (§ 06.3) | The `activityService.record` call sits **outside** the create/update branch, so no path can write a guest without appending a feed row. `actorType: "guest"`, `actorId: null` — `ActivityLog.actorId` is an `Admin` ref and a guest is not one. |
| **Events defined once** | The keys a guest may reply for come from `Event.eventDays` through `dayKey`; a function this wedding does not have is dropped by `cleanEvents`. |

## W4 · Content, photographs and the theme switch

§ 04.10: *content keyed by `slotId`/`blockId`, **never** by theme.*

That is true here **by construction, not by care**:
`CoupleWebsiteRules.settingsPatch` — the only thing that builds the patch
`PUT /wedding/:id/website` writes — emits keys drawn from a fixed set that does
not include `content` or `photos`, and ignores them if a caller sends them.
A theme switch therefore *cannot* disturb a word the couple typed. Asserted
purely (the patch has no such key, and a stored document is byte-identical
across a switch) and again over a real database in the integration test.

`PUT /wedding/:id/website/content` takes two shapes, because the client sends
one and the brief names the other:

- `{ content, photos }` — the builder's actual save (`Microsite.saveContent`).
  The maps are **replaced**, because the builder holds the whole map and
  `delete next[slotId]` is how a photograph is cleared; a merge would make
  clearing impossible.
- `{ blockId: value }` — a bare debounced map. **Merged**, and an explicit
  `null` or `""` deletes that block.

A photo slot holds either the URL string the builder sets or the
`{ url, mediaId, original }` record the upload writes — the two shapes
`LandingPage` documents (`string | {url}`) and `photoPath()` already reads.

### The image pipeline, honestly

`POST /wedding/:id/website/photos` goes through **this repo's existing S3 path**
(`utils/s3Upload`, the same env vars, endpoint override included) — not a
second one. It stores:

- the **original**, byte for byte, at `couple-website/<weddingId>/<mediaId>-original.<ext>` — this is what a re-crop reads when the theme changes (§ 04.10);
- a **WebP derivative** capped at 2400px on its long side, EXIF-rotated, at `…/<mediaId>.webp` — this is what the slot points at.

`MEDIA_CDN_BASE`, when the deploy sets one, rewrites the returned origin; there
is no hardcoded host (rule 3). If `sharp` cannot read a format the slot falls
back to the original rather than losing the couple's photograph.

**What is NOT done: the resize to the slot's aspect.** The slot → aspect table
is a fact of the theme layer and lives in `wedsy-user/lib/plan/website/themes`,
not on this server. Cropping to a guessed aspect cuts a face out of a
photograph. The original is stored precisely so that crop can be added later,
once the table is shared. `mediaId` is a real id (a fresh `ObjectId`), not a
placeholder.

## W5 · Slug uniqueness is the index

`Website.slug` carries `{ unique: true, sparse: true }` on the model the
foundation wrote. `applySettings` **attempts the write and catches E11000**;
that is what becomes `409 slug_taken`. There is deliberately no read-then-write
check in the write path — two couples typing the same address in the same
second both pass a `findOne` and one of them silently loses it.

`GET …/slug/check` does read, and the code says in as many words that it is a
**courtesy to the typist** and cannot make an address safe to take.

Normalisation is one function: `"Ananya & Vikram"` → `ananya-vikram`, NFKD-folded
so `Mīra` becomes `mira`, 3–60 characters, with a short reserved list (the
routes wedsy.in already answers on) and a refusal of any 24-hex string, which
would shadow every `/:id` route on this API.

## W6 · The rate limiter's real scope

Both public POSTs are limited (§ 06.4), and so is the public read:

| Route | Default | Env |
|---|---|---|
| `POST /site/:slug/rsvp` | 20 / hour | `SITE_RSVP_WINDOW_MS`, `SITE_RSVP_MAX` |
| `POST /site/:slug/unlock` | 10 / 10 min, `skipSuccessfulRequests` | `SITE_UNLOCK_WINDOW_MS`, `SITE_UNLOCK_MAX` |
| `GET /site/:slug` | 120 / min | `SITE_READ_WINDOW_MS`, `SITE_READ_MAX` |

The key is **IP *and* slug** (`ipKeyGenerator(req.ip) + ":" + slug`). IP alone
would let one family behind a NAT spend another wedding's budget; slug alone
would let an attacker lock a wedding's real guests out of replying.
`ipKeyGenerator` is express-rate-limit's IPv6-safe bucketing — a raw `req.ip`
keys every address in a /64 separately, which is no limit at all.

**Honestly: the store is express-rate-limit's default MEMORY STORE, so the
limiter is PER-INSTANCE.** Behind two Node processes the effective ceiling is
2×, and a restart forgives everything. That is acceptable for an RSVP form (the
point is to blunt a script, not to be a quota). It is **not** good enough for
the unlock endpoint the day this server runs more than one instance — that one
wants a shared store (Redis) before the guest password is relied on for
anything that matters. Recorded here rather than left to be found during an
incident.

## W7 · Notifications

**None were added.** Triggers only, through `services/NotificationService.js`,
WhatsApp via the Meta Cloud API — never Aisensy — after the Notification System
spec in Notion. Two marked comments name the ones this feature wants:

| Moment | Trigger | Marked at |
|---|---|---|
| The couple publishes their website | `couple_website_published` — the link, to the couple | `CoupleWebsiteService.publish` |
| A guest RSVPs | a couple-side **digest**, not one message per reply — the in-app Activity already covers the individual one | `CouplePublicSiteService.rsvp` |

## W8 · Client contracts this milestone could not fully satisfy

1. **The SSR route does not forward the unlock proof.** `pages/site/[slug].js`
   calls `siteApi.site(slug)` with no token, header or cookie, and enforces the
   gate with its **own** HMAC cookie minted in `lib/plan/site-gate.js`. With the
   real endpoint live, a gated site therefore renders its gate correctly and
   then, once unlocked, still receives the withheld shell — because this server
   was never told about the unlock. The server side is complete and accepts the
   proof three ways; the client change is one line in `getServerSideProps`
   (forward `X-Site-Unlock` from the value `siteApi.unlock` returns, or from the
   cookie). Deliberately **not** made here: `wedsy-user` is another repo and
   another milestone.
2. **A gated site's RSVP is not itself gated.** `components/site/RsvpForm.js`
   posts with no unlock proof of any kind, so requiring one would break every
   gated wedding's reply form. `POST /site/:slug/rsvp` therefore checks that the
   site exists and is published, and relies on the controls that are actually
   about a reply: the phone match, the one-reply-per-guest 409, and the rate
   limit. If a gated RSVP must be gated, it needs the same client change as (1).
3. **The slot-aspect crop.** See W4.
4. **`GET /registry/:slug` and `POST /registry/:slug/contribute`** are the
   money milestone's, not this one's, although they resolve on the same
   `Website.slug`. The site read includes a `registry[]` array shaped for
   `LandingPage` (`{id, name, price}` / `{id, name, raised, goal}`) when the
   couple has the registry section switched on; the registry **page** is
   elsewhere.
5. **`content` values are stored as the couple typed them.** No enum of block
   ids is enforced — the theme layer owns that list and it lives in
   `wedsy-user`. Keys are shape-validated (`[a-z0-9][a-z0-9._-]{0,60}`) and
   values capped at 4000 characters, which refuses a path, a script tag and a
   paste accident without inventing a schema this server does not own.

## W9 · Untested seams (honest list)

- **Everything that needs a database**, as in § 7. The two integration files
  below were written and **not run**.
- **The unique index under real concurrency.** The E11000 path is asserted
  sequentially in the integration test; two genuinely simultaneous writes are
  asserted by the index's own semantics, not by a test.
- **S3.** `POST …/photos` is not exercised anywhere: a test that needs AWS
  credentials is a test nobody runs. `AWS_S3_ENDPOINT` points `utils/s3Upload`
  at MinIO or a stub for a manual pass.
- **The rate limiters.** Their windows are an hour and ten minutes; a test that
  waits, or reaches into the limiter's private store, proves something about
  the test. Their *keying and mounting* are asserted structurally instead
  (every public route mounts exactly one limiter and one handler, and no
  `CoupleAuth`).
- **`sharp` on HEIC.** The fallback-to-original branch is written and not
  exercised — the container has no HEIC fixture.

## W10 · Tests

Pure, no database — **these run and pass** (real output, in this container):

```
node tests/couple-site-withholding.test.js      #  76 assertions — the withholding rule, keys ABSENT not empty
node tests/couple-website-builder.test.js       # 108 — slug normalisation and validation, the settings whitelist,
                                                #       the theme-switch carry, the content merge
node tests/couple-site-unlock.test.js           #  62 — the unlock token, its cookie, and the real bcrypt compare
node tests/couple-website-permissions.test.js   # 116 — every refusal path through the REAL middlewares,
                                                #       plus the route table itself
node tests/couple-site-rsvp-seam.test.js        #  92 — the RSVP contract, and a source-level assertion that
                                                #       nothing here reimplements the invariant
```

Integration, **need a dev database (`DATABASE_URL`, never production — rule 7),
and were not run**:

```
node tests/couple-website-builder.int.test.js   # slug uniqueness as the INDEX enforces it (E11000 → 409),
                                                # two unnamed drafts coexisting, the bcrypt hash and its
                                                # select:false, and a theme switch leaving the stored
                                                # content byte-for-byte intact
node tests/couple-public-site.int.test.js       # the withholding rule on the RAW HTTP BODY, the whole unlock
                                                # loop through all three doors, a cross-wedding token refused,
                                                # and the RSVP landing on ONE Guest row with a headcount that
                                                # equals the couple's own Guests tab
```

Both integration files mount the real app the way `routes/router.js` does, plus
`itemRoutes` at the root, and drive it over HTTP.

---

# Money — the registry, the wallet and payments

*Appended by the money milestone. Nothing above this line was edited.*

Files owned by this milestone:

```
routes/coupleApp-money.js             the routes and their gates
controllers/coupleAppMoney.js         sixteen handlers, each wrapped
services/CoupleRegistryRules.js       PURE — shaping, validation, withholding, the offset's door
services/CoupleRegistryService.js     the couple's side of the registry
services/CoupleContributionService.js the public registry, and the one place money arrives
services/CoupleMoneyService.js        the wallet and payments
services/CoupleLinkFetchService.js    fetch-link: the SSRF guard, the budget, the parser
utils/coupleTransaction.js            runAtomically — one write, or none
utils/coupleRegistryRateLimit.js      the contribute bucket, keyed by the website's own ipAndSlug
```

Nothing in `services/CoupleWalletService.js` was changed. Every sign, every
total and every re-derivation in this milestone is that file's; the services
above call it and never re-implement it.

## M1 · Endpoints and their gates

| Endpoint | Gate | Notes |
|---|---|---|
| `GET /wedding/:id/registry` | `registry / view` | `{ items[], funds[], intro, layout, slug, thanked, pending }`. Contributions are attached to their gift, because `money/shared.js`'s `contributionRows()` walks `item.contributions[]`. |
| `PATCH /wedding/:id/registry` | `registry / edit` | `{ intro, layout }`. **Upserts the `Website` document** — § 05.1's registry works with no website. |
| `POST /wedding/:id/registry/fetch-link` | `registry / edit` | An **edit**, not a view: it spends this server's network on an address the caller chose. |
| `POST /wedding/:id/registry/items` | `registry / edit` | `201` + the row, with `id` — `api.addRegistryItem` reads `res.data.id`. |
| `PATCH /registry-items/:id` | `registry / edit` | pin (exclusive), price, title, image. |
| `DELETE /registry-items/:id` | `registry / edit` | Archive once money has arrived; remove otherwise. |
| `POST /wedding/:id/registry/funds` | `registry / edit` | |
| `PATCH /registry-funds/:id` | `registry / edit` | ⛏ contract addition. |
| `DELETE /registry-funds/:id` | `registry / edit` | ⛏ contract addition. |
| `PATCH /contributions/:id` | `registry / edit` | ⛏ contract addition — `{ thanked }`. |
| `GET /wedding/:id/wallet` | `registry / view` **and** `payments / view` | See M5. |
| `POST /wedding/:id/wallet/claim` | **`RequirePayout`** | Never a section gate. |
| `GET /wedding/:id/payments` | `payments / view` | A **bare array**, as `api.payments()` reads it. |
| `POST /payments/:id/pay` | **`RequirePayout`** | `{ method, useWallet: boolean }`. |
| `GET /registry/:slug` | **public**, `siteReadLimiter` | Resolves regardless of `publishedAt`. |
| `POST /registry/:slug/contribute` | **public**, `contributeLimiter` | 6/hour per IP-and-slug. |

Refusal bodies are unchanged from § 3: `401 { error: "unauthenticated" }`,
`403 { error: "forbidden", section, required, held }`,
`403 { error: "forbidden_payout" }`, `422 { error: "validation", fields }`,
`409 { error: "already_funded", funded, price }`, `409 { error: "already_paid" }`,
`429 { error: "rate_limited", retryAfter }`.

The child routes reuse `FromDocument` **imported from
`routes/coupleApp-people.js`** rather than rewritten: two implementations of
"which wedding does this row belong to" is exactly the second membership test
§ 06.4 exists to prevent. `routes/router.js` already mounts
`require("./coupleApp-money").itemRoutes` at the root, so the client's own paths
(`/registry-items/:id`, `/payments/:id/pay`, `/registry/:slug`) are served.

**A `Payment` with no `coupleApp.weddingId` 404s** at `/payments/:id/pay`: a CRM
or store row that was never part of the couple's schedule is not payable through
this door.

## M2 · Contribution → wallet: what "one write" actually guarantees

`utils/coupleTransaction.runAtomically(work)` runs the whole contribution inside
**one MongoDB transaction** wherever the deployment supports one. Production
does: hard rule 4 says the database URL ends `.mongodb.net`, every Atlas cluster
is a replica set, and a replica set is exactly what multi-document transactions
require. There, the gift's running total, the `Contribution` and the `WalletTxn`
credit commit together or not at all, and the endpoint reports `atomic: true`.

**Where a transaction is genuinely unavailable — a standalone `mongod` on a
laptop — this does not pretend.** `runAtomically` detects the refusal
(`IllegalOperation` / code 20, or the driver's replica-set message), says so in
the return value, and runs the work with no session. The ordering is chosen so
the failure mode is reconcilable rather than wrong:

1. **Reserve on the gift first** — a conditional single-document update, which
   is atomic on *any* MongoDB and does not depend on transactions at all.
2. Write the `Contribution` as **`pending`**, which counts towards nothing: not
   `balance()`, not `funded`, not the thank-you list, not the registry read.
3. Write the `WalletTxn` credit.
4. Only then flip the Contribution to `settled` with its `walletTxn` set.

A failure at 2–4 compensates the reserve on the way out and marks the row
`failed`; a crash leaves a `pending` row that no screen reads.

> **The invariant that survives either path: a *settled* Contribution always has
> its credit.** `status: "settled"` ⟺ `walletTxn != null` is the reconciliation
> query — `Contribution.find({ status: "pending", createdAt: { $lt: … } })` is
> the list of things to complete or fail. There is no state in which the couple
> has money they cannot see, and none in which they have money that never
> arrived.

`tests/couple-money-atomicity.test.js` asserts the **dispatch** (which path runs,
that a domain 409 aborts rather than being retried without a session, that a real
error surfaces). It does not assert durability — that is MongoDB's, and
`tests/couple-registry-money.int.test.js` exercises it against a real cluster.

## M3 · The race, and why it is one conditional update

Two guests tap **Pay in full** on the same lamp within the same second.

```js
RegistryItem.findOneAndUpdate(
  { _id, weddingId, archivedAt: null, price, funded: { $lt: price } },
  { $set: { funded: price } },
  { new: false }              // ← the PRE-IMAGE
)
```

The winner's update matches and returns the document **as it was**; the amount
charged is then `CoupleWalletService.contributionAmount(preImage, "full")` —
the remainder the database actually saw, not the remainder the browser was
showing a second ago, and never a figure from the request body. The loser's
update matches nothing and becomes `409 already_funded`.

This is a single-document atomic update, so it holds with or without a
transaction — and inside one, a write conflict makes `withTransaction` re-run
the whole callback, which re-reads and re-derives rather than reusing a stale
amount. The decision itself is pure and tested:
`CoupleRegistryRules.fullReserve` / `partReserve`.

A **priced item** may not be over-funded (`$expr: funded + amount <= price`,
else `422` naming what is left). A **fund** is never capped — § 06.1: money past
a fund's target is still welcome. An item with **no price yet** cannot be taken
"in full" (`422`, not a race) but accepts any chip-in.

## M4 · The offset cannot be client-supplied — three doors, none of them open

1. **The client already strips it.** `api.pay` sends
   `{ method, useWallet: Boolean(...) }` and nothing else.
2. **The server strips it again.** `CoupleRegistryRules.payBody(body)` is the
   only thing that reads a Pay request, and it **emits exactly two keys**. A body
   carrying `walletApplied: 999999`, `amount: 1` or `gatewayAmount: 0` posts
   fields that reach no variable, because there is no variable for them.
   Asserted by key-set equality in `tests/couple-money-ledger.test.js`.
3. **The arithmetic has no parameter for one.**
   `applyWallet(amountDue, walletBalance, useWallet)` — three arguments,
   `applyWallet.length === 3`, and the two amounts were computed by this server
   a line earlier. Passing a fourth argument changes nothing; asserted.

`useWallet` is compared `=== true`. The **string** `"false"` is truthy in
JavaScript, and a form that serialised a checkbox as text would otherwise spend
the couple's gift money.

The integration test fires the hostile body over real HTTP and asserts the
offset is the server's ₹999, not the client's ₹999,999.

## M5 · Two figures: `balance` and `spendable`

`CoupleWalletService.balance()` counts **settled** rows only, and
`claimWrite()` writes a claim as **`pending`**. Read together, a claim in flight
does not reduce the balance — so the same ₹50,000 could be claimed twice while
the first request is still on its way to the bank, and the ledger would agree
with both. **This is a real seam in the foundation's service, found here rather
than in an incident.**

Nothing in the ledger's arithmetic was changed. `CoupleRegistryRules.spendable`
computes a second, narrower figure from the ledger's own primitives
(`balance`, `signOf`, `money`):

```
pendingOutflow = Σ pending claims and debits
spendable      = max(0, balance − pendingOutflow)
```

`spendable` is what is handed to `claimWrite` and to `applyWallet`. `balance` is
still what the couple is shown. Both are in the wallet payload, with `credited`,
`claimed`, `pending` and the readable `transactions[]`.

`POST /payments/:id/pay` uses the same idea from the other end: when the wallet
does **not** cover the row, the debit is written **`pending`** — a reservation,
so the same rupees cannot also be claimed to the bank while the card is being
typed. When it **does** cover the row there is no gateway at all, the debit is
`settled` and the `Payment` is marked paid in the same act.

## M6 · Razorpay: an intent, and the honest reason it is only an intent

`POST /payments/:id/pay` returns a well-formed intent
(`{ provider: "razorpay", mode, dormant, currency, amount, method, orderId: null,
paymentId, walletTxnId }`) and **does not call the gateway**. `mode` and
`dormant` come from `utils/payment`'s own `razorpayMode()` /
`razorpayConfigured()`, so the response tells the truth about this deploy. No key
name appears anywhere in this milestone's code.

`utils/payment.CreatePayment` could not be reused as-is: it creates the order for
`Payment.amount`, and a wallet-offset payment owes `amount − walletApplied`.
Wiring the order creation and its webhook — which is what flips the reserved
debit to `settled` and the `Payment` to `paid` — is the next piece of work, and
it needs a decision about the paise-vs-rupees inconsistency between
`CreatePayment` (passes rupees) and `CreatePaymentLink` (passes paise) that
predates this milestone.

**Until that lands, an abandoned intent leaves a `pending` debit.** The
reconciliation query is
`WalletTxn.find({ type: "debit", status: "pending", createdAt: { $lt: … } })`;
those should be set `failed` (which releases the reservation, since only settled
and pending rows are counted, and a failed one is neither).

## M7 · The public registry, and what a guest may be given

`CoupleRegistryRules.publicRegistryPayload` is the **one** function that builds
the guest's body and the **one** function that can withhold — the same
discipline as `CoupleWebsiteRules.publicPayload`, which it borrows
`publicPrivacy` and `publicPartners` from so the "`passwordRequired`, never the
hash" rule has one implementation on this server.

**Never in it, on any branch:** the bcrypt hash, any guest's name, phone number
or note, any contribution id or date, the couple's thank-you counters, the guest
list, the budget, the payments, the wallet balance.

**The one that needed thought.** `components/registry/GuestRegistry.js` draws its
progress bars with `(row.contributions || []).reduce((n, c) => n + c.amount)`.
Sending the real rows would put every other guest's **name, phone number and
private note** on a page anyone with the link can open. Sending nothing would
draw every bar at zero. So the public payload carries the **total, as one
anonymous row** — `contributions: [{ amount: <funded> }]`, a single key, no id,
no name, no date, no per-gift granularity anyone could correlate against a guest
list — beside `funded`/`raised`, which carry the same number. The client's own
derivation reaches the right answer and learns nothing.
`tests/couple-registry-withholding.test.js` asserts the absence by **searching
the serialised payload as text**, so a leak at any nesting depth is caught.

**Two deliberate differences from the site route:**

- **`publishedAt` is not consulted.** § 05.1 is explicit that the registry "works
  on its own — no website needed", so a registry link resolves on a `Website`
  whose `publishedAt` is still null. `GET /site/:slug` still withholds an
  unpublished site; asserted side by side.
- **The password *is* consulted.** A gated wedding's registry returns the shell —
  `slug`, `paletteId`, `fontId`, `privacy`, `wedding.partners` — and `items`,
  `funds` and `intro` are **absent, not empty**. The contribute endpoint 404s
  too, so a stranger cannot move rupees against a gift id they guessed.

  This is the **one product decision here worth a second opinion**, and it is
  deliberately one condition in one place (`locked` in
  `publicRegistryPayload`, and the matching guard in
  `CoupleContributionService.contribute`) so it can be reversed in a line. The
  case for it: a password on a wedding is the couple's only expression of "not
  for strangers", the registry lives on the same slug, and this codebase fails
  closed everywhere else. The case against it: § 05.1 promises the registry
  works alone, and a couple who set a site password may not expect their gift
  link to go blank. **The shipped `pages/registry/[slug].js` has no gate UI**, so
  today a locked registry renders as an empty gift list rather than a password
  prompt — noted in M10.

## M8 · `fetch-link` treats the response as hostile

This is the only endpoint on the couple app where a user chooses an address and
a machine inside our network fetches it. Four controls, each of which **refuses**
rather than sanitises:

| Control | What it does |
|---|---|
| **Scheme** | `http:` and `https:`. Not `file:`, `gopher:`, `dict:`, `data:`, `javascript:`, `ftp:`. No credentials in the URL. |
| **Port** | 80 and 443. An internal service on 8080 behind a public DNS name is not a shop. |
| **Address** | Every resolved IP is checked against the private, loopback, link-local (**including `169.254.169.254`**), carrier-NAT, TEST-NET, benchmarking, multicast and reserved ranges — v4 and v6, including the shapes that smuggle a v4 address inside a v6 one (`::ffff:`, `::`, `2002::` 6to4, `64:ff9b::` NAT64). Hostnames `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `metadata.google.internal` are refused whatever DNS says. |
| **Budget** | 6 s hard total timeout, 512 KB cap **enforced as the body arrives**, `Content-Type` must be HTML, at most 3 redirects and **every redirect re-vetted from scratch** — a 302 to `http://169.254.169.254/` is the oldest trick here. |

**DNS rebinding is defeated at the socket, not the pre-check.** The guard is
installed as the request's own `lookup`, so it runs again at connect time; a name
that answers publicly on the first query and privately on the second is refused
by the connection. **A host that resolves to both a public and a private address
is refused entirely** — we do not guess which one the socket would pick.

`parseProduct(html, url)` is pure: regular expressions over meta tags, JSON-LD
read **as text and never evaluated**, entities decoded, a relative image resolved
against the page, a `javascript:`/`data:` image refused (the client renders it as
a CSS background). **Every field is optional** — a missing price and a missing
photograph are the ordinary case, exactly as `api.fetchRegistryLink` says.

## M9 · Rate limiting, and its real scope

`POST /registry/:slug/contribute` is limited to **6 per hour** per IP-and-slug
(`REGISTRY_CONTRIBUTE_WINDOW_MS`, `REGISTRY_CONTRIBUTE_MAX`).
`GET /registry/:slug` reuses the website milestone's `siteReadLimiter` directly.

The **key** — the part with a security consequence — is `ipAndSlug`, **imported
from `utils/coupleSiteRateLimit.js`**, not re-written: one key implementation on
this server, not two that could drift. A separate bucket rather than one more
export in that file, because the website milestone owns it; a separate *counter*
because sharing the RSVP's would mean a guest who replied twenty times could not
then send a gift.

**Honestly: the store is `express-rate-limit`'s default MEMORY STORE, so the
limiter is PER NODE PROCESS.** Behind two instances the ceiling is 2×, and a
restart forgives everything (§ W6 says the same about the website's). For an RSVP
that is fine. **On a payment endpoint it is a speed bump, not a control** — the
defence against card testing is the gateway's own fraud checks. The day this
server runs more than one instance, this bucket wants Redis before the unlock one
does.

## M10 · Client contracts this milestone could not fully satisfy

1. **`RegistryFund.note`.** `registry-stub.js` seeds a fund with `note: ""` and
   `GuestRegistry.js` renders `row.note` under a fund's name. `models/RegistryFund`
   has no such field and this milestone does not modify existing models, so the
   value would be silently dropped by mongoose. It is neither stored nor
   promised. One additive optional field on that model closes it.
2. **A locked registry has no gate UI.** `pages/registry/[slug].js` reads
   `data.items` and renders an empty list; it has no password prompt of its own
   (only `/site/:slug` does). A gated wedding's registry link therefore looks
   empty rather than locked. Correct on the server, and one client state away
   from being graceful. See M7 for the flag that reverses the decision instead.
3. **The gateway is not called.** See M6. `api.pay`'s optimistic client flips the
   row to `paid` and would need to roll back when the intent is only an intent —
   today the response's `fullyCovered: false` and `intent` are the honest signal
   and the screen does not read them yet.
4. **`WalletTxn.status` and the client's vocabulary.** `registry-stub.js` writes
   `status: "cleared"` for a credit and `"requested"` / `"applied"` for claims;
   the model's enum is `pending | settled | failed`. The server sends the model's
   values. The wallet strip renders the amount and the label and does not branch
   on status, so nothing is broken — but a screen that starts reading it should
   read the server's three.
5. **`GET /wedding/:id/wallet` needs BOTH sections**, per § 5's table
   ("registry / view + payments / view"). The consequence is real: a shared
   member with only the registry loses the wallet strip on the Registry screen,
   and one with only payments loses the Gift wallet tile. It is `RequireEvery`
   in one line in `routes/coupleApp-money.js` if Rohaan wants either half to be
   enough.
6. **The couple's `layout` (grid/list) is stored and returned** but the public
   payload does not carry it — `pages/registry/[slug].js` does not read one.

## M11 · Notifications

**None were added.** Triggers only, through `services/NotificationService.js`,
WhatsApp via the **Meta Cloud API — never Aisensy** — and only after the
Notification System spec in Notion. Three marked comments name the ones this
feature wants:

| Moment | Trigger | Marked at |
|---|---|---|
| A contribution arrives | `couple_registry_gift` | `CoupleContributionService.contribute` |
| A claim is requested / settles | `couple_wallet_claim` | `CoupleMoneyService.claim` |
| A payment succeeds | reuse the `event_pmnt_rmnd` family | `CoupleMoneyService.pay` |

## M12 · Untested seams (honest list)

- **Everything that needs a database**, as always. The integration test below was
  written and **not run**.
- **Transaction durability.** The dispatch is tested; that MongoDB commits both
  documents or neither is MongoDB's property, and needs a replica set to observe.
  Against a standalone `mongod` the integration test's `atomic: true` assertions
  will fail — correctly.
- **The real network in `fetch-link`.** The guard's decisions are tested
  exhaustively with no DNS and no sockets; that Node's `lookup` option is honoured
  by every redirect hop is asserted by reading the code, not by a live rebinding
  attack. Worth one manual check against a controlled host before this is
  advertised.
- **The rate limiters** are not exercised (an hour-long window; a test that waits
  or reaches into the store proves something about the test).
- **The `pending` debit's reconciliation** is specified in M6 and **not
  implemented** — no job sweeps abandoned intents yet.
- **Concurrency on the exclusive pin.** Two simultaneous "pin this one" writes can
  briefly leave two pinned items. Cosmetic, not money.

## M13 · Tests

Pure, no database — **these run and pass** (output as run):

```
node tests/couple-money-ledger.test.js         #  95 — the offset both ways, the full re-derivation,
                                               #       the 409 race, all four ledger types, spendable
node tests/couple-registry-withholding.test.js #  56 — a guest's name, number and note never reach
                                               #       another guest; the hash never crosses; the gate
node tests/couple-registry-linkfetch.test.js   # 128 — the SSRF accept/refuse table, v4 and v6, the
                                               #       rebinding decision, and the parser
node tests/couple-money-permissions.test.js    # 192 — every refusal path through the REAL middlewares,
                                               #       including both payout gates
node tests/couple-money-atomicity.test.js      #  22 — which write path runs, and what aborts
```

Integration, **needs a dev database (`DATABASE_URL`, never production — rule 7)
and a replica set for the atomicity assertions; NOT run**:

```
node tests/couple-registry-money.int.test.js
```

It mounts the real app the way `routes/router.js` does and drives it over HTTP.
The assertion that matters most is § 07.1's definition of done for this
milestone: **a guest contributes on the public route and the money is the offset
on the couple's very next payment, with no manual step in between.** It also
fires two concurrent "pay in full" requests at one gift and asserts exactly one
200, exactly one 409, one Contribution, one credit and `funded` equal to the
price — the race as MongoDB executes it rather than as a pure function decides
it.
