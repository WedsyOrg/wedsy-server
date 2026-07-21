// P2 — SNAPSHOT SERVICE (the membrane). Publish composes the frozen render
// payload SERVER-SIDE and stores it verbatim; the couple app renders content
// with zero live reads. P5 rides along here: the discount grant + decide + the
// décor-lane feed. P6's composer read lives in PlanComposerService.
const mongoose = require("mongoose");
const PlanSnapshot = require("../models/PlanSnapshot");
const DealDiscount = require("../models/DealDiscount");
const Enquiry = require("../models/Enquiry");
const Decor = require("../models/Decor");
const DecorPackage = require("../models/DecorPackage");
const LeadPlan = require("../models/LeadPlan");
const DraftEventService = require("./DraftEventService");
const SettingsService = require("./SettingsService");
const AdminNotificationService = require("./AdminNotificationService");
const { filterAssignableIds } = require("../utils/assignable");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

// ── Content composers (all output is FROZEN — plain data, no ids the couple
//    app must re-resolve) ────────────────────────────────────────────────────
// `full` (A6) = the couple event-view fidelity: every item/qty/variant/
// setup/add-on/per-line price. EXCLUDED always: admin_notes (team-only).
// Cost prices don't exist on the item subdocs — nothing to strip there.
const composeDraftContent = async (leadId, eventId, { full = false } = {}) => {
  const event = await DraftEventService.getDraft(leadId, eventId);
  const totals = await DraftEventService.totalsFor(event);
  const decorIds = [];
  const packageIds = [];
  for (const day of event.eventDays) {
    for (const i of day.decorItems) if (i.decor) decorIds.push(i.decor);
    for (const p of day.packages) if (p.package) packageIds.push(p.package);
  }
  const [decors, packages] = await Promise.all([
    decorIds.length ? Decor.find({ _id: { $in: decorIds } }, { name: 1, thumbnail: 1, image: 1 }).lean() : [],
    packageIds.length ? DecorPackage.find({ _id: { $in: packageIds } }, { name: 1 }).lean() : [],
  ]);
  const decorName = new Map(decors.map((d) => [String(d._id), d]));
  const pkgName = new Map(packages.map((p) => [String(p._id), p.name]));

  return {
    draftName: event.draftName || event.name,
    days: event.eventDays.map((day) => ({
      name: day.name,
      date: day.date,
      venue: day.venue,
      eventSpace: day.eventSpace || "",
      items: [
        ...day.decorItems.map((i) => ({
          kind: "decor",
          name: (decorName.get(String(i.decor)) || {}).name || "Decor",
          image: (decorName.get(String(i.decor)) || {}).thumbnail || "",
          category: i.category,
          quantity: i.quantity,
          price: i.price,
          ...(full
            ? {
                variant: i.variant,
                productVariant: i.productVariant || "",
                unit: i.unit || "",
                platform: !!i.platform,
                flooring: i.flooring || "",
                dimensions: i.dimensions || {},
                addOns: (i.addOns || []).map((a) => ({ name: a.name, price: a.price, notes: a.notes || "" })),
                included: i.included || [],
                notes: i.user_notes || "", // couple-facing; admin_notes stays internal
                setupLocationImage: i.setupLocationImage || "",
              }
            : {}),
        })),
        ...day.packages.map((p) => ({
          kind: "package",
          name: pkgName.get(String(p.package)) || "Package",
          variant: p.variant,
          price: p.price,
        })),
        ...day.customItems.map((c) => ({ kind: "custom", name: c.name, quantity: c.quantity, price: c.price, eventLevel: !!c.includeInTotalSummary })),
        ...day.mandatoryItems
          .filter((m) => m.itemRequired)
          .map((m) => ({ kind: "mandatory", name: m.title, price: m.price, eventLevel: !!m.includeInTotalSummary })),
      ],
    })),
    totals: {
      days: totals.days,
      eventLevelItems: totals.eventLevelItems,
      gross: totals.gross,
      discount: totals.discount,
      net: totals.net,
    },
  };
};

