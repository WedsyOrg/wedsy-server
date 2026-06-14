const Enquiry = require("../models/Enquiry");
const { callAnthropic } = require("../utils/anthropicQueue");
const JourneyService = require("./JourneyService");

const httpError = (status, message) => Object.assign(new Error(message), { status });

const SYSTEM_PROMPT =
  "You are Kiara, the founder's right hand at Wedsy, a Bengaluru wedding company. " +
  "Write a SHORT internal briefing on a lead for the sales rep about to work it. " +
  "Founder voice: warm, direct, confident, no fluff. 2–4 sentences, max ~70 words. " +
  "Use ONLY the facts provided — never invent names, dates, budgets, or preferences. " +
  "If a key fact is missing, say what's still unknown rather than guessing. " +
  "Lead with who they are and the event, then what they want, then the single most " +
  "useful next move. Plain prose, no bullet points, no markdown, no preamble.";

// Compose the captured facts into a compact, model-friendly brief. Returns
// { facts, hasData } — hasData is false when there's nothing meaningful yet.
const composeFacts = (lead, journeyEntries = []) => {
  const q = lead.qualificationData || {};
  const ka = (lead.additionalInfo && lead.additionalInfo.kiaraAnswers) || {};
  const lines = [];
  // Every lead has name/source/stage — those alone don't count as "data".
  // `substantive` counts facts that actually tell the rep something.
  const BOILERPLATE = new Set(["Name", "Source", "Stage"]);
  let substantive = 0;
  const add = (label, val) => {
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      lines.push(`${label}: ${val}`);
      if (!BOILERPLATE.has(label)) substantive++;
    }
  };

  add("Name", lead.name);
  const couple = [q.groomName, q.brideName].filter(Boolean).join(" & ");
  add("Couple", couple);
  add("Source", lead.marketingSource || lead.source);
  add("Stage", lead.stage);
  add("Wedding style", q.weddingStyle || ka.weddingStyle);
  add("City", ka.city);
  add("Event date", ka.eventDate);
  add("Number of events", ka.numberOfEvents);
  add("Venue status", q.venueStatus);
  add("Venue", q.venueName || q.venueArea);
  const services = (q.servicesRequired || []).join(", ") || ka.servicesRequired;
  add("Services wanted", services);
  if (q.budgetAmount) add("Budget", `₹${q.budgetAmount}`);
  add("Budget note", q.budgetNote || ka.budget);
  add("Email on file", q.email || lead.email ? "yes" : "");
  add("Qualified", lead.qualified ? "yes" : "");

  // Events captured (dates) — a real signal of seriousness.
  const eventDays = (lead.events || []).flatMap((e) => e.eventDays || []);
  if (eventDays.length) add("Events in system", `${eventDays.length} day(s)`);

  // Last few journey beats for momentum context (not counted as "data" — the
  // birth event is always present).
  const recent = journeyEntries.slice(-4).map((e) => e.title).filter(Boolean);
  if (recent.length) lines.push(`Recent activity: ${recent.join("; ")}`);

  // "Meaningful" = at least one substantive captured fact beyond name/source/stage.
  const hasData = substantive >= 1;
  return { facts: lines.join("\n"), hasData };
};

const firstTextBlock = (response) => {
  const content = response && response.data && Array.isArray(response.data.content) ? response.data.content : [];
  const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text.trim() : null;
};

// Generate (or return cached) the summary. force=true regenerates.
const getSummary = async (enquiryId, { force = false } = {}) => {
  const lead = await Enquiry.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");

  if (!force && lead.kiaraSummary && lead.kiaraSummary.text) {
    return { text: lead.kiaraSummary.text, generatedAt: lead.kiaraSummary.generatedAt, cached: true };
  }

  let journeyEntries = [];
  try {
    journeyEntries = (await JourneyService.buildJourney(enquiryId)).entries;
  } catch (_) { /* journey is advisory context */ }

  const { facts, hasData } = composeFacts(lead.toObject(), journeyEntries);

  // Empty-data case: graceful, no model call, not cached (so it refreshes once
  // real data lands).
  if (!hasData) {
    return {
      text: "Not enough info yet — Kiara hasn't captured the couple, their event, or what they want. Call them to discover the basics.",
      generatedAt: null,
      cached: false,
      empty: true,
    };
  }

  const response = await callAnthropic({
    model: "claude-sonnet-4-5",
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Lead facts:\n${facts}\n\nWrite the briefing.` }],
  });
  const text = firstTextBlock(response);
  if (!text) throw httpError(502, "Kiara couldn't compose a summary — try again");

  const generatedAt = new Date();
  lead.kiaraSummary = { text, generatedAt };
  await lead.save();
  return { text, generatedAt, cached: false };
};

module.exports = { getSummary, composeFacts, SYSTEM_PROMPT };
