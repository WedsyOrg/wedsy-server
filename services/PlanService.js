// P1 — PLAN SERVICE (inspiration + selection layers). One plan per lead,
// auto-created empty on first read. Looks snapshot their display facts at add
// (name / image / price chip) so catalog edits never rewrite history.
// Reactions (looks + moods) accept BOTH admin auth and the internal seam (the
// couple app later) and echo onto the activity spine.
const mongoose = require("mongoose");
const LeadPlan = require("../models/LeadPlan");
const Enquiry = require("../models/Enquiry");
const Decor = require("../models/Decor");
const DecorPackage = require("../models/DecorPackage");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const fmtINR = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? `₹${Number(v).toLocaleString("en-IN")}` : "");

const getOrCreate = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, { _id: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  let plan = await LeadPlan.findOne({ leadId });
  if (!plan) {
    try {
      plan = await LeadPlan.create({ leadId });
    } catch (e) {
      if (e && e.code === 11000) plan = await LeadPlan.findOne({ leadId }); // create race
      else throw e;
    }
  }
  return plan;
};

const getPlan = async (leadId) => (await getOrCreate(leadId)).toObject();

// ── Looks ─────────────────────────────────────────────────────────────────────
const addLook = async (leadId, { source, decorId, packageId, imageUrl, functionKey, categoryKey, round, talkingPoint } = {}, actorId) => {
  if (!["decor", "package", "upload"].includes(source)) throw err(400, 'source must be "decor" | "package" | "upload"');
  const plan = await getOrCreate(leadId);

  const snapshot = { name: "", image: "", priceChip: "" };
  const look = {
    source,
    decorId: null,
    packageId: null,
    imageUrl: "",
    functionKey: String(functionKey || "").slice(0, 60),
    categoryKey: String(categoryKey || "").slice(0, 60),
    round: Number.isFinite(Number(round)) ? Number(round) : 1,
    talkingPoint: String(talkingPoint || "").slice(0, 500),
    addedBy: actorId || null,
    addedAt: new Date(),
  };

  if (source === "decor") {
    if (!isId(decorId)) throw err(400, "Pass a decorId");
    const d = await Decor.findById(decorId, { name: 1, thumbnail: 1, image: 1, productTypes: 1 }).lean();
    if (!d) throw err(404, "Decor not found");
    look.decorId = d._id;
    snapshot.name = d.name || "";
    snapshot.image = d.thumbnail || d.image || "";
    const p = Array.isArray(d.productTypes) && d.productTypes[0] ? d.productTypes[0].sellingPrice : null;
    snapshot.priceChip = fmtINR(p);
  } else if (source === "package") {
    if (!isId(packageId)) throw err(400, "Pass a packageId");
    const p = await DecorPackage.findById(packageId, { name: 1, image: 1, variant: 1 }).lean();
    if (!p) throw err(404, "Package not found");
    look.packageId = p._id;
    snapshot.name = p.name || "";
    snapshot.image = p.image || "";
    snapshot.priceChip = fmtINR(p.variant && p.variant.mixedFlowers && p.variant.mixedFlowers.sellingPrice);
  } else {
    const url = String(imageUrl || "").trim();
    if (!url) throw err(400, "Pass an imageUrl for an upload look");
    look.imageUrl = url.slice(0, 1000);
    snapshot.image = look.imageUrl;
    snapshot.name = "Inspiration";
  }
  look.snapshot = snapshot;

  plan.looks.push(look);
  await plan.save();
  return plan.looks[plan.looks.length - 1].toObject();
};

// Whitelisted patch: shortlisted · talkingPoint · round · functionKey · categoryKey.
const patchLook = async (leadId, lookId, fields = {}) => {
  const plan = await getOrCreate(leadId);
  const look = plan.looks.id(lookId);
  if (!look) throw err(404, "Look not found");
  if (fields.shortlisted !== undefined) look.shortlisted = !!fields.shortlisted;
  if (fields.talkingPoint !== undefined) look.talkingPoint = String(fields.talkingPoint || "").slice(0, 500);
  if (fields.round !== undefined) {
    const r = Number(fields.round);
    if (!Number.isFinite(r) || r < 1) throw err(400, "round must be a positive number");
    look.round = r;
  }
  if (fields.functionKey !== undefined) look.functionKey = String(fields.functionKey || "").slice(0, 60);
  if (fields.categoryKey !== undefined) look.categoryKey = String(fields.categoryKey || "").slice(0, 60);
  await plan.save();
  return look.toObject();
};

const removeLook = async (leadId, lookId) => {
  const plan = await getOrCreate(leadId);
  const look = plan.looks.id(lookId);
  if (!look) throw err(404, "Look not found");
  look.deleteOne();
  await plan.save();
  return { ok: true };
};

// ── Reactions (looks + moods) ────────────────────────────────────────────────
const cleanReaction = ({ voice, kind, note, name, userId } = {}, { adminId = null } = {}) => {
  if (!["love", "pass"].includes(kind)) throw err(400, 'kind must be "love" | "pass"');
  const v = ["couple", "family", "wedsy"].includes(voice) ? voice : adminId ? "wedsy" : "couple";
  return {
    voice: v,
    kind,
    note: String(note || "").slice(0, 500),
    name: String(name || "").slice(0, 120),
    userId: userId && isId(userId) ? userId : null,
    adminId: adminId && isId(adminId) ? adminId : null,
    at: new Date(),
  };
};

// A "love" echoes onto the activity spine as a heart (fire-safe).
const echoHeart = async (leadId, reaction, what) => {
  if (reaction.kind !== "love") return;
  try {
    await require("./LeadActivityService").ingest(
      {
        leadId,
        userId: reaction.userId,
        kind: "heart",
        text: `${reaction.name || (reaction.voice === "wedsy" ? "The team" : "The couple")} loved ${what}`,
        meta: { note: reaction.note || "" },
        voice: reaction.voice === "wedsy" ? "wedsy" : "couple",
      },
      { adminId: reaction.adminId }
    );
  } catch (e) {
    console.error("[Plan] heart echo failed:", e.message);
  }
};

const reactToLook = async (leadId, lookId, body = {}, ctx = {}) => {
  const plan = await getOrCreate(leadId);
  const look = plan.looks.id(lookId);
  if (!look) throw err(404, "Look not found");
  const reaction = cleanReaction(body, ctx);
  look.reactions.push(reaction);
  await plan.save();
  await echoHeart(leadId, reaction, look.snapshot && look.snapshot.name ? `“${look.snapshot.name}”` : "a look");
  return look.toObject();
};

const reactToMood = async (leadId, body = {}, ctx = {}) => {
  const moodId = String(body.moodId || "").trim();
  if (!moodId) throw err(400, "Pass a moodId");
  const plan = await getOrCreate(leadId);
  const reaction = cleanReaction(body, ctx);
  plan.moodReactions.push({ moodId, kind: reaction.kind, note: reaction.note, voice: reaction.voice, name: reaction.name, at: reaction.at });
  await plan.save();
  await echoHeart(leadId, reaction, `the “${moodId}” mood`);
  return plan.toObject().moodReactions.slice(-1)[0];
};

const setStyleSignature = async (leadId, styleSignature) => {
  const plan = await getOrCreate(leadId);
  plan.styleSignature = String(styleSignature || "").slice(0, 300);
  await plan.save();
  return { styleSignature: plan.styleSignature };
};

module.exports = { getPlan, getOrCreate, addLook, patchLook, removeLook, reactToLook, reactToMood, setStyleSignature };
