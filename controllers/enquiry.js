// Core models and utilities used throughout the Enquiry controller
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const { VerifyOTP } = require("../utils/otp");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../config/jwt");
const Event = require("../models/Event");
const Payment = require("../models/Payment");
// NEW (Lead details screen): used only to compute bidding / package status summary for a lead
const Bidding = require("../models/Bidding");
const Order = require("../models/Order");
const { SendUpdate } = require("../utils/update");
const { GetPaymentTransactions } = require("../utils/payment");
const { computeLeadHealth } = require("../utils/leadHealth");
const { buildFilterConditions } = require("../utils/leadFilterBuilder");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadIntakeService = require("../services/LeadIntakeService");

const CreateNew = (req, res) => {
  const { name, phone, verified, source, Otp, ReferenceId, additionalInfo } =
    req.body;
  if (!name || !phone || !source || verified === undefined) {
    res.status(400).send({ message: "Incomplete Data" });
  } else if (verified && Otp && ReferenceId) {
    VerifyOTP(phone, ReferenceId, Otp)
      .then((result) => {
        if (result.Valid === true) {
          // First check if Enquiry already exists
          Enquiry.findOne({ phone })
            .then((existingEnquiry) => {
              if (existingEnquiry) {
                // Update existing enquiry instead of creating duplicate
                Enquiry.findByIdAndUpdate(
                  existingEnquiry._id,
                  {
                    $set: {
                      name,
                      verified: verified || existingEnquiry.verified,
                      source: existingEnquiry.source || source,
                      additionalInfo: { ...existingEnquiry.additionalInfo, ...(additionalInfo || {}) },
                    },
                  },
                  { new: true }
                )
                  .then(() => {
                    // Lifecycle intake hook (additive): dedup-merge — same person enquired again.
                    LeadIntakeService.recordReEnquiry(existingEnquiry._id, {
                      source,
                      message: additionalInfo?.message || "",
                    });
                    User.findOne({ phone })
                      .then((user) => {
                        if (user) {
                          const { _id } = user;
                          const token = jwt.sign(
                            { _id },
                            process.env.JWT_SECRET,
                            jwtConfig
                          );
                          res.send({
                            message: "Enquiry Updated Successfully",
                            token,
                          });
                        } else {
                          // Create user if doesn't exist
                          new User({
                            name,
                            phone,
                          })
                            .save()
                            .then((result) => {
                              const { _id } = result;
                              const token = jwt.sign(
                                { _id },
                                process.env.JWT_SECRET,
                                jwtConfig
                              );
                              res.send({
                                message: "Enquiry Updated Successfully",
                                token,
                              });
                            })
                            .catch((error) => {
                              res.status(400).send({ message: "error", error });
                            });
                        }
                      })
                      .catch((error) => {
                        res.status(400).send({ message: "error", error });
                      });
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              } else {
                // No existing enquiry, proceed with original logic
                User.findOne({ phone })
                  .then((user) => {
                    if (user) {
                      const { _id } = user;
                      const token = jwt.sign(
                        { _id },
                        process.env.JWT_SECRET,
                        jwtConfig
                      );
                      new Enquiry({
                        name,
                        phone,
                        verified,
                        source,
                        additionalInfo: additionalInfo || {},
                      })
                        .save()
                        .then((result) => {
                          // Lifecycle intake hook (additive): auto-assign the new lead.
                          LeadIntakeService.afterCreate(result._id);
                          SendUpdate({
                            channels: ["SMS", "Whatsapp"],
                            message: "New Lead",
                            parameters: { name, phone },
                          });
                          res.send({
                            message: "Enquiry Added Successfully",
                            token,
                          });
                        })
                        .catch((error) => {
                          res.status(400).send({ message: "error", error });
                        });
                    } else {
                      new User({
                        name,
                        phone,
                      })
                        .save()
                        .then((result) => {
                          const { _id } = result;
                          const token = jwt.sign(
                            { _id },
                            process.env.JWT_SECRET,
                            jwtConfig
                          );
                          new Enquiry({
                            name,
                            phone,
                            verified,
                            source,
                            additionalInfo: additionalInfo || {},
                          })
                            .save()
                            .then((result) => {
                              // Lifecycle intake hook (additive): auto-assign the new lead.
                              LeadIntakeService.afterCreate(result._id);
                              SendUpdate({
                                channels: ["SMS", "Whatsapp"],
                                message: "New Lead",
                                parameters: { name, phone },
                              });
                              res.send({
                                message: "Enquiry Added Successfully",
                                token,
                              });
                            })
                            .catch((error) => {
                              res.status(400).send({ message: "error", error });
                            });
                        })
                        .catch((error) => {
                          res.status(400).send({ message: "error", error });
                        });
                    }
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              }
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          res.status(400).send({ message: "Invalid OTP" });
        }
      })
      .catch((err) => {
        res.status(400).send({ message: "error", error: err });
      });
  } else {
    // For unverified enquiries, also check for duplicates
    Enquiry.findOne({ phone })
      .then((existingEnquiry) => {
        if (existingEnquiry) {
          // Update existing enquiry
          Enquiry.findByIdAndUpdate(
            existingEnquiry._id,
            {
              $set: {
                name,
                source: existingEnquiry.source || source,
                additionalInfo: { ...existingEnquiry.additionalInfo, ...(additionalInfo || {}) },
              },
            },
            { new: true }
          )
            .then(() => {
              // Lifecycle intake hook (additive): dedup-merge — same person enquired again.
              LeadIntakeService.recordReEnquiry(existingEnquiry._id, {
                source,
                message: additionalInfo?.message || "",
              });
              res.status(200).send({ message: "Enquiry Updated Successfully" });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          // Lifecycle intake hook (additive): the exact-match check above misses
          // formatting variants ("+91 98… " vs "98…"). Normalized match → treat as
          // the same dedup-merge path, preserving the existing response contract.
          LeadIntakeService.findExistingByNormalizedPhone(phone)
            .then((normalizedMatch) => {
              if (normalizedMatch) {
                LeadIntakeService.recordReEnquiry(normalizedMatch._id, {
                  source,
                  message: additionalInfo?.message || "",
                });
                res.status(200).send({ message: "Enquiry Updated Successfully" });
                return;
              }
              // Create new enquiry
              new Enquiry({
                name,
                phone,
                verified: false,
                source,
                additionalInfo: additionalInfo || {},
              })
                .save()
                .then((result) => {
                  // Lifecycle intake hook (additive): auto-assign the new lead.
                  LeadIntakeService.afterCreate(result._id);
                  SendUpdate({
                    channels: ["SMS", "Whatsapp"],
                    message: "New Lead",
                    parameters: { name, phone },
                  });
                  res.status(201).send({ message: "Enquiry Added Successfully" });
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = async (req, res) => {
  if (req.query.stats === "true") {
    let stats = {
      total: 0,
      lost: 0,
      interested: 0,
      fresh: 0,
      new: 0,
    };
    let tempDate = new Date();
    tempDate.setHours(0, 0, 0, 0);
    let newDate = tempDate;
    newDate.setDate(newDate.getDate() - 7);
    let freshDate = tempDate;
    freshDate.setDate(freshDate.getDate() - 1);

    stats.total = await Enquiry.countDocuments({});
    stats.lost = await Enquiry.countDocuments({ isLost: true });
    stats.interested = await Enquiry.countDocuments({ isInterested: true });
    stats.new = await Enquiry.countDocuments({
      createdAt: {
        $gte: tempDate,
      },
    });
    stats.fresh = await Enquiry.countDocuments({
      createdAt: {
        $gte: tempDate,
      },
    });
    res.send({ stats });
  } else {
    const escapeRegExp = (str) =>
      String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const {
      source,
      date,
      search,
      sort,
      status,
      service,
      eventCreated,
      eventMonth,
      bidRequest,
      storeAccess,
      assignedTo,
      dateFrom,
      dateTo,
    } = req.query;
    const query = {};
    // MB9c — soft-deleted (archived) leads are excluded from the default list.
    query.archivedAt = null;
    const sortQuery = {};
    // MB9c-fix — SOURCE filter, normalized. The stored `source` strings are
    // messy ("Website", "whatsapp", "Instagram DM", "Kiara", …); the brand chips
    // send canonical keys (comma-separated for multi-select) which we map to a
    // case-insensitive regex over the raw strings — so a chip reliably matches.
    if (source) {
      const SOURCE_PATTERNS = {
        whatsapp: "whatsapp",
        kiara: "kiara",
        instagram: "instagram|(^|[^a-z])ig([^a-z]|$)",
        facebook: "facebook|(^|[^a-z])fb([^a-z]|$)|meta",
        website: "web|site|default|form|landing|direct",
        repeated: "repeat",
      };
      const keys = String(source).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const patterns = keys.map((k) => SOURCE_PATTERNS[k]).filter(Boolean);
      if (patterns.length) {
        query.source = { $regex: patterns.map((p) => `(${p})`).join("|"), $options: "i" };
      } else {
        // Unknown key → fall back to the legacy exact match (back-compat).
        query.source = source;
      }
    }
    if (assignedTo) {
      if (assignedTo === "unassigned") {
        query.assignedTo = null;
      } else {
        query.assignedTo = assignedTo;
      }
    }
    // Lifecycle (Slice I, additive): lead-list view chips. Absent → behavior unchanged.
    if (req.query.view) {
      const view = req.query.view;
      if (view === "active") {
        query.stage = { $nin: ["won", "lost"] };
        query["recycled.isRecycled"] = { $ne: true };
      } else if (view === "won") {
        query.stage = "won";
      } else if (view === "lost") {
        query.stage = "lost";
      } else if (view === "meeting") {
        query.stage = "meeting_scheduled";
      } else if (view === "recycled") {
        query["recycled.isRecycled"] = true;
      } else if (view === "triage") {
        // MB5 Slice 4: the triage queue as a leads filter.
        query.triagePending = true;
        query["recycled.isRecycled"] = { $ne: true };
      } else if (view === "qualified") {
        // MB9c — the Qualified saved-view segment.
        query.qualified = true;
        query["recycled.isRecycled"] = { $ne: true };
      } else if (view === "golden") {
        // MB9c — the Golden-window segment: uncontacted, active leads (the same
        // set Respond-now works from — reconciles).
        query.firstCalledAt = null;
        query.qualified = { $ne: true };
        query.isLost = { $ne: true };
        query["recycled.isRecycled"] = { $ne: true };
      }
    }
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.createdAt = {
        $gte: startDate,
        $lt: endDate,
      };
    }
    if (!date && (dateFrom || dateTo)) {
      const range = {};
      if (dateFrom) {
        const start = new Date(dateFrom);
        if (!isNaN(start.getTime())) {
          start.setHours(0, 0, 0, 0);
          range.$gte = start;
        }
      }
      if (dateTo) {
        const end = new Date(dateTo);
        if (!isNaN(end.getTime())) {
          end.setHours(23, 59, 59, 999);
          range.$lte = end;
        }
      }
      if (Object.keys(range).length > 0) {
        query.createdAt = range;
      }
    }
    if (search) {
      const safeSearch = escapeRegExp(search);
      query.$or = [
        { name: { $regex: new RegExp(safeSearch, "i") } },
        { email: { $regex: new RegExp(safeSearch, "i") } },
        { phone: { $regex: new RegExp(safeSearch, "i") } },
      ];
    }
    // MB9c-fix — SERVER-SIDE sort over the FULL set (not the loaded page).
    //   sort = createdAt | activity (updatedAt) | name  (+ dir = asc|desc)
    // Legacy "Date: Oldest/Newest" kept for back-compat. Default = newest
    // created first. `_id` is always appended as the stable paging tiebreaker.
    const dir = req.query.dir; // optional "asc" | "desc"
    const D = (def) => (dir === "asc" ? 1 : dir === "desc" ? -1 : def);
    if (sort === "Date: Oldest") {
      sortQuery.createdAt = 1;
    } else if (sort === "Date: Newest") {
      sortQuery.createdAt = -1;
    } else if (sort === "name") {
      sortQuery.name = D(1); // A→Z by default
    } else if (sort === "activity") {
      sortQuery.updatedAt = D(-1); // most-recently-touched by default
    } else if (sort === "createdAt") {
      sortQuery.createdAt = D(-1);
    } else {
      sortQuery.createdAt = -1; // default: newest created on top
    }
    sortQuery._id = -1;

    // NEW: Filter by interested service stored in additionalInfo
    // This aligns with the "Interested Service" / ALL-DECOR-MAKEUP filters in the admin UI.
    if (service) {
      const serviceRegex = new RegExp(`^${escapeRegExp(service)}$`, "i");
      // Match either additionalInfo.service or additionalInfo.interestedService
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { "additionalInfo.service": serviceRegex },
          { "additionalInfo.interestedService": serviceRegex },
        ],
      });
    }

    // NEW: Event created filter.
    // Backed by a boolean flag in additionalInfo.eventCreated (to be populated alongside event creation flows).
    if (eventCreated === "Yes") {
      query["additionalInfo.eventCreated"] = true;
    } else if (eventCreated === "No") {
      query["additionalInfo.eventCreated"] = { $ne: true };
    }

    // NEW: Event month filter.
    // Backed by a string field in additionalInfo.eventMonth like "January", "February", etc.
    if (eventMonth && eventMonth !== "All months") {
      query["additionalInfo.eventMonth"] = eventMonth;
    }

    // NEW: Bid request filter.
    // Backed by a boolean flag in additionalInfo.bidRequest (true => has bid request).
    if (bidRequest === "Yes") {
      query["additionalInfo.bidRequest"] = true;
    } else if (bidRequest === "No") {
      query["additionalInfo.bidRequest"] = { $ne: true };
    }

    // NEW: Store access filter.
    // Backed by a boolean flag in additionalInfo.storeAccess (true => has store access).
    if (storeAccess === "Yes") {
      query["additionalInfo.storeAccess"] = true;
    } else if (storeAccess === "No") {
      query["additionalInfo.storeAccess"] = { $ne: true };
    }
    if (status) {
      // Fresh, New, Hot, Potential, Cold, Lost, Interested, Verified, Not Verified
      if (status === "Interested") {
        query.isInterested = true;
      } else if (status === "Lost") {
        query.isLost = true;
      } else if (status === "Verified") {
        query.verified = true;
      } else if (status === "NotVerified") {
        query.verified = false;
      } else if (status === "Fresh" || status === "New") {
        let tempDate = new Date();
        tempDate.setHours(0, 0, 0, 0);
        if (status === "Fresh") {
          tempDate.setDate(tempDate.getDate() - 1);
        } else if (status === "New") {
          tempDate.setDate(tempDate.getDate() - 7);
        }
        query.createdAt = {
          $gte: tempDate,
        };
      }
    }
    // Filter builder (Settings Suite): strict-whitelisted {field,op,value} filters.
    // Unknown field/op → 400. ALWAYS combined under the same mandatory $and below.
    let filterConditions = [];
    try {
      filterConditions = await buildFilterConditions(req.query.filters);
    } catch (fbError) {
      return res.status(fbError.status || 400).send({ message: fbError.message });
    }
    // Lead visibility cutoff (settings-driven): mandatory listing filter — {} when off.
    const visibility = await currentVisibilityFilter();
    // RBAC scope: combine req.scopeFilter (built by requirePermission with ownerField
    // "assignedTo") as a MANDATORY $and constraint, so caller params can only narrow
    // within scope, never widen it. For "all" scope req.scopeFilter is {} -> unchanged.
    const scopedFilter = { $and: [query, req.scopeFilter || {}, visibility, ...filterConditions] };
    if (!(status && ["Hot", "Potential", "Cold"].includes(status))) {
      Enquiry.countDocuments(scopedFilter)
        .then((total) => {
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;
          // const pipeline = [
          //   {
          //     $lookup: {
          //       from: "users",
          //       localField: "phone",
          //       foreignField: "phone",
          //       as: "user",
          //     },
          //   },
          //   {
          //     $unwind: {
          //       path: "$user",
          //       preserveNullAndEmptyArrays: true, // Include documents without matching users
          //     },
          //   },
          //   {
          //     $lookup: {
          //       from: "events",
          //       localField: "user._id",
          //       foreignField: "user",
          //       as: "events",
          //     },
          //   },
          //   {
          //     $unwind: {
          //       path: "$events",
          //       preserveNullAndEmptyArrays: true, // Include documents without matching events
          //     },
          //   },
          //   { $sort: sortQuery },
          //   {
          //     $group: {
          //       _id: "$_id", // Group by the Enquiry document ID
          //       user: { $first: "$user" }, // Take the first user (assuming there's at most one)
          //       event: { $first: "$events" }, // Take the first event for the user
          //       enquiryFields: { $first: "$$ROOT" },
          //     },
          //   },
          //   {
          //     $project: {
          //       _id: "$enquiryFields._id",
          //       name: "$enquiryFields.name",
          //       phone: "$enquiryFields.phone",
          //       email: "$enquiryFields.email",
          //       verified: "$enquiryFields.verified",
          //       isInterested: "$enquiryFields.isInterested",
          //       isLost: "$enquiryFields.isLost",
          //       source: "$enquiryFields.source",
          //       updates: "$enquiryFields.updates",
          //       user: "$user",
          //       event: "$event",
          //       createdAt: "$enquiryFields.createdAt",
          //       updatedAt: "$enquiryFields.updatedAt",
          //     },
          //   },
          //   {
          //     $match: {
          //       $or: [
          //         { "user._id": { $exists: false } }, // Include entries without users
          //         { "events._id": { $exists: false } }, // Include entries without events
          //         { ...query }, // Include entries that match the query
          //       ],
          //     },
          //   },
          //   {
          //     $facet: {
          //       metadata: [{ $count: "total" }],
          //       result: [{ $skip: skip }, { $limit: limit }],
          //     },
          //   },
          // ];
          Enquiry
            // .aggregate([
            //   ...pipeline,
            //   // { $skip: skip },
            //   // { $limit: limit },
            //   // { $sort: sortQuery },
            // ])
            .find(scopedFilter)
            .sort(sortQuery)
            .skip(skip)
            .limit(limit)
            .exec()
            .then((result) => {
              // MB9c-fix — include `total` so the list footer can show "X of Y".
              res.send({ list: result, total, totalPages, page, limit });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    } else {
      // Hot, Potential, Cold
      const tempCurrentDate = new Date();
      const tempStartDate = new Date(tempCurrentDate);
      const tempEndDate = new Date(tempCurrentDate);
      if (status === "Hot") {
        tempStartDate.setDate(tempCurrentDate.getDate() + 0 * 7); // 0 weeks
        tempEndDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
      } else if (status === "Potential") {
        tempStartDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
        tempEndDate.setDate(tempCurrentDate.getDate() + 20 * 7); // 20 weeks
      } else if (status === "Cold") {
        // tempStartDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
        tempStartDate.setDate(tempCurrentDate.getDate() + 20 * 7); // 20 weeks
      }
      tempStartDate.setHours(0, 0, 0, 0);
      tempEndDate.setHours(23, 59, 59, 999);

      const pipeline = [
        {
          $lookup: {
            from: "users",
            localField: "phone",
            foreignField: "phone",
            as: "user",
          },
        },
        {
          $unwind: "$user",
        },
        {
          $lookup: {
            from: "events",
            localField: "user._id",
            foreignField: "user",
            as: "events",
          },
        },
        {
          $unwind: "$events",
        },
        {
          $match: {
            ...query,
            // RBAC scope: append (req.scopeFilter || {}) to the existing $and so it is a
            // MANDATORY constraint here too. This single pipeline feeds BOTH the count
            // aggregate and the paginated aggregate, so both are scoped. "all" -> {} (unchanged).
            $and: [
              ...(status === "Cold"
                ? [
                    {
                      "events.eventDays.date": {
                        $gte: tempStartDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                    // {
                    //   "events.eventDays.date": {
                    //     $lt: tempEndDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                    //   },
                    // },
                  ]
                : [
                    {
                      "events.eventDays.date": {
                        $gte: tempStartDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                    {
                      "events.eventDays.date": {
                        $lt: tempEndDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                  ]),
              req.scopeFilter || {},
              visibility,
              ...filterConditions,
            ],
          },
        },
      ];

      Enquiry.aggregate(pipeline)
        .then((result) => {
          const total = result.length; // Count the matched documents
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;

          // Apply pagination and sorting to the results
          Enquiry.aggregate([
            ...pipeline,
            { $skip: skip },
            { $limit: limit },
            { $sort: sortQuery },
          ])
            .then((result) => {
              res.send({ list: result, totalPages, page, limit });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    }
  }
};

const Update = (req, res) => {
  const { leadIds, action } = req.body;
  if (action === "MarkInterested") {
    Enquiry.updateMany(
      { _id: { $in: leadIds } },
      { isInterested: true, isLost: false }
    )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send({ message: "success" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (action === "MarkLost") {
    Enquiry.updateMany(
      { _id: { $in: leadIds } },
      { isInterested: false, isLost: true }
    )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send({ message: "success" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

// UPDATE: previously this endpoint only updated the lead name.
// Now it can also persist selected fields under `additionalInfo` via `additionalInfoUpdates`,
// which is used by the admin lead-details page for things like Store Access and Client Budget.
const UpdateLead = async (req, res) => {
  const { _id } = req.params;
  const { name, phone, email, marketingSource, additionalInfoUpdates } =
    req.body;

  const updateFields = {};

  if (name) {
    updateFields.name = name;
  }

  if (typeof phone === "string" && phone.trim().length > 0) {
    updateFields.phone = phone.trim();
  }

  // Defensive app-layer dedup: schema's `unique: true` on phone is not
  // enforced at the DB layer (existing duplicates in collection).
  if (updateFields.phone) {
    try {
      const existing = await Enquiry.findOne({
        phone: updateFields.phone,
        _id: { $ne: _id },
      }).lean();
      if (existing) {
        return res.status(409).send({
          message: "duplicate",
          field: "phone",
          detail: "A lead with this phone number already exists.",
        });
      }
    } catch (err) {
      return res.status(500).send({
        message: "error",
        error: err.message,
      });
    }
  }

  if (typeof email === "string") {
    updateFields.email = email.trim();
  }

  if (typeof marketingSource === "string") {
    updateFields.marketingSource = marketingSource.trim() || null;
  }

  if (
    additionalInfoUpdates &&
    typeof additionalInfoUpdates === "object" &&
    !Array.isArray(additionalInfoUpdates)
  ) {
    Object.keys(additionalInfoUpdates).forEach((key) => {
      updateFields[`additionalInfo.${key}`] = additionalInfoUpdates[key];
    });
  }

  if (Object.keys(updateFields).length > 0) {
    updateFields.updatedBy = req.auth.user_id;
  }

  // Guard: avoid accidental empty updates so existing behaviour is preserved
  if (Object.keys(updateFields).length === 0) {
    res.status(400).send({ message: "No valid fields to update" });
    return;
  }

  Enquiry.findByIdAndUpdate(
    { _id },
    { $set: updateFields },
    { new: true, runValidators: true, context: "query" }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      if (error && error.code === 11000) {
        res.status(409).send({
          message: "duplicate",
          field: "phone",
          detail: "A lead with this phone number already exists.",
        });
        return;
      }
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Delete = (req, res) => {
  const { leadIds } = req.body;
  Enquiry.deleteMany({ _id: { $in: leadIds } })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

// EXTENSION: enrich the single-lead GET response with:
// - paymentStats (existing behaviour)
// - statusSummary (NEW) derived from Orders + Biddings, used by the "Makeup Report" UI boxes.
const Get = (req, res) => {
  const { _id } = req.params;
  // RBAC scope: the doc must also satisfy req.scopeFilter. An out-of-scope id simply
  // yields no match -> the same 404 as a missing enquiry (does not reveal it exists).
  Enquiry.findOne({ $and: [{ _id }, req.scopeFilter || {}] })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        // Backward compatibility: Convert old string conversations to new format.
        // Important: if we migrate, we re-read the updated doc so subdocuments get real _id values immediately
        // (required for editing/updating a specific note from the admin UI).
        let resultObj = result.toObject();
        let needsConversationMigration = false;
        if (
          resultObj.updates?.conversations &&
          Array.isArray(resultObj.updates.conversations)
        ) {
          resultObj.updates.conversations = resultObj.updates.conversations.map((conv) => {
            // If it's already an object with text, return as is
            if (typeof conv === "object" && conv !== null && conv.text) {
              return conv;
            }
            // If it's a string (old format), convert to new format
            if (typeof conv === "string") {
              needsConversationMigration = true;
              return {
                text: conv,
                createdAt: result.createdAt || new Date(),
              };
            }
            return conv;
          });
        }

        const proceedWith = (finalResultObj) => {
          User.findOne({ phone: result.phone })
            .then((user) => {
              if (!user) {
                res.send({
                  ...finalResultObj,
                  userCreated: false,
                  // Derived on read, never stored (no events without a linked user).
                  leadHealth: computeLeadHealth(finalResultObj, []),
                });
              } else {
                Event.find({ user: user._id })
                  .then((events) => {
                    Payment.find({ user: user._id })
                      .populate("event")
                      .then((payments) => {
                      const { totalAmount, amountPaid, amountDue } =
                        events.reduce(
                          (accumulator, e) => {
                            accumulator.totalAmount += e?.amount.total;
                            accumulator.amountPaid += e?.amount.paid;
                            accumulator.amountDue += e?.amount.due;
                            return accumulator;
                          },
                          { totalAmount: 0, amountPaid: 0, amountDue: 0 }
                        );
                      Promise.all(
                        payments.map(async (item) => {
                          let transactions = item.transactions || [];
                          if (
                            item?.razporPayId &&
                            !["cash", "upi", "bank-transfer"].includes(
                              item?.paymentMethod
                            ) &&
                            transactions.length == 0
                          ) {
                            transactions = await GetPaymentTransactions({
                              order_id: item?.razporPayId,
                            });
                          }
                          return { ...item.toObject(), transactions };
                        })
                      )
                        .then((updatedPayments) => {
                          // NEW: derive bidding / package status using Orders and Biddings for this user
                          Order.find({ user: user._id })
                            .then((orders) => {
                              Bidding.find({ user: user._id })
                                .then((biddings) => {
                                  let biddingStatus = "No Bid";
                                  if (biddings.length > 0) {
                                    const hasBiddingOrder = orders.some(
                                      (o) =>
                                        o.source === "Bidding" &&
                                        (o.status?.booked ||
                                          o.status?.completed)
                                    );
                                    if (hasBiddingOrder) {
                                      biddingStatus = "Booked";
                                    } else {
                                      biddingStatus = "Bid in Progress";
                                    }
                                  }

                                  const hasWedsyOrder = orders.some(
                                    (o) =>
                                      o.source === "Wedsy-Package" &&
                                      (o.status?.booked || o.status?.completed)
                                  );

                                  const hasVendorOrder = orders.some(
                                    (o) =>
                                      o.source === "Personal-Package" &&
                                      (o.status?.booked || o.status?.completed)
                                  );

                                  res.send({
                                    ...finalResultObj,
                                    userCreated: true,
                                    user,
                                    events,
                                    // Derived on read, never stored.
                                    leadHealth: computeLeadHealth(
                                      finalResultObj,
                                      events
                                    ),
                                    payments: updatedPayments,
                                    paymentStats: {
                                      totalAmount,
                                      amountPaid,
                                      amountDue,
                                    },
                                    statusSummary: {
                                      bidding: biddingStatus,
                                      wedsyPackage: hasWedsyOrder
                                        ? "Booked"
                                        : "No Activity",
                                      vendorPackage: hasVendorOrder
                                        ? "Booked"
                                        : "No Activity",
                                    },
                                  });
                                })
                                .catch((error) => {
                                  res
                                    .status(400)
                                    .send({ message: "error", error });
                                });
                            })
                            .catch((error) => {
                              res.status(400).send({ message: "error", error });
                            });
                        })
                        .catch((error) => {
                          res.status(400).send({ message: "error", error });
                        });
                      })
                      .catch((error) => {
                        res.status(400).send({ message: "error", error });
                      });
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              }
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        };

        // Persist migration so each conversation gets a proper Mongo subdocument _id (enables editing/updating notes)
        if (needsConversationMigration) {
          Enquiry.findByIdAndUpdate(
            { _id },
            { $set: { "updates.conversations": resultObj.updates.conversations } },
            { new: true }
          )
            .then((migrated) => {
              if (migrated) {
                proceedWith(migrated.toObject());
              } else {
                proceedWith(resultObj);
              }
            })
            .catch(() => {
              proceedWith(resultObj);
            });
        } else {
          proceedWith(resultObj);
        }
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateConversation = (req, res) => {
  const { _id, conversationId } = req.params;
  const { text, createdAt } = req.body;

  if (!conversationId) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  const updateFields = {};
  if (typeof text === "string") {
    updateFields["updates.conversations.$.text"] = text;
  }
  if (createdAt) {
    const d = new Date(createdAt);
    if (!Number.isNaN(d.getTime())) {
      updateFields["updates.conversations.$.createdAt"] = d;
    }
  }

  if (Object.keys(updateFields).length === 0) {
    return res.status(400).send({ message: "No valid fields to update" });
  }

  Enquiry.findOneAndUpdate(
    { _id, "updates.conversations._id": conversationId },
    { $set: updateFields }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const CreateUser = (req, res) => {
  const { _id } = req.params;
  Enquiry.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        new User({
          name: result.name,
          phone: result.phone,
        })
          .save()
          .then((user) => {
            res.send({ message: "success" });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const AddConversation = (req, res) => {
  const { _id } = req.params;
  const { conversation, createdAt } = req.body;
  let createdAtDate = createdAt ? new Date(createdAt) : new Date();
  if (Number.isNaN(createdAtDate.getTime())) {
    createdAtDate = new Date();
  }
  const conversationObj = {
    text: conversation,
    createdAt: createdAtDate,
  };
  Enquiry.findByIdAndUpdate(
    { _id },
    { $push: { "updates.conversations": conversationObj } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const DeleteConversation = (req, res) => {
  const { _id, conversationId } = req.params;
  if (!conversationId) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  Enquiry.findByIdAndUpdate(
    { _id },
    { $pull: { "updates.conversations": { _id: conversationId } } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateNotes = (req, res) => {
  const { _id } = req.params;
  const { notes } = req.body;
  Enquiry.findByIdAndUpdate({ _id }, { $set: { "updates.notes": notes } })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateCallSchedule = (req, res) => {
  const { _id } = req.params;
  const { callSchedule } = req.body;
  Enquiry.findByIdAndUpdate(
    { _id },
    { $set: { "updates.callSchedule": callSchedule } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

// First-call TAT anchor: stamp firstCalledAt the FIRST time a lead is called.
// Idempotent + set-once — if it is already set we leave the original timestamp
// untouched and simply return the current lead document.
const SetFirstCall = async (req, res) => {
  const { _id } = req.params;
  try {
    // Set-once semantics live in EnquiryRepository.stampFirstCalledAt (shared with
    // the cockpit's call-log endpoint): only a never-called lead gets stamped.
    let result = await EnquiryRepository.stampFirstCalledAt(_id);
    // No match means it was already stamped (or the lead is missing) — re-read it.
    if (!result) {
      result = await Enquiry.findById({ _id });
    }
    if (!result) {
      return res.status(404).send();
    }
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "error", error });
  }
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Update,
  UpdateLead,
  Delete,
  CreateUser,
  AddConversation,
  DeleteConversation,
  UpdateConversation,
  UpdateNotes,
  UpdateCallSchedule,
  SetFirstCall,
};
