const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Lead/Enquiry Status:
// Fresh, New, Hot, Potential, Cold, Lost, Interested
// Fresh Lead: When its a new entry. (with 24 Hours)
// New Lead: When the lead has just come (within a week)
// Hot Lead: When event date is within 8 weeks.
// Potential Lead: When event date is between 8 weeks to 20 weeks.
// Cold Lead: Event is beyond 20 Weeks or not yet decided.
// Lost Lead: Waste Lead.
// Interested
//
// Wedsy OS pipeline (Phase 1 addition):
// stage: "new" | "contacted" | "meeting_scheduled" — manually progressed by sales team
// assignedTo: Admin _id — lead owner (auto-assigned via routing rules in Wedsy OS)
// marketingSource: free-form string — marketing channel ("Website", "Instagram DM", etc)

// Note: When new field is added update it in get all enquiry api

const EnquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    email: { type: String, default: "" },
    verified: { type: Boolean, default: false, required: true },
    isInterested: { type: Boolean, default: false, required: true },
    isLost: { type: Boolean, default: false, required: true },
    source: { type: String, required: true, default: "Default" },
    updates: {
      conversations: {
        type: [
          {
            text: { type: String, required: true },
            createdAt: { type: Date, default: Date.now },
          },
        ],
        default: [],
      },
      notes: { type: String, default: "" },
      callSchedule: { type: Date, default: "" },
    },
    additionalInfo: { type: Object, default: {} },
    // Wedsy OS pipeline tracking (added Phase 1 — additive only)
    stage: {
      type: String,
      default: "new",
      required: true,
    },
    assignedTo: {
      type: ObjectId,
      ref: "Admin",
      default: null,
    },
    updatedBy: {
      type: ObjectId,
      ref: "Admin",
      default: null,
    },
    marketingSource: {
      type: String,
      default: null,
    },
    // Wedsy OS disqualify + approval (Stage 3a — additive only). isLost above is unchanged.
    lostStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
    },
    lostReason: { type: String, default: "" },
    lostNote: { type: String, default: "" },
    lostRequestedBy: { type: ObjectId, ref: "Admin", default: null },
    lostRequestedAt: { type: Date, default: null },
    lostDecidedBy: { type: ObjectId, ref: "Admin", default: null },
    lostDecidedAt: { type: Date, default: null },
    lostDecisionNote: { type: String, default: "" },
    stageBeforeLost: { type: String, default: "" },
    // First-call TAT anchor: timestamp of the first time this lead was called (set-once).
    firstCalledAt: { type: Date, default: null },
    // Signal spine (Signal Matrix Slice 4) — denormalized cross-collection stamps.
    // firstRespondedAt: set-once, the first CUSTOMER-FACING response on ANY channel
    // (call, WhatsApp send/press, timestamped note). Never task/chat — internal
    // action is not a response. firstCalledAt and all TAT/funnel metrics stay
    // call-only; this field exists so queue/banner "responded" reads agree.
    firstRespondedAt: { type: Date, default: null },
    // lastActivityAt: monotonic ($max) stamp of ANY employee action on the lead
    // (call, either follow-up store, task, note, WhatsApp, internal chat).
    lastActivityAt: { type: Date, default: null, index: true },
    // Slice A2 — SNOOZE ENGINE. Derived, never hand-maintained: recomputed on
    // every follow-up write. Set when the lead's EARLIEST open follow-up (either
    // store) is > snooze.thresholdDays out AND the lead has responded
    // (firstRespondedAt set). snoozedUntil = that follow-up's date (the single
    // source of truth); snoozeSource = the follow-up's _id (cadence subdoc or
    // Followup doc). Cleared by the wake sweep, by unsnooze, or by any recompute
    // that pulls the earliest date back in.
    snoozedUntil: { type: Date, default: null, index: true },
    snoozeSource: { type: ObjectId, default: null },
    // Journey v2 (V6) — the proposal RITUAL state (null until the team opens the
    // station) + free-text working notes for the negotiation.
    proposalStatus: {
      type: String,
      enum: ["started", "awaiting_client", "negotiation", "done", null],
      default: null,
    },
    proposalNotes: { type: String, default: "" },
    // Journey v2 (V6) — THE VALUE: one evolving number with its full story.
    // quoted (first share) → renegotiated (re-shares/edits) → final (onboard;
    // post-onboard ledger edits stay in phase "final"). dealTotal remains the
    // post-onboard mutable ledger total; dealValue.amount mirrors the latest
    // truth. Old leads stay null until touched — NO migration.
    dealValue: {
      type: new mongoose.Schema(
        {
          amount: { type: Number, default: null },
          history: {
            type: [
              {
                amount: { type: Number, required: true },
                at: { type: Date, required: true },
                by: { type: ObjectId, ref: "Admin", default: null },
                phase: { type: String, enum: ["quoted", "renegotiated", "final"], required: true },
              },
            ],
            default: [],
          },
        },
        { _id: false }
      ),
      default: null,
    },
    // Journey v2 (V7) — the manual "agreement sent" checkbox { at, by }.
    agreementSentAt: {
      type: new mongoose.Schema(
        {
          at: { type: Date, default: null },
          by: { type: ObjectId, ref: "Admin", default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    // Journey v2 (V1) — THE canonical lead brief: one pinned paragraph the whole
    // team reads before touching the lead. Saved deliberately (never AI-auto-
    // saved); null until first save.
    leadBrief: {
      type: new mongoose.Schema(
        {
          text: { type: String, default: "" },
          savedBy: { type: ObjectId, ref: "Admin", default: null },
          savedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    // Kiara hardening — set when the extractor terminally failed for this lead
    // (Anthropic no-text/parse failure after retries): the lead needs a HUMAN
    // qualification pass instead of silently staying unqualified. Cleared by
    // nothing automatic; the owner works the lead and qualifies it manually.
    needsHumanQualification: { type: Boolean, default: false },
    // Slice B2 — the deal spine's "proposal" station. Set-once via
    // POST /enquiry/:_id/proposal-sent (409 on a second attempt); amount
    // optional (rupees). The station itself is derived on read.
    proposalSentAt: { type: Date, default: null },
    proposalAmount: { type: Number, default: null },
    // Slice B5a — the deal's total value (rupees). The payments ledger computes
    // balance against this; edits audit via a deal_total_changed event.
    dealTotal: { type: Number, default: null },
    // First-call cockpit (Phase 1A — additive only).
    // Append-only call history: entries are pushed by POST /enquiry/:_id/call-log and
    // intentionally have NO edit/delete route.
    callLog: {
      type: [
        {
          startedAt: { type: Date, required: true },
          durationSeconds: { type: Number, default: 0 },
          connected: { type: Boolean, default: false },
          outcome: { type: String, default: "" }, // qualified | busy | unknown | disqualified | ""
          // Mid-qualify slice — what the call was FOR. "" = legacy/unknown (no
          // migration; old rows keep today's rendering).
          purpose: { type: String, enum: ["", "discovery", "follow_up"], default: "" },
          notes: { type: String, default: "" },
          loggedBy: { type: ObjectId, ref: "Admin", default: null },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    followUps: {
      type: [
        {
          type: { type: String, enum: ["meet", "call", "visit"], required: true },
          scheduledAt: { type: Date, required: true },
          promiseNote: { type: String, default: "" },
          createdBy: { type: ObjectId, ref: "Admin", default: null },
          createdAt: { type: Date, default: Date.now },
          // Lifecycle (additive): completion stamp via PUT /:_id/follow-up/:followUpId/complete
          completedAt: { type: Date, default: null },
          completedBy: { type: ObjectId, ref: "Admin", default: null },
          completedOutcome: { type: String, default: "" }, // connected | busy | no_answer | done
          completedNotes: { type: String, default: "" },
        },
      ],
      default: [],
    },
    // Set when a call is logged with outcome "qualified". Drives the server-side
    // complete-call gate (qualified leads must lock a future follow-up).
    qualified: { type: Boolean, default: false },
    qualificationData: {
      groomName: { type: String, default: "" },
      brideName: { type: String, default: "" },
      weddingStyle: { type: String, default: "" },
      venueStatus: { type: String, default: "" }, // "" | booked | looking
      venueName: { type: String, default: "" },
      venueTypeWanted: { type: String, default: "" },
      venueArea: { type: String, default: "" },
      venueBudget: { type: String, default: "" },
      venueShortlistNote: { type: String, default: "" },
      email: { type: String, default: "" },
      emailNotWilling: { type: Boolean, default: false },
      whatsappSameNumber: { type: Boolean, default: true },
      whatsappNumber: { type: String, default: "" },
      // ── SEQ-3c (additive) — the intern-filled DISCOVERY event date. This is
      // the ONLY date the discovery gate reads (the ad-form/Kiara month band is
      // excluded). An exact date AND/OR a part-of-day; either alone is enough,
      // both allowed. No migration (empty defaults).
      eventDate: { type: String, default: "" }, // exact date, e.g. "2026-12-20"
      eventDatePart: { type: String, enum: ["", "morning", "afternoon", "evening"], default: "" },
      // ── MB6 Slice 6 (additive) — Cockpit v2 qualification fields ─────────
      // Multi-select from the services.available master list.
      servicesRequired: { type: [String], default: [] },
      budgetAmount: { type: Number, default: null },
      budgetNote: { type: String, default: "" },
      // Overall-vs-per-service split: budgetAmount/budgetNote are the WHOLE-wedding
      // budget; budgetPerService holds a labeled single-service figure (e.g.
      // "catering ~3L") so it never inflates the headline budget. Additive, empty
      // default, no migration (matches the venueBudget precedent above).
      budgetPerService: { type: String, default: "" },
      // Partner/fiancé emails — Slice 8's calendar invites include these.
      additionalEmails: { type: [String], default: [] },
      // ── Lead-schema foundation (additive) — cockpit/brief redesign ──────────
      // Free-form city the FE dropdown sets (no backend city list). When the FE
      // picks a Karnataka-destination city it also sets destinationWedding=true;
      // the server just stores both. zones: coverage zones the lead spans
      // (north|south|east|west|central). venueArea above is retained untouched.
      city: { type: String, default: "" },
      destinationWedding: { type: Boolean, default: false },
      zones: { type: [String], default: [] },
      // Free-form qualifier notes captured during qualification (additive, empty
      // default, no migration). Stored like the other string fields above.
      additionalNotes: { type: String, default: "" },
      // ── Lead-detail cockpit (additive) — the FULL day/function draft the
      // cockpit edits. Persisted verbatim on every /qualification save so
      // reopening the cockpit re-hydrates the draft instead of re-seeding blank.
      // The formal Event (events collection) is built from this ONLY at
      // qualification. The scalar eventDate above stays the DERIVED canonical
      // date (earliest dated, non-dateUnknown day). No migration (empty default).
      eventDays: {
        type: [
          {
            date: { type: String, default: "" }, // "YYYY-MM-DD" or ""
            tentative: { type: Boolean, default: false }, // approximate date (date present, soft)
            dateUnknown: { type: Boolean, default: false }, // "dates not finalised" — no date known
            functions: {
              type: [
                {
                  type: { type: String, default: "" },
                  time: { type: String, default: "" }, // "HH:mm" 24h
                  session: { type: String, default: "" }, // "" | morning | afternoon | evening
                  venue: { type: String, default: "" },
                  pax: { type: String, default: "" },
                  space: { type: String, default: "" },
                },
              ],
              default: [],
            },
          },
        ],
        default: [],
      },
    },
    // ── SEQ-1 (additive) ─ The qualifier's free-text discovery notes. Written
    // anytime pre-qual via PUT /enquiry/:_id (scoped); a plain field, so it
    // survives qualification untouched. No migration needed (empty default).
    qualifierNotes: { type: String, default: "" },
    // Outcome of the cockpit's complete-call action. gaps holds the missing items
    // acknowledged on an incomplete save (flagged on the lead, per the approved design).
    callCompletion: {
      status: { type: String, enum: ["", "complete", "incomplete"], default: "" },
      gaps: { type: [String], default: [] },
      completedAt: { type: Date, default: null },
      completedBy: { type: ObjectId, ref: "Admin", default: null },
    },
    // SEQ-3b (additive) — "no further action" marker. Set when a call is SAVED
    // with discovery still incomplete AND no scheduled next step (follow-up/meet),
    // so the lead has nowhere to go. Cleared the moment a next step is scheduled
    // (CallCockpitService.addFollowUp, incl. the G-Meet path) or the lead is
    // qualified. Surfaced on the enquiry GET for the intern's own view. No
    // migration (empty default); no escalation wiring yet (those dashboards
    // don't exist) — see the TODO(escalation) at the set site.
    noFurtherAction: {
      flagged: { type: Boolean, default: false },
      flaggedAt: { type: Date, default: null },
      flaggedReason: { type: String, default: "" },
    },
    // ── Settings Suite (additive only) ──────────────────────────────────────
    // Values for CustomFieldDef-defined fields ({ defKey: value }).
    customFields: { type: Object, default: {} },
    // Tag labels picked from the Settings tag library (tags.available).
    tags: { type: [String], default: [] },
    // ── Lead lifecycle (additive only) ──────────────────────────────────────
    // Intake engine: stamped when an existing lead enquires again (dedup-merge).
    reEnquiredAt: { type: Date, default: null },
    // Attempt cadence: stamped when busy/unknown attempts reach MAX_ATTEMPTS.
    unresponsiveFlaggedAt: { type: Date, default: null },
    // CSV import marker: historical imports are excluded from auto-assignment.
    importedAt: { type: Date, default: null },
    // ── Design-pass Slice 5 (additive) — cached Kiara AI summary ────────────
    // Founder-voice synopsis composed from captured data; "Regenerate" refreshes.
    kiaraSummary: {
      text: { type: String, default: "" },
      generatedAt: { type: Date, default: null },
    },
    // ── MB7b Slice 4 (additive only) — nurture engine ───────────────────────
    // The WhatsApp-group gate at G-Meet close: nurture only switches on once the
    // CS person confirms the couple's group exists. A "No"/unanswered close
    // raises whatsappGroupFlag (the red flag on the file + dashboard) until a
    // one-tap flip to Yes. nurture.lastTouchAt is the cadence clock — reset by a
    // completed nurture task OR a couple inbound message.
    whatsappGroupCreated: { type: Boolean, default: false },
    whatsappGroupCreatedAt: { type: Date, default: null },
    whatsappGroupFlag: {
      raised: { type: Boolean, default: false },
      raisedAt: { type: Date, default: null },
      clearedAt: { type: Date, default: null },
    },
    nurture: {
      active: { type: Boolean, default: false },
      lastTouchAt: { type: Date, default: null },
    },
    // ── MB5 Slice 5 (additive only) — Kiara safety net engagement marker ────
    // Set once when the safety net sends the welcome template (after-hours
    // create or golden-window miss). Gates the once-per-lead rule and joins
    // the lead into mission-quiet.
    kiaraSafetyNetAt: { type: Date, default: null },
    // ── MB5 Slice 4 (additive only) — triage mode ───────────────────────────
    // In assignment.mode='triage', new leads land here unassigned until a
    // triage holder assigns them (or the escalation chain auto-assigns).
    triagePending: { type: Boolean, default: false },
    triageEnteredAt: { type: Date, default: null },
    triageEscalatedAt: { type: Date, default: null },
    // ── MB5 Slice 3 (additive only) ─────────────────────────────────────────
    // Set-once credit: the intern who booked the meet that triggered the
    // handoff. Their stats keep this lead permanently.
    qualifiedBy: { type: ObjectId, ref: "Admin", default: null },
    // ── MB11c (additive) ─ Set-once timestamp of the qualify hinge, so the
    // command center can surface "qualified by X · on date" at the handoff.
    qualifiedAt: { type: Date, default: null },
    // Lightweight event-team assignments captured at huddle completion.
    eventTeam: {
      type: [
        {
          adminId: { type: ObjectId, ref: "Admin", required: true },
          label: { type: String, default: "" },
        },
      ],
      default: [],
    },
    // Recycle — the third terminal state. Excluded from all active views while
    // isRecycled; lazily resurfaced (and reassigned) once revisitAt passes.
    recycled: {
      isRecycled: { type: Boolean, default: false },
      reason: { type: String, default: "" }, // wedding_next_year | budget_mismatch_now | venue_not_booked | other
      reasonNote: { type: String, default: "" },
      revisitAt: { type: Date, default: null },
      recycledBy: { type: ObjectId, ref: "Admin", default: null },
      recycledAt: { type: Date, default: null },
      originalOwnerId: { type: ObjectId, ref: "Admin", default: null },
      resurfacedAt: { type: Date, default: null },
    },
    // ── MB9c (additive, nullable) — SOFT DELETE. The list "Delete" (founder-only)
    // sets these; archived leads are excluded from default list queries but are
    // NEVER hard-removed (recoverable). The ONLY Enquiry change in MB9c.
    archivedAt: { type: Date, default: null },
    archivedBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// Create unique index on phone to prevent duplicates at database level
EnquirySchema.index({ phone: 1 }, { unique: true });
// MB9c-fix — the lead list's default + sort is newest-created-first; index it
// (with _id as the stable paging tiebreaker).
EnquirySchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model("Enquiry", EnquirySchema);
