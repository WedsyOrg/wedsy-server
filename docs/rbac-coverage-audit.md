# RBAC coverage — audit and decision list

Audit only, 6 Sep 2026. No code changed. For #177 (writes) and #184 (reads).

The hard part is not the code. It is deciding **who may legitimately delete what**,
and that is a product call. This is the list to answer.

---

## Correction to #177 and #184 first

Both tickets were written by me on 2 Sep from a route-level grep that only
recognised `requirePermission`. It missed five other admin-side permission gates
(`canView`, `canApprove`, `canExport`, `storeOrLeadsView`, `requireCapabilityOrAdmin`)
and counted routes that admins cannot reach at all (venue- and vendor-token routes).

| | ticket said | actual |
|---|---|---|
| ungated DELETE | 100 of 108 | **66 of 86 admin-reachable** |
| ungated GET | 275 of 361 | **156 of 247 admin-reachable** |

Payroll is the clearest example of the error: `/payroll/salary/:adminId` and
`/payroll/:month/export` looked ungated and are in fact gated on
`payroll:view:all` / `payroll:export:all`. **Nobody's salary is exposed.**

The gap is real and still large. It is not as large as the tickets claim, and the
tickets should be corrected so nobody plans against the wrong number.

---

## What the numbers actually are

```
DELETE  108 total · 86 admin-reachable · 20 gated · 66 UNGATED
        of the 66:  51 hard-delete   ·  66 unlogged  ·  51 hard AND unlogged

GET     365 total · 247 admin-reachable · 91 gated · 156 UNGATED
```

"Admin-reachable" = behind `CheckAdminLogin` / `CheckLogin` / `CheckToken` and not
behind a venue or vendor token. `requireCapability` (165 uses) gates **venue**
tokens only — it 401s without `req.venueOwner`, so it never applies to admins.

**Every one of the 66 is unlogged.** No audit row, no internal event. A deletion
today leaves no trace of who did it.

---

## The three that matter most

### 1. `DELETE /enquiry` — bulk, hard, unlogged, and already solved next door

```js
const { leadIds } = req.body;
Enquiry.deleteMany({ _id: { $in: leadIds } })
```

Any authenticated admin, holding zero permissions, can post an array of lead ids
and hard-delete them. No cap on array size. No log. And **25 models reference
`Enquiry`** — `LeadPayment`, `PaymentMilestone`, `Event`, `Project`, `Onboarding`
among them — so the children are silently orphaned, not cascaded.

The fix needs no new vocabulary and no decision. Two hundred lines below, in the
same file:

```js
router.post("/bulk-archive", CheckAdminLogin,
  requirePermission("leads:delete:all", { ownerField: "assignedTo" }), leadBulk.Archive);
```

That one is a **soft** delete behind a founder-only permission. The **hard** one
is ungated. Someone built the careful path and left the old one open beside it.

### 2. `DELETE /event/:_id` — an admin bypasses the guards a customer has

```js
const filter = isAdmin ? { _id } : { _id, user: user_id,
  "status.finalized": false, "status.approved": false };
Event.findOneAndDelete(filter)
```

A regular user cannot delete a finalized or approved event. An admin can — and a
finalized, approved event is a **booked wedding**. Unlogged.

### 3. `DELETE /vendor` and `DELETE /vendor/:_id` — hard, unlogged

Removes a vendor record outright. Bidding history and personal packages reference
vendors.

---

## DELETE — the 66, grouped

Ordered by what a mistake costs, not by count.

### A · Client & lead records — 16 routes
`/enquiry/` · `/enquiry/:id/milestones/:milestoneId` · `/enquiry/:id/conversations/:cid`
`/event/` · `/event/:id` · `/event/:id/event-access` · `/event/:id/eventDay/:day`
`/event/:id/decor/:dayId` · `/event/:id/decor-package/:dayId` · `/event/:id/approve`
`/event/:id/approve/:dayId` · `/event/:id/finalize` · `/event/:id/share/:shareId`
`/chat/:id` · `/message/:id` · `/weddingTimeline/:milestoneId`

