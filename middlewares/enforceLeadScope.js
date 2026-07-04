const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");

// MB10 Slice 4 — per-document scope enforcement for lead WRITE routes.
//
// Background: requirePermission already gates that the caller HOLDS the permission
// and computes req.scope + req.scopeFilter (the same own/team/department/all filter
// used to scope READS). But a single-lead write addressed by :_id never applied that
// filter — so an in-scope-on-paper caller who knew an ID could write a lead OUTSIDE
// their scope. This middleware closes that gap: it runs AFTER
//   requirePermission("leads:edit:own", { ownerField: "assignedTo" })
// and rejects the write unless the :_id lead falls within req.scopeFilter.
//
// all-scope (founder) ⇒ scopeFilter is {} ⇒ every lead matches ⇒ writes freely.
// team/department ⇒ matches leads owned within the team/dept. own ⇒ assignedTo self.
// Fail-closed: a missing/invalid id or a lead outside scope is rejected.
const enforceLeadScope = (param = "_id") => async (req, res, next) => {
  try {
    const id = req.params[param];
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid lead id." });
    }
    const scopeFilter = req.scopeFilter || {};
    const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter] })
      .select("_id")
      .lean();
    if (inScope) return next();
    // Distinguish out-of-scope (lead exists) from genuinely missing, without
    // leaking lead data either way.
    const exists = await Enquiry.exists({ _id: id });
    return res
      .status(exists ? 403 : 404)
      .json({ message: exists ? "Forbidden: lead is outside your scope." : "Lead not found." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

module.exports = { enforceLeadScope };
