// Journey v2 — AI drafting for the two human rituals: the canonical lead brief
// (V1) and the client-facing MOM recap (V2). BOTH are review-then-act: these
// functions RETURN text for a human to edit/approve — they never save a brief
// and never send anything to a client.
//
// Same Anthropic plumbing as Kiara: the shared in-process queue (429 backoff,
// ANTHROPIC_API_URL test seam) + the crash-safe first-text-block read. Model is
// the cheap one (consistent with KiaraFactExtraction/KiaraSummary).
const { callAnthropic } = require("../utils/anthropicQueue");

const MODEL = "claude-haiku-4-5";

const httpError = (status, message) => Object.assign(new Error(message), { status });

const firstTextBlock = (response) => {
  const content =
    response && response.data && Array.isArray(response.data.content)
      ? response.data.content
      : [];
  const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text : null;
};

// The discovery fields worth summarising (label → value), skipping empties.
const discoveryLines = (lead) => {
  const q = (lead && lead.qualificationData) || {};
  const pairs = [
    ["Couple", [q.brideName, q.groomName].filter(Boolean).join(" & ")],
    ["Wedding style", q.weddingStyle],
    ["Event date", q.eventDate],
    ["City", q.city],
    ["Venue status", q.venueStatus],
    ["Venue", q.venueName || q.venueTypeWanted],
    ["Venue area", q.venueArea],
    ["Budget", q.budgetAmount ? `₹${q.budgetAmount}` : q.venueBudget],
    ["Budget note", q.budgetNote],
    ["Services required", (q.servicesRequired || []).join(", ")],
    ["Destination wedding", q.destinationWedding ? "yes" : ""],
    ["Additional notes", q.additionalNotes],
  ];
  return pairs.filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`);
};

// V1 — one tight brief paragraph from the qualifier's raw material.
// notes: [{ text, author, when }] (the qualifierNoteFeed the controller built).
const summariseBrief = async (lead, notes = []) => {
  const noteLines = (notes || [])
    .filter((n) => n && n.text)
    .map((n) => `- ${n.text}${n.author ? ` (${n.author})` : ""}`);
  const input = [
    `Lead: ${lead.name || "Unknown couple"}`,
    ...discoveryLines(lead),
    noteLines.length ? "Qualifier notes:" : "",
    ...noteLines,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await callAnthropic({
    model: MODEL,
    max_tokens: 300,
    system:
      "You write the CANONICAL LEAD BRIEF for a wedding-planning CRM: ONE tight paragraph " +
      "(3-5 sentences, no headings, no bullets, no preamble) that tells a teammate everything " +
      "that matters before touching this lead — who decides, the style/vision, budget posture, " +
      "timing pressures, and how to win. Use ONLY the facts provided; never invent. " +
      "Write in the clipped, confident register of an internal ops note.",
    messages: [{ role: "user", content: `${input}\n\nWrite the brief now.` }],
  });
  const text = firstTextBlock(response);
  if (!text) throw httpError(502, "AI couldn't draft the brief — try again");
  return { text: text.trim() };
};

// V2 — a warm client-facing recap from the meeting's MOM. Review-then-send.
const clientBriefFromMOM = async (momText, lead) => {
  const q = (lead && lead.qualificationData) || {};
  const clientName = q.brideName || q.groomName || (lead && lead.name) || "there";
  const response = await callAnthropic({
    model: MODEL,
    max_tokens: 350,
    system:
      "You turn internal minutes-of-meeting into a SHORT, warm WhatsApp-ready recap for the " +
      "client of a wedding-planning company (Wedsy). 3-5 sentences: greet them by first name, " +
      "recap the decisions in their language (no internal jargon, no prices unless the minutes " +
      "explicitly agreed them with the client), state the next steps and who does what, close " +
      "warmly. Use ONLY what the minutes say; never invent commitments.",
    messages: [
      {
        role: "user",
        content: `Client first name: ${clientName}\nMinutes of meeting:\n${momText}\n\nWrite the client recap now.`,
      },
    ],
  });
  const text = firstTextBlock(response);
  if (!text) throw httpError(502, "AI couldn't draft the client brief — try again");
  return { text: text.trim() };
};

module.exports = { summariseBrief, clientBriefFromMOM, MODEL };
