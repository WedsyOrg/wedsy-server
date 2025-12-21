const crypto = require("crypto");
const mongoose = require("mongoose");
const VendorReview = require("../models/VendorReview");
const ReviewShare = require("../models/ReviewShare");
const User = require("../models/User");

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function buildShareLink(token) {
  // You can override this in env to point to your PWA page.
  // Example: REVIEW_SHARE_BASE_URL=https://wedsy.in/reviews
  const base = process.env.REVIEW_SHARE_BASE_URL || "https://wedsy.in/review";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}share=${token}`;
}

const List = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId, search, rating, sort } = req.query;

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const query = {};
  if (isVendor) query.vendor = user_id;
  if (isAdmin && vendorId) query.vendor = vendorId;

  if (rating) query.rating = Number(rating);
  if (search) {
    const s = String(search);
    query.$or = [
      { review: { $regex: new RegExp(s, "i") } },
      { category: { $regex: new RegExp(s, "i") } },
      { "customer.name": { $regex: new RegExp(s, "i") } },
      { "customer.phone": { $regex: new RegExp(s, "i") } },
    ];
  }

  const sortQuery = {};
  if (sort === "Oldest") sortQuery.createdAt = 1;
  else sortQuery.createdAt = -1;

  try {
    const list = await VendorReview.find(query)
      .sort(sortQuery)
      .populate("user", "name phone")
      .lean();
    res.send({ message: "success", list });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const Stats = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId } = req.query;

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const vId = isVendor ? user_id : vendorId;
  if (!vId) {
    return res.status(400).send({ message: "error", error: "vendorId is required" });
  }

  const vendorObjId = new mongoose.Types.ObjectId(vId);

  try {
    const [agg] = await VendorReview.aggregate([
      { $match: { vendor: vendorObjId } },
      {
        $group: {
          _id: "$vendor",
          total: { $sum: 1 },
          avgRating: { $avg: "$rating" },
          r1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
          r2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
          r3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
          r4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
          r5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        },
      },
    ]);

    res.send({
      message: "success",
      stats: {
        total: agg?.total || 0,
        avgRating: agg?.avgRating ? Number(agg.avgRating.toFixed(2)) : 0,
        distribution: {
          1: agg?.r1 || 0,
          2: agg?.r2 || 0,
          3: agg?.r3 || 0,
          4: agg?.r4 || 0,
          5: agg?.r5 || 0,
        },
      },
    });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

/**
 * Public create review:
 * - Requires share token (query param: share=...)
 * - Optional auth token (CheckToken) attaches user if logged in
 */
const CreatePublic = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth || {};
  const { share } = req.query;
  const { review, rating, category, images, customerName, customerPhone } = req.body || {};

  if (!share) {
    return res.status(400).send({ message: "error", error: "`share` token is required" });
  }
  if (!review || rating === undefined || rating === null || !category) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  try {
    const tokenHash = sha256(share);
    const shareDoc = await ReviewShare.findOne({ tokenHash, active: true }).lean();
    if (!shareDoc) {
      return res.status(404).send({ message: "Share link not found or inactive" });
    }

    const safeRating = Math.max(1, Math.min(5, Number(rating)));
    const imgList = Array.isArray(images) ? images.filter(Boolean) : [];

    // Attach a real user if present and not vendor/admin
    const attachUser = user_id && !isAdmin && !isVendor ? user_id : null;
    let customer = { name: String(customerName || ""), phone: String(customerPhone || "") };

    if (attachUser) {
      const user = await User.findById(attachUser).select("name phone").lean();
      if (user) {
        customer = {
          name: customer.name || user.name || "",
          phone: customer.phone || user.phone || "",
        };
      }
    }

    const doc = await new VendorReview({
      vendor: shareDoc.vendor,
      user: attachUser,
      customer,
      review: String(review),
      rating: safeRating,
      category: String(category),
      images: imgList,
    }).save();

    res.status(201).send({ message: "success", _id: doc._id });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

/**
 * Authenticated create (optional): normal logged-in User can create review directly.
 * POST /vendor-review
 */
const Create = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId, review, rating, category, images } = req.body || {};

  if (isAdmin || isVendor) {
    return res.status(403).send({ message: "Only users can create reviews here" });
  }
  if (!vendorId || !review || rating === undefined || rating === null || !category) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  try {
    const user = await User.findById(user_id).select("name phone").lean();
    const doc = await new VendorReview({
      vendor: vendorId,
      user: user_id,
      customer: { name: user?.name || "", phone: user?.phone || "" },
      review: String(review),
      rating: Math.max(1, Math.min(5, Number(rating))),
      category: String(category),
      images: Array.isArray(images) ? images.filter(Boolean) : [],
    }).save();

    res.status(201).send({ message: "success", _id: doc._id });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const Reply = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { _id } = req.params;
  const { message } = req.body || {};

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  if (!message) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  const role = isAdmin ? "admin" : "vendor";

  try {
    // Vendor can only reply to own reviews
    const filter = isVendor ? { _id, vendor: user_id } : { _id };
    const result = await VendorReview.findOneAndUpdate(
      filter,
      {
        $push: {
          replies: {
            message: String(message),
            by: { id: user_id, role },
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).lean();

    if (!result) return res.status(404).send({ message: "not found" });
    res.send({ message: "success" });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

/**
 * Reaction endpoint (like/dislike/none) for user/vendor/admin.
 * POST /vendor-review/:_id/reaction { reaction: "like" | "dislike" | "none" }
 */
const React = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { _id } = req.params;
  const { reaction } = req.body || {};

  if (!reaction || !["like", "dislike", "none"].includes(reaction)) {
    return res.status(400).send({ message: "error", error: "reaction must be like|dislike|none" });
  }

  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  try {
    // Remove from both arrays first
    await VendorReview.updateOne(
      { _id },
      {
        $pull: {
          likes: { id: user_id, role },
          dislikes: { id: user_id, role },
        },
      }
    );

    if (reaction === "like") {
      await VendorReview.updateOne(
        { _id },
        { $addToSet: { likes: { id: user_id, role } } }
      );
    } else if (reaction === "dislike") {
      await VendorReview.updateOne(
        { _id },
        { $addToSet: { dislikes: { id: user_id, role } } }
      );
    }

    res.send({ message: "success" });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

// Share-link management (vendor/admin)
const ListShares = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId } = req.query;

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const vId = isVendor ? user_id : vendorId;
  if (!vId) return res.status(400).send({ message: "error", error: "vendorId is required" });

  try {
    const list = await ReviewShare.find({ vendor: vId, active: true })
      .sort({ createdAt: -1 })
      .lean();
    res.send({ message: "success", list });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const CreateShare = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { name = "" } = req.body || {};

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const vendorId = isVendor ? user_id : req.body?.vendorId;
  if (!vendorId) {
    return res.status(400).send({ message: "error", error: "vendorId is required (admin) or login as vendor" });
  }

  const token = generateToken();
  const tokenHash = sha256(token);

  try {
    const doc = await new ReviewShare({
      vendor: vendorId,
      tokenHash,
      active: true,
      name,
      createdBy: user_id || null,
      createdByModel: isAdmin ? "Admin" : "Vendor",
    }).save();

    res.status(201).send({
      message: "success",
      share: {
        _id: doc._id,
        vendor: doc.vendor,
        name: doc.name,
        active: doc.active,
        createdAt: doc.createdAt,
      },
      shareLink: buildShareLink(token),
      shareToken: token, // convenient for dev/testing
    });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const RevokeShare = async (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { shareId } = req.params;

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const filter = isVendor ? { _id: shareId, vendor: user_id } : { _id: shareId };

  try {
    const doc = await ReviewShare.findOneAndUpdate(
      filter,
      { $set: { active: false } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).send({ message: "Share not found" });
    res.send({ message: "success", share: doc });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

module.exports = {
  List,
  Stats,
  CreatePublic,
  Create,
  Reply,
  React,
  ListShares,
  CreateShare,
  RevokeShare,
};


