// P6 — MOOD LIBRARY + THE REVEAL COMPOSER READS. Everything composed
// DEFENSIVELY: every leg optional, empty is fine, no leg may throw the read.
const Enquiry = require("../models/Enquiry");
const LeadPlan = require("../models/LeadPlan");
const Venue = require("../models/Venue");
const Decor = require("../models/Decor");
const SettingsService = require("./SettingsService");

const err = (status, message) => Object.assign(new Error(message), { status });

// Lane-scoped mood read (like engagement-items): active moods only.
const moodsFor = async () => {
  const items = (await SettingsService.get("moods.items")) || [];
  return items.filter((m) => m && m.active !== false);
};

// Pull-quotes from the brief — AI when configured, sentence-split fallback.
// RETURN-ONLY: nothing is saved.
const heardYouQuotes = async (lead) => {
  const brief = (lead.leadBrief && lead.leadBrief.text) || "";
  if (!brief.trim()) return [];
  try {
    const { summariseBrief } = require("./AIBriefService");
    const ai = await summariseBrief(lead, []);
    const text = typeof ai === "string" ? ai : (ai && ai.text) || "";
    if (text.trim()) {
      return text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 15)
        .slice(0, 3);
    }
  } catch {
    // AI not configured / failed — fall through to the plain split.
  }
  return brief
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15)
    .slice(0, 3);
};

const styleWords = (lead, plan) => {
  const src = [
    (plan && plan.styleSignature) || "",
    (lead.leadBrief && lead.leadBrief.text) || "",
  ]
    .join(" ")
    .toLowerCase();
  const VOCAB = ["royal", "pastel", "minimal", "garden", "traditional", "modern", "floral", "gold", "temple", "beach", "vintage", "boho", "grand", "intimate"];
  return VOCAB.filter((w) => src.includes(w));
};

const reveal = async (leadId) => {
  const lead = await Enquiry.findById(leadId, {
    name: 1, leadBrief: 1, qualificationData: 1, dealValue: 1,
  }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const plan = await LeadPlan.findOne({ leadId }).lean();

  // ── autoBlocks — each leg guarded ──
  const autoBlocks = [];
  autoBlocks.push({
    kind: "cover",
    title: lead.name,
    eventDate: (lead.qualificationData && lead.qualificationData.eventDate) || null,
  });
  try {
    const quotes = await heardYouQuotes(lead);
    if (quotes.length) autoBlocks.push({ kind: "heard-you", quotes });
  } catch {}
  try {
    const lovedMoodIds = [...new Set(((plan && plan.moodReactions) || []).filter((r) => r.kind === "love").map((r) => r.moodId))];
    if (lovedMoodIds.length) {
      const moods = (await moodsFor()).filter((m) => lovedMoodIds.includes(m.id));
      if (moods.length) autoBlocks.push({ kind: "story", moods });
    }
  } catch {}
  try {
    const days = ((lead.qualificationData && lead.qualificationData.eventDays) || []).map((d, i) => ({
      date: d.date || null,
      functions: (d.functions || []).map((f) => f.type).filter(Boolean),
      label: `Day ${i + 1}`,
    }));
    if (days.length) autoBlocks.push({ kind: "journey", days });
  } catch {}
  autoBlocks.push({
    kind: "platform",
    note: "One place for everything — your looks, your drafts, your decisions, your payments.",
  });

  // ── suggestions — best-effort, empty ok ──
  const suggestions = { venues: [], decorSparks: [] };
  try {
    const city = String((lead.qualificationData && lead.qualificationData.city) || "").trim();
    const q = city ? { city: new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } : {};
    suggestions.venues = (await Venue.find(q, { name: 1, city: 1 }).limit(4).lean()).map((v) => ({
      venueId: String(v._id),
      name: v.name,
      city: v.city || "",
    }));
  } catch {}
  try {
    const words = styleWords(lead, plan);
    const q = {
      productVisibility: true,
      ...(words.length ? { tags: { $in: words.map((w) => new RegExp(w, "i")) } } : {}),
    };
    suggestions.decorSparks = (await Decor.find(q, { name: 1, thumbnail: 1, image: 1, category: 1 }).limit(8).lean()).map((d) => ({
      decorId: String(d._id),
      name: d.name,
      image: d.thumbnail || d.image || "",
      category: d.category,
    }));
  } catch {}

  return { autoBlocks, suggestions, styleSignature: (plan && plan.styleSignature) || "" };
};

module.exports = { moodsFor, reveal };
