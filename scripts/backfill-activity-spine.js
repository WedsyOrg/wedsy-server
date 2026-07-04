/**
 * Backfill the signal spine (Signal Matrix Slice 4) — idempotent, batched.
 *
 *   node scripts/backfill-activity-spine.js --dry-run   # report only, NO writes
 *   node scripts/backfill-activity-spine.js             # real run
 *
 * Computes, per lead:
 *   firstRespondedAt = min( firstCalledAt,
 *                           first updates.conversations[].createdAt,
 *                           first outbound-touch LeadInternalEvent createdAt
 *                             (whatsapp_outbound / wa_admin_message_sent /
 *                              ig_admin_message_sent / wa_template_sent) )
 *   lastActivityAt   = max( all of the above,
 *                           callLog[].startedAt,
 *                           followUps[].createdAt / completedAt,
 *                           doc updatedAt when updates.notes is set (blob has
 *                             no per-note timestamp — conservative fallback),
 *                           latest LeadTask.updatedAt,
 *                           latest Followup.updatedAt,
 *                           latest human LeadChatMessage.createdAt )
 *
 * Write semantics mirror the live paths: firstRespondedAt only where currently
 * null (set-once), lastActivityAt via $max (monotonic) — so re-running, or
 * racing live traffic, can never move either signal backwards.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadTask = require("../models/LeadTask");
const Followup = require("../models/Followup");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 500;
const RESPONSE_EVENT_TYPES = [
  "whatsapp_outbound",
  "wa_admin_message_sent",
  "ig_admin_message_sent",
  "wa_template_sent",
];

const URI = process.env.DATABASE_URL;
if (!URI) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const ts = (v) => {
  if (!v) return null;
  const ms = +new Date(v);
  return Number.isNaN(ms) ? null : ms;
};
const minOf = (list) => {
  const vals = list.filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
};
const maxOf = (list) => {
  const vals = list.filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
};

// One aggregation per related collection per batch → Map(leadId → ms).
const groupedStamp = async (Model, leadIds, { match = {}, field, op }) => {
  const rows = await Model.aggregate([
    { $match: { leadId: { $in: leadIds }, ...match } },
    { $group: { _id: "$leadId", stamp: { [op]: `$${field}` } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), ts(r.stamp)]));
};

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  const totals = {
    scanned: 0,
    wouldSetFirstResponded: 0,
    firstAlreadySet: 0,
    wouldRaiseLastActivity: 0,
    lastAlreadyCurrent: 0,
    noSignalsAtAll: 0,
  };
  try {
    const cursor = Enquiry.find(
      {},
      {
        firstCalledAt: 1, firstRespondedAt: 1, lastActivityAt: 1,
        callLog: 1, followUps: 1, updates: 1, updatedAt: 1,
      }
    )
      .lean()
      .cursor({ batchSize: BATCH });

    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const ids = batch.map((l) => l._id);
      const [taskMax, fuMax, evMin, evMax, chatMax] = await Promise.all([
        groupedStamp(LeadTask, ids, { field: "updatedAt", op: "$max" }),
        groupedStamp(Followup, ids, { field: "updatedAt", op: "$max" }),
        groupedStamp(LeadInternalEvent, ids, { match: { type: { $in: RESPONSE_EVENT_TYPES } }, field: "createdAt", op: "$min" }),
        groupedStamp(LeadInternalEvent, ids, { match: { type: { $in: RESPONSE_EVENT_TYPES } }, field: "createdAt", op: "$max" }),
        groupedStamp(LeadChatMessage, ids, { match: { kind: "message" }, field: "createdAt", op: "$max" }),
      ]);

      const ops = [];
      for (const lead of batch) {
        totals.scanned += 1;
        const key = String(lead._id);
        const convoStamps = (lead.updates?.conversations || []).map((c) => ts(c.createdAt));
        const callStamps = (lead.callLog || []).map((c) => ts(c.startedAt) ?? ts(c.createdAt));
        const fuStamps = (lead.followUps || []).flatMap((f) => [ts(f.createdAt), ts(f.completedAt)]);
        // The notes blob has no per-note timestamp, so doc updatedAt is the only
        // available proxy — but ONLY for a never-stamped lead. Once lastActivityAt
        // exists, the blob is already accounted for and live edits bump the spine
        // through the normal write path; keeping the proxy live would chase every
        // later updatedAt bump and re-raise forever (the treadmill this fixes).
        const notesBlobSet =
          !!(lead.updates?.notes && String(lead.updates.notes).trim()) &&
          lead.lastActivityAt == null;

        const firstResponded = minOf([ts(lead.firstCalledAt), minOf(convoStamps), evMin.get(key)]);
        const lastActivity = maxOf([
          ts(lead.firstCalledAt),
          maxOf(callStamps),
          maxOf(fuStamps),
          maxOf(convoStamps),
          notesBlobSet ? ts(lead.updatedAt) : null,
          taskMax.get(key),
          fuMax.get(key),
          evMax.get(key),
          chatMax.get(key),
        ]);

        // "No signals" = nothing computed AND nothing already stored — an
        // already-stamped notes-only lead (whose proxy is now retired) is NOT
        // signal-less; its stamp persists.
        if (
          firstResponded == null && lastActivity == null &&
          lead.firstRespondedAt == null && lead.lastActivityAt == null
        ) {
          totals.noSignalsAtAll += 1;
        }

        const set = {};
        if (firstResponded != null) {
          if (lead.firstRespondedAt == null) {
            totals.wouldSetFirstResponded += 1;
            set.firstRespondedAt = new Date(firstResponded);
          } else {
            totals.firstAlreadySet += 1;
          }
        }
        let raiseLast = null;
        if (lastActivity != null) {
          const current = ts(lead.lastActivityAt);
          if (current == null || lastActivity > current) {
            totals.wouldRaiseLastActivity += 1;
            raiseLast = new Date(lastActivity);
          } else {
            totals.lastAlreadyCurrent += 1;
          }
        }
        if (!DRY_RUN && (Object.keys(set).length || raiseLast)) {
          const update = {};
          if (Object.keys(set).length) update.$set = set;
          if (raiseLast) update.$max = { lastActivityAt: raiseLast };
          // firstRespondedAt keeps set-once semantics under concurrency: the
          // filter re-checks null so a racing live stamp wins.
          if (set.firstRespondedAt) {
            ops.push({ updateOne: { filter: { _id: lead._id, firstRespondedAt: null }, update: { $set: { firstRespondedAt: set.firstRespondedAt } } } });
            if (raiseLast) ops.push({ updateOne: { filter: { _id: lead._id }, update: { $max: { lastActivityAt: raiseLast } } } });
          } else {
            ops.push({ updateOne: { filter: { _id: lead._id }, update } });
          }
        }
      }
      // timestamps:false — a backfill is bookkeeping, not a doc edit. Bumping
      // updatedAt here polluted every notes-blob lead's activity proxy (see
      // above) AND reordered any updatedAt-sorted list on every run.
      if (ops.length) await Enquiry.bulkWrite(ops, { ordered: false, timestamps: false });
      if (totals.scanned % 5000 < BATCH) console.log(`  …${totals.scanned} scanned`);
      batch = [];
    };

    for await (const lead of cursor) {
      batch.push(lead);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    // Real mode reports what HAPPENED ("set/raised"); only a dry-run may say
    // "would" — the conditional wording has misled real-run readers before.
    const did = DRY_RUN ? "would set" : "set";
    const raised = DRY_RUN ? "would raise" : "raised";
    console.log(`\n${DRY_RUN ? "DRY-RUN (no writes)" : "DONE"} — spine backfill`);
    console.log(`  scanned:                    ${totals.scanned}`);
    console.log(`  ${did} firstRespondedAt:  ${totals.wouldSetFirstResponded} (already set: ${totals.firstAlreadySet})`);
    console.log(`  ${raised} lastActivityAt:  ${totals.wouldRaiseLastActivity} (already current: ${totals.lastAlreadyCurrent})`);
    console.log(`  leads with no signals:      ${totals.noSignalsAtAll} (stay null — genuinely untouched)`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
