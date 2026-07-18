// Core models and utilities used throughout the Enquiry controller
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Admin = require("../models/Admin");
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
const {
  LIFECYCLE_KEYS,
  lifecycleFragment,
  bucketOf,
  TEMPERATURE_KEYS,
  temperatureCutoffs,
  temperatureOf,
  temperatureLabelOf,
  temperatureFilter,
  DATE_STATUS_KEYS,
  dateStatusFragment,
  parseDateStatus,
} = require("../utils/leadLifecycle");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadIntakeService = require("../services/LeadIntakeService");
const { computeDiscovery } = require("../services/DiscoveryService");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const { SOURCE_PATTERNS, sourceChannelOf } = require("../utils/leadSource");
const { isCurrentRosterMember } = require("../utils/leadScope");
const DealSpineService = require("../services/DealSpineService");

// Opaque-error hardening: every terminal catch in this controller used to
// return a literal 400 {message:"error"} (plus the raw error object), which the
// FE rendered verbatim as "error" (the Approvals-class symptom) and which
// leaked internals. Known client mistakes (bad ids / validation) → 400 with the
// real reason; everything else → 500 with a distinct, human message. The raw
// error goes to the server log only. Grep-verified: no FE or BE code parses the
// old "error" literal.
const respondCatch = (res, error) => {
  if (error && (error.name === "CastError" || error.name === "ValidationError")) {
    return res.status(400).send({ message: error.message });
  }
  console.error("[enquiry]", error);
  return res
    .status(500)
    .send({ message: "Something went wrong loading this lead data — please retry." });
};

// Signal Matrix Slice 3 — opt-in roster widening. ?includeTeam=1 ORs the leads
// the caller is CURRENTLY rostered on (LeadTeamMember, activeTo null) into
// their ownership scope, so a team member can see roster leads in the normal
// list without a separate surface. OFF by default: no view widens silently.
// "all" scope ({}) needs no widening and stays {}.
const effectiveScopeFilter = async (req) => {
  // C1 — ?scope=participant: "leads I'm on" (owner / roster / lane owner /
  // open-task assignee). Self for anyone; ?adminId= only inside the caller's
  // permission scope. Serves the list AND lifecycle-counts (both call here).
  if (req.query.scope === "participant") {
    const ParticipantScopeService = require("../services/ParticipantScopeService");
    const target = await ParticipantScopeService.resolveParticipantTarget(req);
    return await ParticipantScopeService.participantFilter(target);
  }
  const scope = req.scopeFilter || {};
  const wanted = req.query.includeTeam === "1" || req.query.includeTeam === "true";
  if (!wanted || !Object.keys(scope).length) return scope;
  const ids = await LeadTeamMemberRepository.findActiveLeadIdsByPerson(req.auth.user_id);
  if (!ids.length) return scope;
  return { $or: [scope, { _id: { $in: ids } }] };
};

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
                              respondCatch(res, error);
                            });
                        }
                      })
                      .catch((error) => {
                        respondCatch(res, error);
                      });
                  })
                  .catch((error) => {
                    respondCatch(res, error);
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
                          respondCatch(res, error);
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
                              respondCatch(res, error);
                            });
                        })
                        .catch((error) => {
                          respondCatch(res, error);
                        });
                    }
                  })
                  .catch((error) => {
                    respondCatch(res, error);
                  });
              }
            })
            .catch((error) => {
              respondCatch(res, error);
            });
        } else {
          res.status(400).send({ message: "Invalid OTP" });
        }
      })
      .catch((err) => {
        respondCatch(res, err);
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
              respondCatch(res, error);
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
                  respondCatch(res, error);
                });
            })
            .catch((error) => {
              respondCatch(res, error);
            });
        }
      })
      .catch((error) => {
        respondCatch(res, error);
      });
  }
};

