const DecorPackage = require("../models/DecorPackage");
const Decor = require("../models/Decor");
const Vendor = require("../models/Vendor");
const Event = require("../models/Event");

const DECOR_CATEGORIES = [
  "Stage",
  "Entrance",
  "Pathway",
  "Photobooth",
  "Mandap",
  "Nameboard",
  "Furniture",
  "Lighting",
];

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function Search(req, res) {
  try {
    const qRaw = String(req.query.q || "").trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
    if (!qRaw) return res.send({ q: "", results: [] });

    const q = qRaw.toLowerCase();
    const rx = new RegExp(escapeRegex(qRaw), "i");

    // Categories (fast, static)
    const categoryResults = DECOR_CATEGORIES.filter((c) =>
      c.toLowerCase().includes(q)
    )
      .slice(0, Math.min(limit, 8))
      .map((c) => ({
        type: "decorCategory",
        id: c,
        label: c,
        meta: "Decor category",
      }));

    // Decor Packages
    const decorPackages = await DecorPackage.find({
      $or: [{ name: rx }, { included: rx }],
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("name included seoTags.image variant")
      .lean();

    const decorPackageResults = decorPackages.map((p) => ({
      type: "decorPackage",
      id: String(p._id),
      label: p.name,
      meta:
        Array.isArray(p.included) && p.included.length
          ? p.included.slice(0, 2).join(" • ")
          : "Decor package",
      image: p?.seoTags?.image || "",
    }));

    // Decor items (visible + available like storefront)
    const decorItems = await Decor.find({
      productVisibility: true,
      productAvailability: true,
      $or: [
        { name: rx },
        { category: rx },
        { tags: { $regex: rx } },
        { "productInfo.included": { $regex: rx } },
        { "productInfo.id": { $regex: rx } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("name category thumbnail image tags")
      .lean();

    const decorItemResults = decorItems.map((d) => ({
      type: "decorItem",
      id: String(d._id),
      label: d.name,
      meta: d.category || "Decor item",
      image: d.thumbnail || d.image || "",
    }));

    // Makeup artists (vendors) - only visible
    const vendors = await Vendor.find({
      profileVisibility: true,
      $or: [
        { name: rx },
        { businessName: rx },
        { speciality: rx },
        { "businessAddress.city": rx },
        { servicesOffered: { $regex: rx } },
        { category: rx },
      ],
    })
      .sort({ lastActive: -1 })
      .limit(limit)
      .select("name businessName speciality businessAddress.city gallery.coverPhoto category")
      .lean();

    const vendorResults = vendors.map((v) => ({
      type: "vendor",
      id: String(v._id),
      label: v.businessName || v.name,
      meta:
        [v?.businessAddress?.city, v?.speciality, v?.category]
          .filter(Boolean)
          .slice(0, 2)
          .join(" • ") || "Makeup artist",
      image: v?.gallery?.coverPhoto || "",
    }));

    // Events (only for logged-in users)
    let eventResults = [];
    if (req?.auth?.user_id && !req?.auth?.isAdmin && !req?.auth?.isVendor) {
      const events = await Event.find({
        user: req.auth.user_id,
        name: rx,
      })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select("name eventDate")
        .lean();
      eventResults = events.map((e) => ({
        type: "event",
        id: String(e._id),
        label: e.name,
        meta: e.eventDate ? `Event • ${e.eventDate}` : "Event",
      }));
    }

    // De-dupe & cap
    const all = [
      ...categoryResults,
      ...decorPackageResults,
      ...decorItemResults,
      ...vendorResults,
      ...eventResults,
    ];
    const seen = new Set();
    const results = [];
    for (const r of all) {
      const key = `${r.type}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
      if (results.length >= limit) break;
    }

    res.send({ q: qRaw, results });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
}

module.exports = { Search };