Irreversible, unlogged, and the only group where a mistake destroys something a
customer paid for. `/enquiry/:id/milestones/:milestoneId` deletes a **payment
milestone**.

### B · Vendor records — 12 routes
`/vendor/` · `/vendor/:id` · `/bidding/:id` · `/vendor-personal-package/:id` ·
`/vendor-review/share/:shareId` · the six vendor taxonomy routes.

### C · Commercial / pricing — 6 routes
`/coupon/:id` · `/discount/:id` · `/wedsy-package/:id` · `/wedsy-package-category/:id` ·
`/decor-package/:id` · `/taxation/:id`

Recreatable, but a deleted live coupon or tax rate changes what customers are
charged until someone notices.

### D · Catalogue & config — 18 routes
`/category` `/color` `/tag` `/unit` `/attribute` `/add-on` `/product-type`
`/quantity` `/raw-material` `/label` `/location` `/event-type` `/event-community`
`/lead-source` `/lead-interest` `/lead-lost-response` `/event-lost-response`
`/event-mandatory-question` — all `/:_id`.

Lowest stakes. Recreatable by hand. **But** deleting a referenced taxonomy row
leaves dangling references on live records, and nothing validates that.

### E · Ops & personal — 14 routes
`/task/:id` · `/notification/` · `/notification/:id` · `/savedViews/:id` ·
`/settings/themes/:id` · `/community/:id` · `/community/:id/reply/:rid` ·
`/community/:id/like` · `/community/:id/dis-like` · `/google/link` ·
`/adminVenueOps/shortlists/:id/items/:itemId` · `/user/wishlist/:wishlist` ·
`/auth/user` · `/auth/vendor`

`/auth/user` and `/auth/vendor` are **account deletion**, behind `CheckLogin`
(self-service). Worth confirming they only ever delete the caller's own account.

---

## GET — the 156, grouped separately

Read exposure needs a different answer from delete exposure: the harm is
disclosure, not destruction, and the fix is often "scope it" rather than "gate it".

| Group | Routes | Notes |
|---|---|---|
| Venue ops | 19 | entire `adminVenueOps` surface: claims, holds, leads, chats, site-visits, activity feed |
| Client data | 15 | `/chat` `/message` `/event` `/onboarding/*` `/plan/themes` |
| Money | 9 | `/order` `/payment/*` `/settlements` `/stats` |
| Staff | 3 | `/admin` (full staff directory), plus two venue-journey reads under `/admin` |
| Self-service | 3 | `/attendance/me` `/leave/me` `/reimbursement/me` — own data, fine |
| Catalogue & config | ~100 | the read side of group D, low sensitivity |

**Payroll is NOT in this list.** It is gated. The ticket was wrong.

The concentration is `adminVenueOps` (19) and `/admin` (the staff directory) —
two decisions covering the most sensitive reads.

---

## Decision list

Nine questions. Everything else follows from them.

**Deletes**

1. `DELETE /enquiry` (hard bulk) — attach `leads:delete:all`, matching
   `/bulk-archive`? *Recommended: yes. No new vocabulary, existing precedent,
   one line.*
2. Should it stay a **hard** delete at all, or become a soft delete like
   `/bulk-archive`? *This is the bigger question. A soft delete makes the whole
   class recoverable.*
3. `DELETE /event/:id` — should an admin keep bypassing the finalized/approved
   guard? Who may delete a booked wedding?
4. Group A (client & lead, 16 routes) — one permission (`leads:delete:all`) or
   split lead / event / message?
5. Group B (vendor, 12) — new `vendors:delete:all`, or fold into an existing grant?
6. Groups C + D (commercial + catalogue, 24) — is `settings:edit:all` (exists) the
   right gate, or does catalogue deletion deserve its own?