const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Builds the BASE (non-bucket) listing query from the request params — the part
// shared by the list (GetAll) and the lifecycle-counts endpoint, so both narrow
// identically. Excludes `view`, `lifecycle`, `temperature`, sort, RBAC scope,
// visibility and the whitelisted filter-builder (those are applied by callers).
// Order of assignments preserved from the original GetAll for behavioural parity.
const buildBaseQuery = (req) => {
  const {
    source,
    date,
    search,
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
  // MB9c-fix — SOURCE filter, normalized (messy stored strings → canonical
  // keys). Patterns now live in utils/leadSource (shared verbatim with the
  // read-time sourceChannel decoration — one matcher, never two).
  if (source) {
    const keys = String(source).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const patterns = keys.map((k) => SOURCE_PATTERNS[k]).filter(Boolean);
    if (patterns.length) {
      query.source = { $regex: patterns.map((p) => `(${p})`).join("|"), $options: "i" };
    } else {
      query.source = source;
    }
  }
  if (assignedTo) {
    query.assignedTo = assignedTo === "unassigned" ? null : assignedTo;
  }
  if (date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);
    query.createdAt = { $gte: startDate, $lt: endDate };
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
    if (Object.keys(range).length > 0) query.createdAt = range;
  }
  if (search) {
    const safeSearch = escapeRegExp(search);
    query.$or = [
      { name: { $regex: new RegExp(safeSearch, "i") } },
      { email: { $regex: new RegExp(safeSearch, "i") } },
      { phone: { $regex: new RegExp(safeSearch, "i") } },
    ];
  }
  if (service) {
    const serviceRegex = new RegExp(`^${escapeRegExp(service)}$`, "i");
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { "additionalInfo.service": serviceRegex },
        { "additionalInfo.interestedService": serviceRegex },
      ],
    });
  }
  if (eventCreated === "Yes") {
    query["additionalInfo.eventCreated"] = true;
  } else if (eventCreated === "No") {
    query["additionalInfo.eventCreated"] = { $ne: true };
  }
  if (eventMonth && eventMonth !== "All months") {
    query["additionalInfo.eventMonth"] = eventMonth;
  }
  if (bidRequest === "Yes") {
    query["additionalInfo.bidRequest"] = true;
  } else if (bidRequest === "No") {
    query["additionalInfo.bidRequest"] = { $ne: true };
  }
  if (storeAccess === "Yes") {
    query["additionalInfo.storeAccess"] = true;
  } else if (storeAccess === "No") {
    query["additionalInfo.storeAccess"] = { $ne: true };
  }
  if (status) {
    // Fresh, New, Lost, Interested, Verified, Not Verified (Hot/Potential/Cold
    // are the legacy events-based path handled separately in GetAll).
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
      tempDate.setDate(tempDate.getDate() - (status === "Fresh" ? 1 : 7));
      query.createdAt = { $gte: tempDate };
    }
  }
  return query;
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const { sort, status } = req.query;
    // Base (non-bucket) narrowers — shared with the lifecycle-counts endpoint.
    const query = buildBaseQuery(req);
    const sortQuery = {};

    // Lifecycle bucket (additive, server-side). When a valid `lifecycle` is sent
    // it is the single source of truth for the bucket and WINS over `view` (the
    // view's bucket mapping is skipped). Absent → the existing saved-view
    // behaviour is unchanged.
    const lifecycleKey = req.query.lifecycle;
    const hasLifecycle = LIFECYCLE_KEYS.includes(lifecycleKey);
    if (!hasLifecycle && req.query.view) {
      const view = req.query.view;
      if (view === "active") {
        // Active = in-pipeline: not won, not lost — INCLUDING leads whose stage
        // is unset (null / missing). A bare `$nin` drops null docs in Mongo, so
        // the ~329 stage:null leads would vanish from the default list; the $or
        // brings them back. $and-merge so we don't clobber any pre-existing $or.
        query.$and = [
          ...(query.$and || []),
          {
            $or: [
              { stage: { $nin: ["won", "lost"] } },
              { stage: null },
              { stage: { $exists: false } },
            ],
          },
        ];
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
        // MB9c — the Qualified saved-view segment. Divergent-truth fix (view
        // level only): disqualify sets stage "lost" but deliberately KEEPS the
        // qualified flag (permanent qualifiedBy credit — InternMetrics reads it),
        // so this view must exclude lost leads itself, mirroring "golden" below.
        query.qualified = true;
        query.stage = { $ne: "lost" };
        query.isLost = { $ne: true };
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

    // Additive bucket / temperature fragments AND-ed into the scoped filter below.
    const cutoffs = temperatureCutoffs();
    const bucketFragments = [];
    if (hasLifecycle) {
      const frag = lifecycleFragment(lifecycleKey, cutoffs.today);
      if (frag) bucketFragments.push(frag);
    }
    // Event-date family (temperature bucket + per-day date-status flags) — the
    // members OR together (a lead matches if it fits ANY selected event-date
    // option), then the group is AND-ed into the scoped filter as one narrower.
    // Lifecycle stays a separate mandatory AND (pushed above), NOT in this OR.
    const eventDateFrags = [];
    const temperatureKey = req.query.temperature;
    if (TEMPERATURE_KEYS.includes(temperatureKey)) {
      const tFrag = temperatureFilter(temperatureKey, cutoffs);
      if (tFrag) eventDateFrags.push(tFrag);
    }
    for (const k of parseDateStatus(req.query.dateStatus)) {
      const f = dateStatusFragment(k);
      if (f) eventDateFrags.push(f);
    }
    if (eventDateFrags.length === 1) bucketFragments.push(eventDateFrags[0]);
    else if (eventDateFrags.length > 1) bucketFragments.push({ $or: eventDateFrags });

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
    // ?includeTeam=1 (opt-in) ORs the caller's roster leads into that scope.
    const callerScope = await effectiveScopeFilter(req);
    const scopedFilter = { $and: [query, callerScope, visibility, ...filterConditions, ...bucketFragments] };
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
            .then(async (result) => {
              // Journey v2 (V8) — per-row commitment marks, batched: exactly
              // TWO extra queries for the whole page (embedded rows come off
              // the docs already in memory). Scoped: own-scope callers count
              // only their own commitments; snoozed leads read zeros.
              let rowMarksMap = new Map();
              try {
                rowMarksMap = await require("../services/CommitmentService").rowMarks(result, {
                  scope: req.scope,
                  callerId: req.auth.user_id,
                });
              } catch (e) {
                console.error("[enquiry.GetAll] rowMarks failed:", e.message);
              }
              // Additive: decorate each row (on the toObject COPY — never a DB
              // write) with its `lifecycle` bucket + event-date `temperature`.
              // `lifecycle` uses the same per-request `today` as temperature, and
              // bucketOf mirrors lifecycleFragment so a row returned under
              // ?lifecycle=<k> always has row.lifecycle === <k>.
              const list = result.map((doc) => {
                const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
                o.lifecycle = bucketOf(o, cutoffs.today);
                o.temperature = temperatureOf(
                  o.qualificationData && o.qualificationData.eventDate,
                  cutoffs
                );
                o.temperatureLabel = temperatureLabelOf(
                  o.qualificationData && o.qualificationData.eventDate,
                  cutoffs
                );
                o.dateNotDecided = Array.isArray(o.qualificationData?.eventDays) &&
                  o.qualificationData.eventDays.some((d) => d && d.dateUnknown);
                o.datesTentative = Array.isArray(o.qualificationData?.eventDays) &&
                  o.qualificationData.eventDays.some((d) => d && d.tentative);
                o.sourceChannel = sourceChannelOf(o.source, o.marketingSource);
                // Journey v2 (V6): deal value is MANAGER+ information — own-
                // scope callers get null; broader scopes see { amount } only
                // (the full history never rides list rows).
                o.dealValue =
                  req.scope && req.scope !== "own" && o.dealValue && o.dealValue.amount != null
                    ? { amount: o.dealValue.amount }
                    : null;
                // Journey v2 (V8): the row marks (dueToday/overdue).
                const rm = rowMarksMap.get(String(o._id)) || { dueToday: 0, overdue: 0 };
                o.dueToday = rm.dueToday;
                o.overdue = rm.overdue;
                return o;
              });
              // MB9c-fix — include `total` so the list footer can show "X of Y".
              res.send({ list, total, totalPages, page, limit });
            })
            .catch((error) => {
              respondCatch(res, error);
            });
        })
        .catch((error) => {
          respondCatch(res, error);
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
              callerScope,
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
              const list = result.map((doc) => {
                const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
                o.lifecycle = bucketOf(o, cutoffs.today);
                o.temperature = temperatureOf(
                  o.qualificationData && o.qualificationData.eventDate,
                  cutoffs
                );
                o.temperatureLabel = temperatureLabelOf(
                  o.qualificationData && o.qualificationData.eventDate,
                  cutoffs
                );
                o.dateNotDecided = Array.isArray(o.qualificationData?.eventDays) &&
                  o.qualificationData.eventDays.some((d) => d && d.dateUnknown);
                o.datesTentative = Array.isArray(o.qualificationData?.eventDays) &&
                  o.qualificationData.eventDays.some((d) => d && d.tentative);
                o.sourceChannel = sourceChannelOf(o.source, o.marketingSource);
                // Journey v2 (V6): deal value is MANAGER+ information — own-
                // scope callers get null; broader scopes see { amount } only
                // (the full history never rides list rows).
                o.dealValue =
                  req.scope && req.scope !== "own" && o.dealValue && o.dealValue.amount != null
                    ? { amount: o.dealValue.amount }
                    : null;
                return o;
              });
              res.send({ list, totalPages, page, limit });
            })
            .catch((error) => {
              respondCatch(res, error);
            });
        })
        .catch((error) => {
          respondCatch(res, error);
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
        respondCatch(res, error);
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
        respondCatch(res, error);
      });
  }
};