const composeOptionsContent = async (leadId, lookIds) => {
  const plan = await LeadPlan.findOne({ leadId }).lean();
  const looks = (plan && plan.looks) || [];
  const wanted = Array.isArray(lookIds) && lookIds.length ? new Set(lookIds.map(String)) : null;
  const chosen = looks.filter((l) => (wanted ? wanted.has(String(l._id)) : l.shortlisted));
  return {
    looks: chosen.map((l) => ({
      lookId: String(l._id),
      name: (l.snapshot && l.snapshot.name) || "",
      image: (l.snapshot && l.snapshot.image) || l.imageUrl || "",
      priceChip: (l.snapshot && l.snapshot.priceChip) || "",
      functionKey: l.functionKey || "",
      categoryKey: l.categoryKey || "",
      talkingPoint: l.talkingPoint || "",
      round: l.round || 1,
    })),
  };
};

const composeComparisonContent = async (leadId, eventIds = []) => {
  const rows = [];
  for (const id of eventIds) {
    const event = await DraftEventService.getDraft(leadId, id);
    const totals = await DraftEventService.totalsFor(event);
    rows.push({ draftName: event.draftName || event.name, gross: totals.gross, discount: totals.discount, net: totals.net, days: totals.days });
  }
  return { drafts: rows };
};

// ── Publish ──────────────────────────────────────────────────────────────────
const publish = async (leadId, { kind, title, coverNote, pricingVisible, forDecision, eventId, eventIds, lookIds, blocks, full } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  if (!["reveal", "options", "draft", "comparison"].includes(kind)) {
    throw err(400, 'kind must be "reveal" | "options" | "draft" | "comparison"');
  }
  let content = {};
  if (kind === "draft") {
    if (!isId(eventId)) throw err(400, "A draft snapshot needs an eventId");
    content = await composeDraftContent(leadId, eventId, { full: !!full });
  } else if (kind === "options") {
    content = await composeOptionsContent(leadId, lookIds);
    if (!content.looks.length) throw err(422, "Nothing shortlisted — nothing to publish.");
  } else if (kind === "comparison") {
    const ids = Array.isArray(eventIds) ? eventIds : [];
    if (!ids.length) throw err(400, "A comparison needs eventIds");
    content = await composeComparisonContent(leadId, ids);
  } else {
    content = { blocks: Array.isArray(blocks) ? blocks : [] }; // reveal — frozen verbatim
  }

  const snap = await PlanSnapshot.create({
    leadId,
    kind,
    title: String(title || "").slice(0, 200),
    coverNote: String(coverNote || "").slice(0, 1000),
    pricingVisible: !!pricingVisible,
    forDecision: !!forDecision,
    content,
    publishedBy: actorId || null,
    at: new Date(),
  });

  try {
    await require("./LeadActivityService").ingest(
      {
        leadId,
        kind: "other",
        text: `Published ${kind === "draft" ? `the "${content.draftName}" draft` : `a ${kind}`} to the couple`,
        meta: { snapshotId: String(snap._id), snapshotKind: kind, pricingVisible: !!pricingVisible, forDecision: !!forDecision },
        voice: "wedsy",
      },
      { adminId: actorId }
    );
  } catch (e) {
    console.error("[PlanSnapshot] activity echo failed:", e.message);
  }
  return snap.toObject();
};