7. **Should deletes be logged?** Currently none are. Independent of gating, and
   arguably worth more: a gate stops the wrong person, a log tells you what
   happened. *Recommended: yes, and cheap — `ActivityLogService` exists.*

**Reads**

8. `/admin` (staff directory) and `adminVenueOps` (19) — gate, or scope? These two
   are most of the sensitive read exposure.
9. Catalogue reads (~100) — leave open? They are lookup vocabularies with no
   personal data, and gating them means every dropdown needs a grant.

---

## What is NOT recommended

**Do not invert the default** (deny writes unless permitted) until coverage is
high. Almost no seeded role holds any delete permission — `rbac-seed-data.js`
grants none — so flipping the default today locks out effectively everyone.

**Do not gate the catalogue reads first.** Highest route count, lowest risk, and
it makes every screen need grants before the dangerous routes are touched.

---

## Production queries (SSH is gated — hand these over)

How often are these routes actually used? Gating an unused route is free; gating
a daily-use route needs a grant decision first.

```js
// If request logging exists, count DELETEs by path over 90 days.
// Otherwise this is the proxy: how much would a hard delete have destroyed?
db.enquiries.countDocuments({})
db.events.countDocuments({ "status.finalized": true })
db.leadpayments.countDocuments({})
```

There is no audit collection to query — that is finding 7.


---

## Addendum, 6 Sep — two done, and one correction to this document

### Correction to finding 7

This document said *"there is no audit collection to query — that is finding 7."*
**That was wrong.** `ActivityLog` exists — `actorId` · `action` · `entityType` ·
`entityId` · `summary` · `meta` · timestamps, with two indexes — and
`StageService` and `LeadBulkService` already write to it. It was barely used, not
absent. The work below routes destructive requests into it rather than building
anything new.

### Question 1 — done, and it needed no answer

`DELETE /enquiry` is **removed**, route and handler both. Nothing called it: the
CRM's bulk delete already posts to `/enquiry/bulk-archive`, `NewLeadModal`'s
`"/enquiry"` is a POST, `wedsy-user` makes no DELETE against enquiry, and this
repo's only bare reference is a GET smoke check in `verify-limiter-hotfix`.

Removed rather than gated: a gated hard delete is still unrecoverable loss for
whoever holds the grant, and the soft path already existed. Tombstone comments
sit at both the route and the old handler so it is not reintroduced by accident.

**Question 2 is settled by default** — there is no hard bulk lead delete left to
decide about. If one is ever wanted it needs a cascade-and-retention decision
first, not a route.

### Question 7 — done

Destructive requests are logged at the auth chokepoint, not by editing 66 routes.
Recording *who deleted what* presupposes nothing about who *may*, so it does not
collide with the questions still open — and it cannot miss route 67.

- **What:** actor · action · entityType · entityId · summary · meta{path, method,
  status, params}.
- **Never:** the request body. A delete payload can carry names, phone numbers or
  other people's ids. Path and params say what was targeted; the body is not
  needed and cannot be safely retained.
- **When:** on response finish, so the *outcome* is recorded — a refused 403 is as
  interesting as a success.
- **Not reads.** Logging every GET would bury the destructive rows in noise.
- **Retention: 400 days** by TTL — a year plus a quarter, so an annual review
  always has a complete preceding year. **This number is yours to confirm**; a
  statutory retention period, if one touches these rows, wins. Overridable via
  `ACTIVITY_LOG_RETENTION_DAYS`. `expireAfterSeconds` is fixed at index creation,
  so changing it on a live deployment needs `collMod`.

Destructive routes that are **not** DELETEs — `/enquiry/bulk-archive`,
`/enquiry/bulk-lost` and three `*/remove` routes — are covered by an explicit
list, because method alone cannot find them and logging every POST would be the
traffic capture this deliberately is not.

### Still open: questions 3, 4, 5, 6, 8, 9

Untouched. No group boundaries drawn, no permission names invented.
