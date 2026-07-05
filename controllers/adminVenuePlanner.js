/**
 * controllers/adminVenuePlanner.js — MB-V2 P1: the Lead Planner's venue lane.
 *
 * VenueShortlist CRUD (one per CRM enquiry, venue-owned storage), present-link
 * management, and the D2 linkage: the FIRST venue-touching action for a
 * (shortlist, venue) pair — a hold request or a site visit — creates the
 * owner-visible VenueEnquiry {source:"wedsy", crmLeadRef}, deduped by phone,
 * so the venue always sees a real lead behind wedsy-side activity.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueShortlist = require("../models/VenueShortlist");
const VenueSiteVisit = require("../models/VenueSiteVisit");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const { logActivity } = require("../utils/venueActivity");

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

const strField = (v, field, maxLen, { required = false } = {}) => {
  if (v === undefined || v === null || v === "") {
    return required ? { ok: false, message: `${field} is required` } : { ok: true, value: "" };
  }
  if (typeof v !== "string") return { ok: false, message: `${field} must be a string` };
  const t = v.trim();
  if (required && !t) return { ok: false, message: `${field} is required` };
  if (t.length > maxLen) return { ok: false, message: `${field} exceeds ${maxLen} characters` };
  return { ok: true, value: t };
};

const adminName = (req) => (req.auth && req.auth.user && req.auth.user.name) || "Wedsy admin";

const ITEM_VENUE_FIELDS = "name slug zone city venueType pricing.perPlate coverPhoto spaces tagline status";

const loadShortlist = async (id, res) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: "Invalid shortlist id" });
    return null;
  }
  const shortlist = await VenueShortlist.findById(id);
  if (!shortlist) {
    res.status(404).json({ message: "Shortlist not found" });
    return null;
  }
  return shortlist;
};

const shapedShortlist = async (shortlist) => {
  const doc = shortlist.toObject ? shortlist.toObject() : shortlist;
  const venueIds = doc.items.map((i) => i.venue);
  const venues = await Venue.find({ _id: { $in: venueIds } }).select(ITEM_VENUE_FIELDS).lean();
  const byId = Object.fromEntries(venues.map((v) => [String(v._id), v]));
  const visitIds = doc.items.map((i) => i.visitRef).filter(Boolean);
  const holdIds = doc.items.map((i) => i.holdRef).filter(Boolean);
  const [visits, holds] = await Promise.all([
    visitIds.length ? VenueSiteVisit.find({ _id: { $in: visitIds } }).lean() : [],
    holdIds.length ? VenueHold.find({ _id: { $in: holdIds } }).select("status dates expiresAt").lean() : [],
  ]);
  const visitById = Object.fromEntries(visits.map((v) => [String(v._id), v]));
  const holdById = Object.fromEntries(holds.map((h) => [String(h._id), h]));
  doc.items = doc.items.map((i) => ({
    ...i,
    venue: byId[String(i.venue)] || { _id: i.venue },
    hold: i.holdRef ? holdById[String(i.holdRef)] || null : null,
    visit: i.visitRef ? visitById[String(i.visitRef)] || null : null,
  }));
  return doc;
};

// ─── D2 linkage ────────────────────────────────────────────────────────────

const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

// Find-or-create the owner-visible lead for (shortlist couple, venue).
// Dedup by phone: an existing enquiry on this venue with the same normalized
// phone is reused (and back-linked to the CRM lead if it wasn't yet).
const ensureLinkedEnquiry = async (shortlist, venueId, actorName) => {
  const digits = last10(shortlist.couplePhone);
  let enquiry = null;
  if (digits.length === 10) {
    const tail = new RegExp(`${digits}$`);
    enquiry = await VenueEnquiry.findOne({
      venueId,
      $or: [{ couplePhone: tail }, { phone: tail }],
    });
  }
  if (enquiry) {
    if (!enquiry.crmLeadRef) {
      enquiry.crmLeadRef = shortlist.crmEnquiryId;
      await enquiry.save();
    }
    return enquiry;
  }
  enquiry = await VenueEnquiry.create({
    venueId,
    coupleName: shortlist.coupleName || "Wedsy couple",
    couplePhone: shortlist.couplePhone || "",
    name: shortlist.coupleName || "Wedsy couple",
    phone: shortlist.couplePhone || "",
    source: "wedsy",
    crmLeadRef: shortlist.crmEnquiryId,
    activities: [{ type: "created", description: "Lead created by Wedsy planner", timestamp: new Date() }],
  });
  logActivity({
    venue: venueId,
    actorType: "wedsy_team",
    actorName,
    action: "planner_lead_linked",
    entity: "enquiry",
    field: "crmLeadRef",
    new: JSON.stringify(shortlist.crmEnquiryId),
    severity: "normal",
  });
  return enquiry;
};

// ─── Shortlist CRUD ────────────────────────────────────────────────────────

const createShortlist = async (req, res) => {
  try {
    const body = req.body || {};
    const idV = strField(body.crmEnquiryId, "crmEnquiryId", 100, { required: true });
    if (!idV.ok) return res.status(400).json({ message: idV.message });
    const nameV = strField(body.coupleName, "coupleName", 200);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const phoneV = strField(body.couplePhone, "couplePhone", 20);
    if (!phoneV.ok) return res.status(400).json({ message: phoneV.message });

    const existing = await VenueShortlist.findOne({ crmEnquiryId: idV.value });
    if (existing) return res.status(200).json({ shortlist: await shapedShortlist(existing), duplicate: true });
    try {
      const shortlist = await VenueShortlist.create({
        crmEnquiryId: idV.value,
        coupleName: nameV.value,
        couplePhone: phoneV.value,
        createdBy: req.auth.user_id,
        createdByName: adminName(req),
      });
      return res.status(201).json({ shortlist: await shapedShortlist(shortlist), duplicate: false });
    } catch (e) {
      if (e && e.code === 11000) {
        const winner = await VenueShortlist.findOne({ crmEnquiryId: idV.value });
        return res.status(200).json({ shortlist: await shapedShortlist(winner), duplicate: true });
      }
      throw e;
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const listShortlists = async (req, res) => {
  try {
    const filter = {};
    if (req.query.crmEnquiryId) filter.crmEnquiryId = String(req.query.crmEnquiryId).slice(0, 100);
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [rows, total] = await Promise.all([
      VenueShortlist.find(filter).sort({ updatedAt: -1, _id: 1 }).skip(skip).limit(limit).lean(),
      VenueShortlist.countDocuments(filter),
    ]);
    const shortlists = rows.map((s) => ({
      _id: s._id,
      crmEnquiryId: s.crmEnquiryId,
      coupleName: s.coupleName,
      couplePhone: s.couplePhone,
      itemCount: (s.items || []).length,
      reactedCount: (s.items || []).filter((i) => i.status === "reacted").length,
      hasPresentLink: Boolean(s.presentToken),
      createdByName: s.createdByName,
      updatedAt: s.updatedAt,
    }));
    return res.status(200).json({ shortlists, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getShortlist = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    return res.status(200).json({ shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Items ─────────────────────────────────────────────────────────────────

const addItem = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    const body = req.body || {};
    const slugV = strField(body.venueSlug, "venueSlug", 200, { required: true });
    if (!slugV.ok) return res.status(400).json({ message: slugV.message });
    const notesV = strField(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });
    const venue = await Venue.findOne({ slug: slugV.value }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (shortlist.items.some((i) => String(i.venue) === String(venue._id))) {
      return res.status(409).json({ message: "Venue is already on this shortlist" });
    }
    if (shortlist.items.length >= 20) {
      return res.status(400).json({ message: "Shortlist is capped at 20 venues" });
    }
    shortlist.items.push({ venue: venue._id, notes: notesV.value });
    await shortlist.save();
    return res.status(201).json({ shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateItem = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    const item = shortlist.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "Item not found" });
    const body = req.body || {};
    if (body.notes !== undefined) {
      const notesV = strField(body.notes, "notes", 2000);
      if (!notesV.ok) return res.status(400).json({ message: notesV.message });
      item.notes = notesV.value;
    }
    if (body.status !== undefined) {
      // reacted is client-couple truth — it only arrives via the present API.
      if (!["shortlisted", "presented"].includes(body.status)) {
        return res.status(400).json({ message: "status must be shortlisted or presented" });
      }
      item.status = body.status;
    }
    await shortlist.save();
    return res.status(200).json({ shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const removeItem = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    const item = shortlist.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "Item not found" });
    item.deleteOne();
    await shortlist.save();
    return res.status(200).json({ shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Present link ──────────────────────────────────────────────────────────

const generatePresentLink = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    if (shortlist.items.length === 0) {
      return res.status(400).json({ message: "Add venues before presenting" });
    }
    // Regeneration rotates the credential — previously shared links die.
    shortlist.presentToken = crypto.randomBytes(24).toString("hex");
    for (const item of shortlist.items) {
      if (item.status === "shortlisted") item.status = "presented";
    }
    await shortlist.save();
    return res.status(200).json({
      presentToken: shortlist.presentToken,
      presentPath: `/present/${shortlist.presentToken}`,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── One-tap hold + site visit (the D2-linked venue-touching actions) ─────

const requestItemHold = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    const item = shortlist.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (item.holdRef) {
      const existing = await VenueHold.findById(item.holdRef).select("status dates").lean();
      if (existing && ["requested", "approved"].includes(existing.status)) {
        return res.status(409).json({ message: `An active hold already exists (${existing.status})` });
      }
    }
    const dates = req.body && req.body.dates;
    if (!Array.isArray(dates) || dates.length === 0 || dates.length > 31 ||
        dates.some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d).getTime()))) {
      return res.status(400).json({ message: "dates must be 1-31 YYYY-MM-DD strings" });
    }
    const venue = await Venue.findById(item.venue).select("_id name slug settings").lean();
    if (!venue) return res.status(404).json({ message: "Venue no longer exists" });

    // D2: first venue-touching action guarantees the owner-visible lead.
    const enquiry = await ensureLinkedEnquiry(shortlist, venue._id, adminName(req));

    const holdDays = (venue.settings && venue.settings.holdExpiryDays) || 5;
    const hold = await VenueHold.create({
      venue: venue._id,
      dates: dates.map((d) => new Date(d)),
      requestedBy: "wedsy",
      requestedByName: adminName(req),
      linkedEnquiry: enquiry._id,
      notes: `Wedsy planner: ${shortlist.coupleName || "couple"} (CRM ${shortlist.crmEnquiryId})`,
      expiresAt: new Date(Date.now() + holdDays * 86400000),
    });
    item.holdRef = hold._id;
    await shortlist.save();
    return res.status(201).json({ hold, enquiryId: enquiry._id, shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const scheduleItemVisit = async (req, res) => {
  try {
    const shortlist = await loadShortlist(req.params.id, res);
    if (!shortlist) return;
    const item = shortlist.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "Item not found" });
    const body = req.body || {};
    const when = new Date(body.scheduledAt);
    if (!body.scheduledAt || Number.isNaN(when.getTime())) {
      return res.status(400).json({ message: "scheduledAt must be a valid date-time" });
    }
    const notesV = strField(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });
    if (item.visitRef) {
      const existing = await VenueSiteVisit.findById(item.visitRef).select("status").lean();
      if (existing && ["scheduled", "confirmed"].includes(existing.status)) {
        return res.status(409).json({ message: `An active visit already exists (${existing.status})` });
      }
    }
    const venue = await Venue.findById(item.venue).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue no longer exists" });

    const enquiry = await ensureLinkedEnquiry(shortlist, venue._id, adminName(req));
    const visit = await VenueSiteVisit.create({
      venue: venue._id,
      enquiryRef: enquiry._id,
      scheduledAt: when,
      notes: notesV.value,
      createdByType: "wedsy",
    });
    item.visitRef = visit._id;
    await shortlist.save();
    return res.status(201).json({ visit, enquiryId: enquiry._id, shortlist: await shapedShortlist(shortlist) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Site visits (admin oversight) ─────────────────────────────────────────

const listSiteVisits = async (req, res) => {
  try {
    const filter = {};
    const { status, slug } = req.query;
    if (status) {
      if (!VenueSiteVisit.schema.path("status").enumValues.includes(status)) {
        return res.status(400).json({ message: "Unknown status" });
      }
      filter.status = status;
    }
    if (slug) {
      const venue = await Venue.findOne({ slug: String(slug) }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venue = venue._id;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [visits, total] = await Promise.all([
      VenueSiteVisit.find(filter)
        .sort({ scheduledAt: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug zone")
        .populate("enquiryRef", "coupleName couplePhone stage")
        .lean(),
      VenueSiteVisit.countDocuments(filter),
    ]);
    return res.status(200).json({ visits, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateSiteVisit = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.visitId)) {
      return res.status(400).json({ message: "Invalid visit id" });
    }
    const visit = await VenueSiteVisit.findById(req.params.visitId);
    if (!visit) return res.status(404).json({ message: "Visit not found" });
    const body = req.body || {};
    if (body.status !== undefined) {
      if (!VenueSiteVisit.schema.path("status").enumValues.includes(body.status)) {
        return res.status(400).json({ message: "Unknown status" });
      }
      visit.status = body.status;
    }
    if (body.scheduledAt !== undefined) {
      const when = new Date(body.scheduledAt);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "scheduledAt must be a valid date-time" });
      visit.scheduledAt = when;
    }
    if (body.notes !== undefined) {
      const notesV = strField(body.notes, "notes", 2000);
      if (!notesV.ok) return res.status(400).json({ message: notesV.message });
      visit.notes = notesV.value;
    }
    await visit.save();
    return res.status(200).json({ visit: visit.toObject() });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createShortlist,
  listShortlists,
  getShortlist,
  addItem,
  updateItem,
  removeItem,
  generatePresentLink,
  requestItemHold,
  scheduleItemVisit,
  listSiteVisits,
  updateSiteVisit,
};
