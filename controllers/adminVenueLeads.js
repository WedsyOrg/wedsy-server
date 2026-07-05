/**
 * controllers/adminVenueLeads.js — MB-V2 P0 S4: cross-venue leads oversight +
 * the D1 explicit bridge ("Forward to Sales CRM").
 *
 * The oversight list stays READ-ONLY over venue leads (D1 Version A — Wedsy
 * never edits a venue's lead). The single write is the bridge: creating a
 * venue-owned VenueForwardRequest (status pending_os). The CRM receive side
 * is OS's build; we only produce the queue.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueForwardRequest = require("../models/VenueForwardRequest");
const { logActivity } = require("../utils/venueActivity");

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

// Same creator derivation as the per-venue leads tab (D1 labeling).
const createdByOf = (enquiry) => {
  const created = (enquiry.activities || []).find((a) => a && a.type === "created");
  if (!created) return "unknown";
  return /manual|import/i.test(created.description || "") ? "venue_team" : "couple";
};

// GET /admin/venues/leads?slug=&source=&stage=&from=&to=&forwarded=&limit=&skip=
const listLeads = async (req, res) => {
  try {
    const { slug, source, stage, from, to, forwarded } = req.query;
    const filter = {};
    if (slug) {
      const venue = await Venue.findOne({ slug: String(slug) }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venueId = venue._id;
    }
    if (source) {
      if (!VenueEnquiry.schema.path("source").enumValues.includes(source)) {
        return res.status(400).json({ message: "Unknown source" });
      }
      filter.source = source;
    }
    if (stage) {
      if (!VenueEnquiry.schema.path("stage").enumValues.includes(stage)) {
        return res.status(400).json({ message: "Unknown stage" });
      }
      filter.stage = stage;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "from is not a valid date" });
        filter.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "to is not a valid date" });
        filter.createdAt.$lte = d;
      }
    }
    if (forwarded !== undefined && forwarded !== "" && !["true", "false"].includes(String(forwarded))) {
      return res.status(400).json({ message: "forwarded must be true or false" });
    }
    const limit = intParam(req.query.limit, 50, 100);
    const skip = intParam(req.query.skip, 0);

    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: "venueforwardrequests",
          localField: "_id",
          foreignField: "enquiryRef",
          as: "forward",
        },
      },
      ...(forwarded === "true" ? [{ $match: { "forward.0": { $exists: true } } }] : []),
      ...(forwarded === "false" ? [{ $match: { "forward.0": { $exists: false } } }] : []),
      {
        $facet: {
          rows: [
            { $sort: { createdAt: -1, _id: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "venues",
                localField: "venueId",
                foreignField: "_id",
                as: "venue",
                pipeline: [{ $project: { name: 1, slug: 1, zone: 1 } }],
              },
            },
            {
              $project: {
                name: 1, phone: 1, coupleName: 1, couplePhone: 1, eventDate: 1,
                guestCount: 1, budget: 1, source: 1, stage: 1, status: 1,
                estimatedValue: 1, createdAt: 1, activities: 1,
                venue: { $arrayElemAt: ["$venue", 0] },
                forward: { $arrayElemAt: ["$forward", 0] },
              },
            },
          ],
          total: [{ $count: "n" }],
        },
      },
    ];
    const [result] = await VenueEnquiry.aggregate(pipeline);
    const leads = result.rows.map(({ activities, forward, ...rest }) => ({
      ...rest,
      createdBy: createdByOf({ activities }),
      forward: forward
        ? { _id: forward._id, status: forward.status, forwardedByName: forward.forwardedByName, createdAt: forward.createdAt }
        : null,
    }));
    return res.status(200).json({ leads, total: result.total.length ? result.total[0].n : 0 });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /admin/venues/leads/:enquiryId/forward  {notes}
// Idempotent: the unique enquiryRef index means one bridge row per lead —
// a repeat forward returns the existing row with duplicate:true, never a copy.
const forwardLead = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.enquiryId)) {
      return res.status(400).json({ message: "Invalid enquiry id" });
    }
    const notes = req.body && req.body.notes;
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
      return res.status(400).json({ message: "notes must be a string of at most 2000 characters" });
    }
    const enquiry = await VenueEnquiry.findById(req.params.enquiryId)
      .select("venueId coupleName couplePhone name phone")
      .lean();
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const existing = await VenueForwardRequest.findOne({ enquiryRef: enquiry._id }).lean();
    if (existing) return res.status(200).json({ forward: existing, duplicate: true });

    let forward;
    try {
      forward = await VenueForwardRequest.create({
        venue: enquiry.venueId,
        enquiryRef: enquiry._id,
        coupleName: enquiry.coupleName || enquiry.name || "",
        couplePhone: enquiry.couplePhone || enquiry.phone || "",
        notes: (notes || "").trim(),
        forwardedBy: req.auth.user_id,
        forwardedByName: (req.auth.user && req.auth.user.name) || "Wedsy admin",
        status: "pending_os",
      });
    } catch (e) {
      // Concurrent double-click: the unique index is the real idempotency guard.
      if (e && e.code === 11000) {
        const winner = await VenueForwardRequest.findOne({ enquiryRef: enquiry._id }).lean();
        return res.status(200).json({ forward: winner, duplicate: true });
      }
      throw e;
    }

    logActivity({
      venue: enquiry.venueId,
      actorType: "wedsy_team",
      actorId: req.auth.user_id,
      actorName: (req.auth.user && req.auth.user.name) || "Wedsy admin",
      action: "lead_forwarded_to_crm",
      entity: "enquiry",
      field: "forward.status",
      old: undefined,
      new: JSON.stringify("pending_os"),
      severity: "normal",
    });

    return res.status(201).json({ forward: forward.toObject(), duplicate: false });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /admin/venues/forwards?status=&limit=&skip= — the bridge queue itself
// (what the OS receive side will consume; wedsy-side tracking meanwhile).
const listForwards = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) {
      if (!VenueForwardRequest.schema.path("status").enumValues.includes(status)) {
        return res.status(400).json({ message: "Unknown status" });
      }
      filter.status = status;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [forwards, total] = await Promise.all([
      VenueForwardRequest.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug zone")
        .populate("enquiryRef", "coupleName couplePhone stage source eventDate")
        .lean(),
      VenueForwardRequest.countDocuments(filter),
    ]);
    return res.status(200).json({ forwards, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listLeads, forwardLead, listForwards };
