// A8 — the plan CHANGE LOG. Every add/edit/delete on looks & draft items
// stamps ONE append-only LeadInternalEvent (type "plan_change") — the raw
// material Log Work composes its deterministic net-change brief from.
// Fire-safe: a failed stamp never breaks the write it describes.
const record = async (leadId, actorId, payload = {}) => {
  try {
    await require("../services/LeadInternalEventService").record({
      leadId,
      type: "plan_change",
      actorId: actorId || null,
      payload,
    });
  } catch (e) {
    console.error("[planChangeLog] stamp failed:", e.message);
  }
};

module.exports = { record };