// A4 — the WHOLE-WEDDING presentation publish (price-free by default): all
// events' selected themes + looks in one frozen snapshot. Returns whether it
// was the FIRST send (FE: "Send to {couple}?" vs "Update their dashboard?").
const publishPresent = async (leadId, { kind = "options", pricingVisible = false, coverNote, title } = {}, actorId) => {
  if (!["options", "reveal"].includes(kind)) throw err(400, 'present kind must be "options" | "reveal"');
  const plan = await LeadPlan.findOne({ leadId }).lean();
  const looks = (plan && plan.looks) || [];
  const selectedThemes = (plan && plan.selectedThemes) || [];
  if (!looks.length && !selectedThemes.length) throw err(422, "Nothing on the plan to present yet.");

  const DecorTheme = require("../models/DecorTheme");
  const themeIds = [...new Set(selectedThemes.map((t) => String(t.themeId)))];
  const themes = themeIds.length ? await DecorTheme.find({ _id: { $in: themeIds } }).lean() : [];
  const themeById = new Map(themes.map((t) => [String(t._id), t]));

  const fns = [...new Set([...selectedThemes.map((t) => t.functionKey), ...looks.map((l) => l.functionKey || "")])].filter(
    (f) => f !== ""
  );
  const ungrouped = looks.filter((l) => !l.functionKey);
  const lookRow = (l) => ({
    lookId: String(l._id),
    name: (l.snapshot && l.snapshot.name) || "",
    image: (l.snapshot && l.snapshot.image) || l.imageUrl || "",
    categoryKey: l.categoryKey || "",
    talkingPoint: l.talkingPoint || "",
    themeName: l.themeName || "",
    provenance: l.provenance || "direct",
    shortlisted: !!l.shortlisted,
    ...(pricingVisible ? { priceChip: (l.snapshot && l.snapshot.priceChip) || "" } : {}), // price-free unless toggled
  });
  const content = {
    presentation: true,
    functions: fns.map((fn) => {
      const sel = selectedThemes.find((t) => t.functionKey === fn);
      const theme = sel ? themeById.get(String(sel.themeId)) : null;
      return {
        functionKey: fn,
        theme: theme
          ? { themeId: String(theme._id), name: theme.name, backgroundImageUrl: theme.backgroundImageUrl || "" }
          : sel
            ? { themeId: String(sel.themeId), name: sel.themeName, backgroundImageUrl: "" }
            : null,
        looks: looks.filter((l) => (l.functionKey || "") === fn).map(lookRow),
      };
    }),
    ...(ungrouped.length ? { unassignedLooks: ungrouped.map(lookRow) } : {}),
  };

  const wasFirstSend = !(await PlanSnapshot.exists({ leadId, "content.presentation": true }));
  const snap = await PlanSnapshot.create({
    leadId,
    kind,
    title: String(title || "Your wedding, three ways").slice(0, 200),
    coverNote: String(coverNote || "").slice(0, 1000),
    pricingVisible: !!pricingVisible,
    forDecision: false,
    content,
    publishedBy: actorId || null,
    at: new Date(),
  });
  try {
    await require("./LeadActivityService").ingest(
      {
        leadId,
        kind: "other",
        text: wasFirstSend ? "Presented the wedding to the couple (first send)" : "Updated the couple's presentation",
        meta: { snapshotId: String(snap._id), snapshotKind: kind, presentation: true, resend: !wasFirstSend },
        voice: "wedsy",
      },
      { adminId: actorId }
    );
  } catch (e) {
    console.error("[Present] activity echo failed:", e.message);
  }
  return { snapshot: snap.toObject(), wasFirstSend };
};

const list = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  return await PlanSnapshot.find({ leadId }, { content: 0 }).sort({ at: -1 }).lean();
};

const get = async (leadId, snapshotId) => {
  if (!isId(leadId) || !isId(snapshotId)) throw err(400, "Invalid id");
  const snap = await PlanSnapshot.findOne({ _id: snapshotId, leadId }).lean();
  if (!snap) throw err(404, "Snapshot not found");
  return snap;
};