// UPDATE: previously this endpoint only updated the lead name.
// Now it can also persist selected fields under `additionalInfo` via `additionalInfoUpdates`,
// which is used by the admin lead-details page for things like Store Access and Client Budget.
const UpdateLead = async (req, res) => {
  const { _id } = req.params;
  const { name, phone, email, marketingSource, additionalInfoUpdates, qualifierNotes } =
    req.body;

  const updateFields = {};

  if (name) {
    updateFields.name = name;
  }

  // SEQ-1 — the qualifier's discovery notes (writable anytime pre-qual via this
  // scoped route). Empty string is allowed (lets the intern clear them).
  if (typeof qualifierNotes === "string") {
    updateFields.qualifierNotes = qualifierNotes;
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
      return respondCatch(res, err);
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
      respondCatch(res, error);
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
      respondCatch(res, error);
    });
};

// EXTENSION: enrich the single-lead GET response with:
// - paymentStats (existing behaviour)
// - statusSummary (NEW) derived from Orders + Biddings, used by the "Makeup Report" UI boxes.
const Get = (req, res) => {
  const { _id } = req.params;
  // Defensive: reject a non-ObjectId id with a clean 400 BEFORE querying, rather
  // than letting Mongoose throw a CastError that the terminal catch masks as an
  // opaque 400 {message:"error"}. This also stops a literal path that fell through
  // to /:_id (e.g. a missing sibling route) from surfacing as a cryptic cast error.
  if (!mongoose.isValidObjectId(_id)) {
    return res.status(400).send({ message: "Invalid lead id" });
  }
  // RBAC scope: the doc must also satisfy req.scopeFilter. An out-of-scope id simply
  // yields no match -> the same 404 as a missing enquiry (does not reveal it exists).
  // Slice B1 (qualify continuity): a CURRENT roster member may READ the lead even
  // after the handoff moved assignedTo out of their scope — read-only widening;
  // every write route keeps its owner/manager gate.
  Enquiry.findOne({ $and: [{ _id }, req.scopeFilter || {}] })
    .then(async (result) => {
      if (!result && (await isCurrentRosterMember(_id, req.auth.user_id))) {
        result = await Enquiry.findById(_id);
      }
      if (!result) {
        res.status(404).send();
      } else {
        // Backward compatibility: Convert old string conversations to new format.
        // Important: if we migrate, we re-read the updated doc so subdocuments get real _id values immediately
        // (required for editing/updating a specific note from the admin UI).
        let resultObj = result.toObject();
        // Per-request cutoffs, computed ONCE and in scope for proceedWith below,
        // where the lifecycle/temperature decoration is applied to the response
        // copy (see proceedWith) so BOTH the common and migration exit paths carry it.
        const cutoffs = temperatureCutoffs();
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

        const proceedWith = async (finalResultObj) => {
          // Additive: decorate the single-lead response COPY (in-memory object —
          // never a DB write) with its `lifecycle` bucket + event-date
          // `temperature`, mirroring GetAll's list rows verbatim. Placed in this
          // SHARED exit so it runs exactly once for EVERY return path — including
          // the legacy conversation-migration branch, which passes its own
          // migrated.toObject() copy through here. bucketOf mirrors
          // lifecycleFragment, so the lead-detail header shows the SAME values
          // the list shows for this lead. Later spreads preserve these keys.
          finalResultObj.lifecycle = bucketOf(finalResultObj, cutoffs.today);
          finalResultObj.temperature = temperatureOf(
            finalResultObj.qualificationData && finalResultObj.qualificationData.eventDate,
            cutoffs
          );
          finalResultObj.temperatureLabel = temperatureLabelOf(
            finalResultObj.qualificationData && finalResultObj.qualificationData.eventDate,
            cutoffs
          );
          finalResultObj.dateNotDecided = Array.isArray(finalResultObj.qualificationData?.eventDays) &&
            finalResultObj.qualificationData.eventDays.some((d) => d && d.dateUnknown);
          finalResultObj.datesTentative = Array.isArray(finalResultObj.qualificationData?.eventDays) &&
            finalResultObj.qualificationData.eventDays.some((d) => d && d.tentative);
          // Mid-qualify slice — canonical channel from the messy stored source
          // (derive-on-read; stored text never rewritten).
          finalResultObj.sourceChannel = sourceChannelOf(finalResultObj.source, finalResultObj.marketingSource);

          // Slice A2 — snooze decoration: { until, source, waking } when the
          // lead is parked, null otherwise. Fire-safe (decoration returns null
          // on any internal failure — the GET must never break on snooze).
          finalResultObj.snooze = await require("../services/SnoozeService").decoration(finalResultObj);

          // Journey v2 (V1) — the raw material behind the canonical brief:
          // every pre-qualification note {text, author, when, source}. Named
          // qualifierNoteFeed because `qualifierNotes` is ALREADY the legacy
          // string field (still rides toObject unchanged — additive only).
          // leadBrief itself is a schema field and rides toObject.
          try {
            finalResultObj.qualifierNoteFeed =
              await require("../services/LeadBriefService").qualifierNoteFeed(finalResultObj._id);
          } catch (e) {
            finalResultObj.qualifierNoteFeed = [];
          }

          // Journey v2 (V6) — the deal-clock hero { days, tone, blocker } —
          // null when un-qualified / terminal / snoozed. Fire-safe.
          finalResultObj.dealClock =
            await require("../services/LeadLifecycleService").dealClockDecoration(finalResultObj);

          // SEQ-1 — enrich every GET branch with the COMPUTED discovery snapshot
          // (discoveryComplete + discovery.missing + discovery.state). Computed,
          // never stored. qualifierNotes is a plain stored field and already
          // rides toObject().
          finalResultObj = { ...finalResultObj, ...computeDiscovery(finalResultObj) };

          // Slice B2 — the deal spine: derive-on-read station strip (qualified →
          // meeting set → held → proposal → agreement → onboarded). Inputs are
          // batched (one query per collection, Promise.all — no N+1); any
          // failure leaves the payload without dealSpine, never a 500.
          try {
            const spineInputs = await DealSpineService.spineInputs(finalResultObj._id);
            finalResultObj.dealSpine = DealSpineService.computeDealSpine(finalResultObj, spineInputs);
          } catch (e) {
            console.error("[enquiry.Get] dealSpine failed:", e.message);
          }

          // ── State-1 (ADDITIVE, read-only) — surface the lead OWNER'S MANAGER
          // first name: lead.assignedTo → Admin → reportingManagerId → that
          // Admin's first name (assignedToManagerName). Best-effort: any failure
          // leaves the payload UNCHANGED. assignedTo's own shape is untouched.
          const ownerId = finalResultObj.assignedTo;
          if (ownerId) {
            Admin.findById(ownerId, { reportingManagerId: 1 })
              .lean()
              .then((owner) => {
                if (owner && owner.reportingManagerId) {
                  return Admin.findById(owner.reportingManagerId, { name: 1 }).lean();
                }
                return null;
              })
              .then((manager) => {
                if (manager && manager.name) {
                  const firstName = String(manager.name).trim().split(/\s+/)[0] || "";
                  finalResultObj = { ...finalResultObj, assignedToManagerName: firstName };
                }
                continueWithUser(finalResultObj);
              })
              .catch(() => continueWithUser(finalResultObj));
          } else {
            continueWithUser(finalResultObj);
          }
        };

        // Existing user-resolution + summary chain, factored out unchanged so the
        // manager lookup above can run first without altering any response shape.
        const continueWithUser = (finalResultObj) => {
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
                                  respondCatch(res, error);
                                });
                            })
                            .catch((error) => {
                              respondCatch(res, error);
                            });
                        })
                        .catch((error) => {
                          respondCatch(res, error);
                        });
                      })
                      .catch((error) => {
                        respondCatch(res, error);
                      });
                  })
                  .catch((error) => {
                    respondCatch(res, error);
                  });
              }
            })
            .catch((error) => {
              respondCatch(res, error);
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
      respondCatch(res, error);
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
      respondCatch(res, error);
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
            respondCatch(res, error);
          });
      }
    })
    .catch((error) => {
      respondCatch(res, error);
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
    .then(async (result) => {
      if (!result) {
        res.status(404).send();
      } else {
        // Signal spine: a timestamped conversation note is an any-channel
        // customer response (per the Signal Matrix decision) + activity.
        await EnquiryRepository.stampFirstRespondedAt(_id, createdAtDate);
        await EnquiryRepository.touchLastActivity(_id);
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      respondCatch(res, error);
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
      respondCatch(res, error);
    });
};

const UpdateNotes = (req, res) => {
  const { _id } = req.params;
  const { notes } = req.body;
  Enquiry.findByIdAndUpdate({ _id }, { $set: { "updates.notes": notes } })
    .then(async (result) => {
      if (!result) {
        res.status(404).send();
      } else {
        // Signal spine: the notes blob is activity only (no per-note timestamp
        // → never contributes to firstRespondedAt).
        await EnquiryRepository.touchLastActivity(_id);
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      respondCatch(res, error);
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
      respondCatch(res, error);
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
    respondCatch(res, error);
  }
};

// GET /enquiry/lifecycle-counts — real DB counts per lifecycle bucket, computed
// via a single $facet aggregation (no docs loaded, NO cap). Honours the SAME
// base narrowers as the list (search / filters / source / date / temperature)
// AND the SAME RBAC scope (req.scopeFilter) + visibility, so the chip badges
// match exactly what the caller is allowed to see. Buckets come from the shared
// lifecycleFragment, so counts and the list can never disagree.
const LifecycleCounts = async (req, res) => {
  try {
    const base = buildBaseQuery(req);
    let filterConditions = [];
    try {
      filterConditions = await buildFilterConditions(req.query.filters);
    } catch (fbError) {
      return res.status(fbError.status || 400).send({ message: fbError.message });
    }
    const visibility = await currentVisibilityFilter();
    // One cutoff set per request → the SAME today-boundary feeds both the
    // lifecycle "past event" fold and the temperature filter (single source).
    const cutoffs = temperatureCutoffs();
    const bucketFragments = [];
    // Same event-date OR group the list uses (temperature bucket + per-day
    // date-status flags), so counts stay in lock-step with the filtered list.
    const eventDateFrags = [];
    const temperatureKey = req.query.temperature;
    if (TEMPERATURE_KEYS.includes(temperatureKey)) {
      const tFrag = temperatureFilter(temperatureKey, cutoffs);
      if (tFrag) eventDateFrags.push(tFrag);
    }
    for (const k of parseDateStatus(req.query.dateStatus)) {
      const f = dateStatusFragment(k);
      if (f) eventDateFrags.push(f);
    }
    if (eventDateFrags.length === 1) bucketFragments.push(eventDateFrags[0]);
    else if (eventDateFrags.length > 1) bucketFragments.push({ $or: eventDateFrags });
    // Same mandatory $and shape the list uses (scope can only narrow, never
    // widen) — including the same opt-in ?includeTeam=1 roster widening, so the
    // chip badges always match the list.
    const baseMatch = {
      $and: [base, await effectiveScopeFilter(req), visibility, ...filterConditions, ...bucketFragments],
    };
    const facet = {};
    for (const key of LIFECYCLE_KEYS) {
      facet[key] = [{ $match: lifecycleFragment(key, cutoffs.today) }, { $count: "n" }];
    }
    facet.all = [{ $count: "n" }];
    const agg = await Enquiry.aggregate([{ $match: baseMatch }, { $facet: facet }]);
    const f = agg[0] || {};
    const num = (k) => (f[k] && f[k][0] ? f[k][0].n : 0);
    res.send({
      fresh: num("fresh"),
      touched: num("touched"),
      qualified: num("qualified"),
      meeting: num("meeting"),
      lost: num("lost"),
      all: num("all"),
    });
  } catch (error) {
    console.error("[lifecycle-counts]", error);
    respondCatch(res, error);
  }
};

module.exports = {
  CreateNew,
  GetAll,
  LifecycleCounts,
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
  effectiveScopeFilter,
};
