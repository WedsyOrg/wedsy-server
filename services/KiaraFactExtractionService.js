/* ⚠️ REVIEW-REQUIRED (Kiara IG/WA fixes, Phase 2 flagged) ⚠️
 *
 * Conversation → structured facts. A NEW Anthropic call on real customer
 * transcripts, so it is NOT considered final — it is parked behind this seam for
 * human review of: the prompt, the trigger point, and the cost shape.
 *
 * Design (per brief):
 *   - Model: claude-haiku-4-5 (the cheap model, consistent with the MB7b summary).
 *   - Runs ONCE per lead, at handoff / lead-creation — NOT per message. Guarded
 *     by additionalInfo.factsExtractedAt so a re-trigger is a no-op.
 *   - Writes additionalInfo.adFormAnswers (the idiom the journey birth event +
 *     facts panel already read) — never overwrites a non-empty value.
 *   - Fire-safe: a failure must never break lead creation.
 *
 * COST SHAPE to review: 1 Haiku call per lead that reaches handoff (max_tokens
 * 300, one short system + the transcript). Bounded to once-per-lead by the flag.
 */
const Enquiry = require("../models/Enquiry");
const WAAgentMessageRepository = require("../repositories/WAAgentMessageRepository");
const { callAnthropic } = require("../utils/anthropicQueue");
// Fence-tolerant parse for extractor output — models intermittently wrap the
// JSON in a ```json fence or add prose, which broke the raw JSON.parse.
const parseModelJson = require("../utils/parseModelJson");

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT =
  "You mine a chat transcript between a wedding-planning assistant (Kiara) and a " +
  "prospective customer into structured facts. Use ONLY what the customer actually " +
  "said — never invent. Leave a field as an empty string if it wasn't mentioned. " +
  "Respond ONLY with valid JSON, no markdown, no preamble. Format: " +
  '{"eventType":"","city":"","eventDate":"","numberOfEvents":"","venueStatus":"",' +
  '"venueName":"","servicesRequired":"","budget":"","weddingStyle":"","guests":"",' +
  '"summary":""}';

const firstTextBlock = (response) => {
  const content = response && response.data && Array.isArray(response.data.content)
    ? response.data.content : [];
  const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text : null;
};

const ANSWER_KEYS = [
  "eventType", "city", "eventDate", "numberOfEvents", "venueStatus",
  "venueName", "servicesRequired", "budget", "weddingStyle", "guests",
];

// Build the [{role, content}] history Anthropic expects from the stored thread.
const historyFor = async (conversationPhone) => {
  const rows = await WAAgentMessageRepository.getHistory(conversationPhone);
  return (rows || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content || m.message || "",
  }));
};

// The trigger entry point. leadId + the conversation key (phone/igsid).
const extractFactsForLead = async (leadId, conversationPhone) => {
  try {
    const lead = await Enquiry.findById(leadId);
    if (!lead) return null;
    // Once-only guard.
    if (lead.additionalInfo && lead.additionalInfo.factsExtractedAt) return null;

    const history = await historyFor(conversationPhone);
    if (!history.length) return null;

    const response = await callAnthropic({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        ...history,
        { role: "user", content: "Extract the wedding facts from the conversation above as JSON." },
      ],
    });
    const text = firstTextBlock(response);
    if (!text) return null;

    // Fence-tolerant: strip a ```json fence / surrounding prose before parsing.
    const facts = parseModelJson(text);
    if (facts === null) {
      // Genuinely unparseable — keep the safe fallback (return null), and log a
      // truncated raw snippet next to the existing error line so we can see what
      // the model actually sent.
      const snippet = String(text).replace(/\s+/g, " ").slice(0, 300);
      console.error("[KiaraFactExtraction] JSON parse failed:", `raw="${snippet}"`);
      return null;
    }

    // Write to additionalInfo.adFormAnswers (fill-only-empty), plus the guard.
    const ai = lead.additionalInfo || {};
    const existing = ai.adFormAnswers || {};
    const merged = { ...existing };
    for (const k of ANSWER_KEYS) {
      const v = facts && facts[k];
      if (v && String(v).trim() && !merged[k]) merged[k] = String(v).slice(0, 2000);
    }
    lead.additionalInfo = {
      ...ai,
      adFormAnswers: merged,
      factsExtractedAt: new Date(),
      ...(facts && facts.summary ? { kiaraFactSummary: String(facts.summary).slice(0, 1000) } : {}),
    };
    lead.markModified("additionalInfo");
    await lead.save();
    return merged;
  } catch (e) {
    console.error("[KiaraFactExtraction] extractFactsForLead failed:", e.message);
    return null;
  }
};

module.exports = { extractFactsForLead, MODEL, SYSTEM_PROMPT, ANSWER_KEYS };