// ── P5: deal discount ────────────────────────────────────────────────────────
const grantDiscount = async (leadId, eventId, { amount, pct } = {}, actorId) => {
  const event = await DraftEventService.getDraft(leadId, eventId);
  const totals = await DraftEventService.totalsFor(event);
  const gross = totals.gross;
  const p = Number(pct) || 0;
  let amt = p > 0 ? Math.round((gross * p) / 100) : Math.round(Number(amount) || 0);
  if (amt <= 0) throw err(400, "Give the discount an amount or a percentage.");
  const freePct = await SettingsService.get("dealDiscount.freePct");
  const equivalentPct = gross > 0 ? (amt / gross) * 100 : 100;
  const auto = equivalentPct <= (Number(freePct) || 0);

  const doc = await DealDiscount.create({
    leadId,
    eventId,
    amount: amt,
    pct: p,
    status: auto ? "approved" : "pending",
    givenBy: actorId || null,
    approvedBy: auto ? actorId || null : null,
    at: new Date(),
    decidedAt: auto ? new Date() : null,
  });

  if (!auto) {
    // Above the free threshold → the approvals ladder hears about it.
    try {
      const lead = await Enquiry.findById(leadId, { name: 1, assignedTo: 1 }).lean();
      const Admin = require("../models/Admin");
      const recipients = new Set((await require("./TriageService").revenueHeadIds()).map(String));
      if (lead && lead.assignedTo) {
        const owner = await Admin.findById(lead.assignedTo, { reportingManagerId: 1 }).lean();
        if (owner && owner.reportingManagerId) recipients.add(String(owner.reportingManagerId));
      }
      recipients.delete(String(actorId || ""));
      const live = await filterAssignableIds([...recipients]);
      if (live.length) {
        await AdminNotificationService.notify(live, {
          type: "discount_approval",
          title: `Discount approval — ₹${amt.toLocaleString("en-IN")} on ${lead ? lead.name : "a lead"}`,
          message: `${equivalentPct.toFixed(1)}% of the "${event.draftName || event.name}" draft — above the ${freePct}% free band.`,
          leadId,
          payload: { discountId: String(doc._id), eventId: String(eventId), amount: amt },
        });
      }
    } catch (e) {
      console.error("[DealDiscount] approval notify failed:", e.message);
    }
  }
  return doc.toObject();
};

const decideDiscount = async (discountId, decision, actorId) => {
  if (!isId(discountId)) throw err(400, "Invalid id");
  if (!["approve", "reject"].includes(decision)) throw err(400, 'decision must be "approve" | "reject"');
  const doc = await DealDiscount.findById(discountId);
  if (!doc) throw err(404, "Discount not found");
  if (doc.status !== "pending") throw err(400, "Already decided");
  const lead = await Enquiry.findById(doc.leadId, { assignedTo: 1 }).lean();
  const { actorHasApprovePermission, isManagerOfAssigned } = require("../controllers/disqualify");
  const eligible = (await actorHasApprovePermission(actorId)) || (await isManagerOfAssigned(actorId, lead && lead.assignedTo));
  if (!eligible) throw err(403, "Not yours to decide");
  doc.status = decision === "approve" ? "approved" : "rejected";
  doc.approvedBy = actorId || null;
  doc.decidedAt = new Date();
  await doc.save();
  return doc.toObject();
};

const listDiscounts = async (leadId, eventId) => {
  if (!isId(leadId) || !isId(eventId)) throw err(400, "Invalid id");
  return await DealDiscount.find({ leadId, eventId }).sort({ at: -1 }).lean();
};

// ── P5: the décor-lane feed ──────────────────────────────────────────────────
const feedDecorLane = async (leadId, eventId, actorId) => {
  const event = await DraftEventService.getDraft(leadId, eventId);
  const totals = await DraftEventService.totalsFor(event);
  const decorGross = totals.days.reduce((s, d) => s + (d.decorItems || 0) + (d.packages || 0), 0);
  // Net décor: scale the décor share by the overall discount ratio.
  const value = totals.gross > 0 ? Math.round(decorGross * (totals.net / totals.gross)) : decorGross;
  if (value <= 0) throw err(422, "The draft has no décor value to feed yet.");

  const LeadLane = require("../models/LeadLane");
  const lane = await LeadLane.findOne({ leadId, key: "decor" }).lean();
  if (!lane) throw err(404, "No Décor lane on this lead yet — assemble the team first.");

  const LeadLaneService = require("./LeadLaneService");
  const result = await LeadLaneService.proposePrice(leadId, lane._id, value, actorId, true);
  await LeadLaneService.autoEntryByLaneId(lane._id, "lane_priced", `Priced from draft "${event.draftName || event.name}" — ₹${value.toLocaleString("en-IN")}`);
  return { laneId: String(lane._id), value, price: result.price };
};

module.exports = { publish, publishPresent, list, get, grantDiscount, decideDiscount, listDiscounts, feedDecorLane };
