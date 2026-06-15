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
      // ── MB6 Slice 6 (additive) — Cockpit v2 qualification fields ─────────
      // Multi-select from the services.available master list.
      servicesRequired: { type: [String], default: [] },
      budgetAmount: { type: Number, default: null },
      budgetNote: { type: String, default: "" },
      // Partner/fiancé emails — Slice 8's calendar invites include these.
      additionalEmails: { type: [String], default: [] },
    },
    // Outcome of the cockpit's complete-call action. gaps holds the missing items
    // acknowledged on an incomplete save (flagged on the lead, per the approved design).
    callCompletion: {
      status: { type: String, enum: ["", "complete", "incomplete"], default: "" },
      gaps: { type: [String], default: [] },
      completedAt: { type: Date, default: null },
      completedBy: { type: ObjectId, ref: "Admin", default: null },
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

module.exports = mongoose.model("Enquiry", EnquirySchema);
