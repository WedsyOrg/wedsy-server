const mongoose = require("mongoose");
const LeaveRequest = require("../models/LeaveRequest");
const LeaveBalance = require("../models/LeaveBalance");
const CompOff = require("../models/CompOff");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const SettingsService = require("./SettingsService");
const CompanyHolidayService = require("./CompanyHolidayService");
const AttendanceDayService = require("./AttendanceDayService");
const AdminNotificationService = require("./AdminNotificationService");
const { permissionSatisfies } = require("../middlewares/requirePermission");
const { isServiceAccount } = require("../utils/employment");
const { dayKey } = require("./hrPolicy");
const P = require("./leavePolicy");

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Human names for the strip and for messages an applicant reads.
const TYPE_NAME = { CL: "casual leave", SL: "sick leave", EL: "earned leave", WFH: "WFH", COMP_OFF: "comp-off" };
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────────
// BALANCES
// available = entitled + carriedIn − reserved − consumed
// ─────────────────────────────────────────────────────────────────────────────
const availableOf = (b) =>
  (b.entitled || 0) + (b.carriedIn || 0) - (b.reserved || 0) - (b.consumed || 0);

// Lazily create the year's row at its policy entitlement. Idempotent, and safe
// against a concurrent create via the unique { adminId, year, type } index.
const ensureBalance = async (adminId, year, type) => {
  const existing = await LeaveBalance.findOne({ adminId, year, type });
  if (existing) return existing;
  try {
    return await LeaveBalance.create({
      adminId, year, type,
      entitled: P.entitlementFor(type, year),
      isStub: P.isStubYear(year),
    });
  } catch (e) {
    if (e && e.code === 11000) return LeaveBalance.findOne({ adminId, year, type });
    throw e;
  }
};

const balancesFor = async (adminId, year) => {
  const rows = await Promise.all(P.TYPES.map((t) => ensureBalance(adminId, year, t)));
  return rows.map((b) => ({
    type: b.type, year: b.year, entitled: b.entitled, carriedIn: b.carriedIn,
    reserved: b.reserved, consumed: b.consumed, available: availableOf(b), isStub: b.isStub,
  }));
};

// ── YEAR-END ROLL ───────────────────────────────────────────────────────────
// Opens next year's rows and carries EL forward, capped at 20. The 2026 stub
// carries NOTHING — it is a write-off window, not year one, and 1 Jan 2027 is a
// clean reset to the full annual figures.
const rollYear = async (fromYear, adminIds = null) => {
  const filter = { year: fromYear, ...(adminIds ? { adminId: { $in: adminIds } } : {}) };
  const rows = await LeaveBalance.find(filter).lean();
  const out = { opened: 0, carried: 0, lapsed: 0 };
  for (const b of rows) {
    const unused = Math.max(0, availableOf(b));
    const carry = P.carryForward(b.type, b.year, unused);
    out.lapsed += unused - carry;
    const next = await ensureBalance(b.adminId, fromYear + 1, b.type);
    // Guarded so a re-run cannot stack the carry a second time.
    const res = await LeaveBalance.updateOne(
      { _id: next._id, carriedIn: 0 },
      { $set: { carriedIn: carry } }
    );
    if (res.modifiedCount) out.carried += carry;
    out.opened += 1;
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// APPROVERS — two levels, either may approve.
// The applicant's manager AND that manager's manager. Terminates early when
// there is nobody above.
//
// EMPTY CHAIN IS NOT AUTO-APPROVAL. A request nobody signed off is a silent hole
// in an accountability system, invisible until someone notices. It falls back to
// any holder of leave:approve:all, so a real person always sees it.
//
// The ONE exception is somebody genuinely AT THE TOP — no manager above them at
// all. There is nobody to escalate to by definition, so their own leave
// auto-approves with the reason recorded.
// ─────────────────────────────────────────────────────────────────────────────
const managerChain = async (adminId, levels = 2) => {
  const chain = [];
  let cursor = adminId;
  for (let i = 0; i < levels; i++) {
    const who = await Admin.findById(cursor, { reportingManagerId: 1 }).lean();
    const mgr = who && who.reportingManagerId;
    if (!mgr) break;
    if (chain.some((c) => String(c) === String(mgr))) break; // cycle guard
    chain.push(mgr);
    cursor = mgr;
  }
  return chain;
};

const holdersOfApproveAll = async () => {
  const roles = await Role.find({}, { _id: 1, permissions: 1 }).lean();
  const okRoleIds = roles
    .filter((r) => permissionSatisfies(r.permissions || [], "leave:approve:all").allowed)
    .map((r) => String(r._id));
  if (!okRoleIds.length) return [];
  const admins = await Admin.find(
    { $or: [{ roleIds: { $in: okRoleIds } }, { roleId: { $in: okRoleIds } }], isDisabled: { $ne: true } },
    { _id: 1 }
  ).lean();
  return admins.map((a) => a._id);
};

const resolveApprovers = async (adminId) => {
  const chain = await managerChain(adminId, 2);
  if (chain.length) return { approvers: chain, atTop: false };
  const fallback = (await holdersOfApproveAll()).filter((id) => String(id) !== String(adminId));
  if (fallback.length) return { approvers: fallback, atTop: false };
  // Nobody above, and nobody holding the org-wide grant: this person IS the top.
  return { approvers: [], atTop: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION — every rule the policy actually states
// ─────────────────────────────────────────────────────────────────────────────
const otherLeaveDays = async (adminId, type, excludeId = null) => {
  const rows = await LeaveRequest.find(
    { adminId, type, status: { $in: ["pending", "approved"] }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
    { days: 1 }
  ).lean();
  return rows.flatMap((r) => r.days.map((d) => d.date));
};

const validate = async ({ admin, type, days, medicalCertificate, todayKey }) => {
  const warnings = [];
  const workingDays = (await SettingsService.getMany(["hr.workingDays"]))["hr.workingDays"];
  const dayKeys = days.map((d) => d.date);
  const first = [...dayKeys].sort()[0];
  const last = [...dayKeys].sort().slice(-1)[0];
  const holidayKeys = await CompanyHolidayService.holidayKeysBetween(
    P.shiftDay(first, -7), P.shiftDay(last, 7)
  );

  const total = days.reduce((s, d) => s + Number(d.fraction), 0);
  const notice = {
    noticeDays: P.noticeFor(todayKey, dayKeys),
    requiredNoticeDays: P.NOTICE_DAYS[type] ?? 0,
  };

  // Not a working day — you were not due in, so no leave is needed. RECORDED
  // rather than refused: mistaking which days are off is a genuine calendar
  // misunderstanding, not a malformed request.
  //
  // Returns EARLY. The rules below reason about runs of consecutive working days
  // and adjacency, and feeding them days that are not working days at all would
  // produce a second, confusing breach on top of the real one.
  const breaches = [];

  const offDays = dayKeys.filter((d) => !P.isWorkingDay(d, workingDays, holidayKeys));
  if (offDays.length) {
    return {
      total, shortNotice: false, ...notice, warnings: [],
      breaches: [{
        code: "non_working_day",
        label: "Not a working day",
        message: `${offDays.join(", ")} ${offDays.length > 1 ? "are not working days" : "is not a working day"} — no leave is needed for ${offDays.length > 1 ? "them" : "it"}.`,
      }],
    };
  }

  // WFH is whole days only. RECORDED — thinking a half-day WFH is available is
  // an ordinary good-faith misunderstanding of the policy.
  if (type === "WFH" && days.some((d) => Number(d.fraction) !== 1)) {
    breaches.push({
      code: "wfh_whole_day_only",
      label: "WFH is whole days only",
      message: "WFH is whole-day only — half-days are not available on it.",
    });
  }

  // ── POLICY BREACHES: COLLECTED, NOT THROWN (2026-08-24) ─────────────────
  // These three are things a reasonable person could apply for in good faith and
  // be wrong about. They are recorded and auto-rejected with the specific
  // reason, exactly like a same-day request — so the attempt is visible to the
  // approver AND to the applicant's own history. A 400 left no trace of either.
  //
  // Malformed input is NOT in here and still throws: see the line drawn in
  // apply() below.

  // WFH max 1 per calendar month, counted across all pending/approved requests.
  if (type === "WFH") {
    const existing = await otherLeaveDays(admin._id, "WFH");
    const byMonth = new Map();
    for (const d of [...existing, ...dayKeys]) {
      byMonth.set(P.monthKey(d), (byMonth.get(P.monthKey(d)) || 0) + 1);
    }
    for (const [month, n] of byMonth) {
      if (n > P.WFH_PER_MONTH) {
        breaches.push({
          code: "wfh_monthly_cap",
          label: `WFH is ${P.WFH_PER_MONTH} day a month`,
          message: `WFH is limited to ${P.WFH_PER_MONTH} day per month — ${month} would have ${n}.`,
        });
        break;
      }
    }
  }

  // CL: max 2 CONSECUTIVE WORKING days, across all pending/approved CL too.
  if (type === "CL") {
    const existing = await otherLeaveDays(admin._id, "CL");
    const run = P.consecutiveRunLength([...existing, ...dayKeys], workingDays, holidayKeys);
    if (run > P.MAX_CONSECUTIVE.CL) {
      breaches.push({
        code: "cl_consecutive",
        label: `Casual leave caps at ${P.MAX_CONSECUTIVE.CL} consecutive days`,
        message: `Casual leave allows at most ${P.MAX_CONSECUTIVE.CL} consecutive working days — this would make ${run}.`,
      });
    }
    // …and cannot be clubbed with EL.
    const elDays = await otherLeaveDays(admin._id, "EL");
    const clash = P.clubsWithEl(dayKeys, elDays, workingDays, holidayKeys);
    if (clash) {
      breaches.push({
        code: "cl_el_clubbing",
        label: "Casual leave can't sit next to earned leave",
        message: `Casual leave cannot be clubbed with earned leave — ${clash} is adjacent to an EL day.`,
      });
    }
  }

  // EL: cannot be clubbed with CL either — the rule is symmetric.
  if (type === "EL") {
    const clDays = await otherLeaveDays(admin._id, "CL");
    const clash = P.clubsWithEl(clDays, dayKeys, workingDays, holidayKeys);
    if (clash) {
      breaches.push({
        code: "cl_el_clubbing",
        label: "Earned leave can't sit next to casual leave",
        message: `Earned leave cannot be clubbed with casual leave — ${clash} is adjacent to a CL day.`,
      });
    }
  }

  // SL: medical certificate required over 2 total days.
  if (type === "SL" && total > P.MEDICAL_CERT_OVER_DAYS.SL && !String(medicalCertificate || "").trim()) {
    throw err(400, `A medical certificate is required for more than ${P.MEDICAL_CERT_OVER_DAYS.SL} days of sick leave`);
  }

  // Advance notice — WARN AND FLAG, never block.
  const required = P.NOTICE_DAYS[type] ?? 0;
  const given = P.noticeFor(todayKey, dayKeys);
  const shortNotice = given < required;
  if (shortNotice) {
    warnings.push(`Applied ${given} day(s) ahead; ${type} asks for ${required}. Submitted and flagged short-notice.`);
  }

  return { total, shortNotice, noticeDays: given, requiredNoticeDays: required, warnings, breaches };
};

// ─────────────────────────────────────────────────────────────────────────────
// APPLY
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// THE LINE between a recorded auto-rejection and a genuine 400:
//
//   RECORDED  — could a reasonable person have submitted this in good faith,
//               believing it was allowed? Then it is a POLICY breach: the
//               attempt is information, for the approver and for the applicant's
//               own history. Recorded, auto-rejected, reserves nothing.
//               (same-day · CL 2-consecutive · CL/EL clubbing · WFH 1-a-month)
//
//   400       — the request is malformed, or names something that does not
//               exist. There is no attempt to record because there was no
//               coherent request: an unknown type, a bad date, a fraction that
//               is not 1 or 0.5, a duplicated date, an empty days[], a request
//               spanning two calendar years. Nothing is written.
//
//   403 / 404 — authorisation and identity. A service account applying is not a
//               policy breach; it is a caller that may not apply at all.
//
// The test suite asserts BOTH halves, so the line cannot quietly move.
const recordAutoRejection = async ({ adminId, type, days, total, reason, code, label, message, todayKey, dayKeys, now }) => {
  const doc = await LeaveRequest.create({
    adminId, type, days, totalDays: total, reason: String(reason || ""),
    status: "auto_rejected",
    decidedAt: now,
    decisionNote: message,
    autoRejectCode: code,
    autoRejectLabel: label,
    noticeDays: P.noticeFor(todayKey, dayKeys), requiredNoticeDays: P.NOTICE_DAYS[type] ?? 0,
  });
  return {
    request: doc.toObject(),
    autoRejected: true,
    breach: { code, label, message },
    warnings: [`${message} The application has been recorded.`],
  };
};

const apply = async ({ type, days, reason, medicalCertificate }, actorId, now = new Date()) => {
  if (!P.TYPES.includes(type) && type !== "COMP_OFF") throw err(400, `type must be one of ${[...P.TYPES, "COMP_OFF"].join(", ")}`);
  if (!Array.isArray(days) || !days.length) throw err(400, "days must be a non-empty array of { date, fraction }");

  const admin = await Admin.findById(actorId).lean();
  if (!admin) throw err(404, "Applicant not found");
  // A service account is a login, not a person. It has no leave to take.
  if (isServiceAccount(admin)) throw err(403, "Service accounts cannot apply for leave");

  const clean = days.map((d) => {
    if (!DAY_RE.test(String(d && d.date))) throw err(400, 'each day needs a date of the form "YYYY-MM-DD"');
    const f = d.fraction === undefined ? 1 : Number(d.fraction);
    if (![0.5, 1].includes(f)) throw err(400, "fraction must be 1 (full day) or 0.5 (half day)");
    return { date: d.date, fraction: f };
  });
  if (new Set(clean.map((d) => d.date)).size !== clean.length) throw err(400, "the same date appears twice");

  const todayKey = dayKey(now);
  const dayKeys = clean.map((d) => d.date);
  const total = clean.reduce((s, d) => s + d.fraction, 0);

  // ── SAME-DAY: accept, AUTO-REJECT, keep the record ──────────────────────
  // A blocked submission leaves no trace of the attempt, and the pattern of
  // attempts is itself information. No balance is reserved for it.
  if (P.isSameDayOrPast(todayKey, dayKeys)) {
    return recordAutoRejection({
      adminId: actorId, type, days: clean, total, reason,
      code: "same_day",
      label: "Same-day request",
      message: "Same-day (or past-dated) leave is auto-rejected by policy.",
      todayKey, dayKeys, now,
    });
  }

  if (type === "COMP_OFF") return applyCompOff({ clean, total, reason, admin, todayKey, now });

  const v = await validate({ admin, type, days: clean, medicalCertificate, todayKey });

  // ── A POLICY BREACH IS RECORDED AND AUTO-REJECTED ───────────────────────
  // ⚠️ THIS RETURNS BEFORE THE RESERVATION BELOW, deliberately. An auto-rejected
  // request must never hold balance even momentarily: a brief hold that is then
  // released is exactly the window in which a concurrent request sees less than
  // it should and is refused for a reason that never really existed.
  if (v.breaches.length) {
    const b = v.breaches[0];
    return recordAutoRejection({
      adminId: actorId, type, days: clean, total: v.total, reason,
      code: b.code, label: b.label, message: b.message,
      todayKey, dayKeys, now,
    });
  }

  // ── RESERVE ON SUBMISSION ───────────────────────────────────────────────
  // Without this, two pending requests each pass the sufficiency check
  // independently and the second approval over-draws.
  const year = P.yearOf(dayKeys[0]);
  if (new Set(dayKeys.map(P.yearOf)).size > 1) throw err(400, "a request cannot span two calendar years — split it");
  const bal = await ensureBalance(actorId, year, type);

  // ── RESERVE FIRST, ATOMICALLY, THEN WRITE THE REQUEST ────────────────────
  //
  // ⚠️ DO NOT "SIMPLIFY" THIS $expr BACK TO A READ-THEN-WRITE. It replaces a
  // race that was LIVE in production (found 2026-08-24):
  //
  //     const bal = await ensureBalance(...)        // read
  //     if (availableOf(bal) < total) throw ...     // decide
  //     await LeaveBalance.updateOne(..., { $inc: { reserved: total } })  // write
  //
  // Two applications submitted at the same moment BOTH complete the read before
  // either writes, both see the full balance, and both reserve — over-drawing the
  // entitlement by exactly the amount reserving was introduced to prevent. The
  // window is small but it is widest on the day everyone applies at once, which
  // is precisely when it matters.
  //
  // Putting the sufficiency test INSIDE the update filter makes claiming the
  // balance a single atomic operation: the second writer's filter no longer
  // matches and modifiedCount comes back 0. The readable version is the broken
  // one.
  const claimed = await LeaveBalance.updateOne(
    {
      _id: bal._id,
      $expr: {
        $gte: [
          { $subtract: [{ $add: ["$entitled", "$carriedIn"] }, { $add: ["$reserved", "$consumed"] }] },
          v.total,
        ],
      },
    },
    { $inc: { reserved: v.total } }
  );
  if (!claimed.modifiedCount) {
    // ── RUNNING OUT IS NOT A RULE BREACH ──────────────────────────────────
    // Recorded like one — the attempt is the same kind of signal — but under
    // its OWN code. "You'd run out" and "you broke a rule" read very
    // differently to whoever reviews the strip, and filing them together makes
    // a balance problem look like misconduct.
    //
    // Nothing was reserved: the guarded update above did not match, so this
    // path holds no balance to release.
    const fresh = await LeaveBalance.findById(bal._id).lean();
    const left = availableOf(fresh);
    return recordAutoRejection({
      adminId: actorId, type, days: clean, total: v.total, reason,
      code: "insufficient_balance",
      label: `Not enough ${TYPE_NAME[type] || type} left`,
      message: `Not enough ${TYPE_NAME[type] || type} left: ${left} day(s) available, ${v.total} requested.`,
      todayKey, dayKeys, now,
    });
  }

  let doc;
  try {
    const { approvers, atTop: top } = await resolveApprovers(actorId);
    doc = await LeaveRequest.create({
      adminId: actorId, type, days: clean, totalDays: v.total, reason: String(reason || ""),
      status: "pending",
      shortNotice: v.shortNotice, noticeDays: v.noticeDays, requiredNoticeDays: v.requiredNoticeDays,
      medicalCertificate: String(medicalCertificate || ""),
      approvers,
    });
    doc.__atTop = top;
    doc.__approvers = approvers;
  } catch (e) {
    // Never strand a reservation against a request that was never written.
    await LeaveBalance.updateOne({ _id: bal._id }, { $inc: { reserved: -v.total } });
    throw e;
  }
  const approvers = doc.__approvers;
  const atTop = doc.__atTop;

  // Nobody above them at all — there is no one to escalate to by definition.
  if (atTop) {
    const approved = await decide(doc._id, { approve: true, note: "Auto-approved: no manager above the applicant." }, actorId, now, { systemAuto: true });
    return { request: approved.request, warnings: [...v.warnings, "No manager above you — auto-approved and recorded."], autoApproved: true };
  }

  await AdminNotificationService.notify(approvers, {
    type: "leave_request",
    title: `${admin.name} applied for ${type}`,
    message: `${v.total} day(s) from ${dayKeys.sort()[0]}${v.shortNotice ? " · SHORT NOTICE" : ""}`,
    payload: { leaveRequestId: String(doc._id), type, totalDays: v.total, shortNotice: v.shortNotice },
  });

  return { request: doc.toObject(), warnings: v.warnings };
};

// ── COMP-OFF application: spends granted, unexpired grants ──────────────────
const applyCompOff = async ({ clean, total, reason, admin, todayKey, now }) => {
  if (clean.some((d) => d.fraction !== 1)) throw err(400, "Comp-off is taken as whole days");
  const grants = await CompOff.find({ adminId: admin._id, status: "granted" }).sort({ expiresAt: 1 }).lean();
  const usable = [];
  for (const d of clean.map((x) => x.date).sort()) {
    // THE DATE USED must be within 30 days of the Sunday worked — applying
    // inside the window for a day beyond it does not count.
    const g = grants.find((x) => d <= x.expiresAt && !usable.some((u) => String(u.grant._id) === String(x._id)));
    if (!g) throw err(400, `No comp-off available that is still valid on ${d} — a grant expires 30 days after the Sunday worked`);
    usable.push({ grant: g, date: d });
  }
  const { approvers, atTop } = await resolveApprovers(admin._id);
  const doc = await LeaveRequest.create({
    adminId: admin._id, type: "COMP_OFF", days: clean, totalDays: total,
    reason: String(reason || ""), status: "pending", approvers,
    compOffIds: usable.map((u) => u.grant._id),
    noticeDays: P.noticeFor(todayKey, clean.map((d) => d.date)), requiredNoticeDays: 0,
  });
  if (atTop) {
    const approved = await decide(doc._id, { approve: true, note: "Auto-approved: no manager above the applicant." }, admin._id, now, { systemAuto: true });
    return { request: approved.request, autoApproved: true, warnings: ["No manager above you — auto-approved and recorded."] };
  }
  await AdminNotificationService.notify(approvers, {
    type: "leave_request",
    title: `${admin.name} applied for comp-off`,
    message: `${total} day(s) from ${clean.map((d) => d.date).sort()[0]}`,
    payload: { leaveRequestId: String(doc._id), type: "COMP_OFF", totalDays: total },
  });
  return { request: doc.toObject(), warnings: [] };
};

// ─────────────────────────────────────────────────────────────────────────────
// DECIDE — approve or reject. EITHER listed approver may act.
//
// ⚠️ EVERY approved day is written through AttendanceDayService.applyLeaveDecision().
// Nothing here touches Attendance.dayFraction or dayStatus directly — that is the
// single chokepoint, and bypassing it is how the denormalisation drifts.
// ─────────────────────────────────────────────────────────────────────────────
const DAY_STATUS_FOR = { CL: "leave_paid", SL: "leave_paid", EL: "leave_paid", WFH: "present", COMP_OFF: "comp_off" };

const decide = async (requestId, { approve, note }, actorId, now = new Date(), opts = {}) => {
  if (!isId(requestId)) throw err(400, "Invalid leave request id");
  const req = await LeaveRequest.findById(requestId);
  if (!req) throw err(404, "Leave request not found");
  if (req.status !== "pending") throw err(409, `This request is already ${req.status}`);

  if (!opts.systemAuto) {
    const isApprover = (req.approvers || []).some((a) => String(a) === String(actorId));
    if (!isApprover) {
      // A holder of leave:approve:all may always act, even off the chain.
      const wide = await holdersOfApproveAll();
      if (!wide.some((a) => String(a) === String(actorId))) {
        throw err(403, "You are not an approver for this request");
      }
    }
  }
  if (String(req.adminId) === String(actorId) && !opts.systemAuto) {
    throw err(403, "You cannot approve your own leave");
  }

  const year = P.yearOf(req.days[0].date);
  const isBalanced = P.TYPES.includes(req.type);

  if (!approve) {
    await LeaveRequest.updateOne(
      { _id: req._id, status: "pending" },
      { $set: { status: "rejected", decidedBy: actorId, decidedAt: now, decisionNote: String(note || "") } }
    );
    if (isBalanced) {
      const bal = await ensureBalance(req.adminId, year, req.type);
      await LeaveBalance.updateOne({ _id: bal._id }, { $inc: { reserved: -req.totalDays } });
    }
    await AdminNotificationService.notify([req.adminId], {
      type: "leave_decided", title: `Your ${req.type} was rejected`,
      message: String(note || ""), payload: { leaveRequestId: String(req._id), status: "rejected" },
    });
    return { request: (await LeaveRequest.findById(req._id)).toObject() };
  }

  // Guarded so two approvers clicking at once cannot both consume.
  const claimed = await LeaveRequest.updateOne(
    { _id: req._id, status: "pending" },
    { $set: { status: "approved", decidedBy: actorId, decidedAt: now, decisionNote: String(note || "") } }
  );
  if (!claimed.modifiedCount) throw err(409, "This request was already decided");

  if (isBalanced) {
    const bal = await ensureBalance(req.adminId, year, req.type);
    await LeaveBalance.updateOne({ _id: bal._id }, { $inc: { reserved: -req.totalDays, consumed: req.totalDays } });
  }
  if (req.type === "COMP_OFF") {
    const dates = req.days.map((d) => d.date).sort();
    for (let i = 0; i < req.compOffIds.length; i++) {
      await CompOff.updateOne(
        { _id: req.compOffIds[i], status: "granted" },
        { $set: { status: "consumed", consumedBy: req._id, consumedFor: dates[i] || null } }
      );
    }
  }

  // THE CHOKEPOINT — one call per day, never a direct write.
  for (const d of req.days) {
    await AttendanceDayService.applyLeaveDecision({
      adminId: req.adminId,
      date: d.date,
      dayFraction: req.type === "WFH" ? 1 : 1 - d.fraction,
      dayStatus: d.fraction === 0.5 ? "half_day" : DAY_STATUS_FOR[req.type],
      leaveRequestId: req._id,
    });
  }

  await AdminNotificationService.notify([req.adminId], {
    type: "leave_decided", title: `Your ${req.type} was approved`,
    message: String(note || ""), payload: { leaveRequestId: String(req._id), status: "approved" },
  });
  return { request: (await LeaveRequest.findById(req._id)).toObject() };
};

// Applicant withdraws while still pending — releases the reservation.
const cancel = async (requestId, actorId) => {
  const req = await LeaveRequest.findById(requestId);
  if (!req) throw err(404, "Leave request not found");
  if (String(req.adminId) !== String(actorId)) throw err(403, "Only the applicant can cancel their request");
  if (req.status !== "pending") throw err(409, `This request is already ${req.status}`);
  await LeaveRequest.updateOne({ _id: req._id, status: "pending" }, { $set: { status: "cancelled" } });
  if (P.TYPES.includes(req.type)) {
    const bal = await ensureBalance(req.adminId, P.yearOf(req.days[0].date), req.type);
    await LeaveBalance.updateOne({ _id: bal._id }, { $inc: { reserved: -req.totalDays } });
  }
  return (await LeaveRequest.findById(req._id)).toObject();
};

// ── COMP-OFF grants ─────────────────────────────────────────────────────────
const earnCompOff = async ({ adminId, earnedFor, note }, actorId) => {
  if (!DAY_RE.test(String(earnedFor || ""))) throw err(400, 'earnedFor must be an IST day key "YYYY-MM-DD"');
  const workingDays = (await SettingsService.getMany(["hr.workingDays"]))["hr.workingDays"];
  const { istWeekday } = require("./hrPolicy");
  if (workingDays.includes(istWeekday(earnedFor))) {
    throw err(400, `${earnedFor} is a working day — comp-off is earned by working a weekly off`);
  }
  try {
    const doc = await CompOff.create({
      adminId, earnedFor,
      expiresAt: P.shiftDay(earnedFor, P.COMP_OFF_VALID_DAYS),
      status: "pending", note: String(note || ""),
    });
    return doc.toObject();
  } catch (e) {
    if (e && e.code === 11000) throw err(409, `A comp-off already exists for ${earnedFor}`);
    throw e;
  }
};

const decideCompOff = async (id, { grant, note }, actorId) => {
  const row = await CompOff.findById(id);
  if (!row) throw err(404, "Comp-off not found");
  if (row.status !== "pending") throw err(409, `This comp-off is already ${row.status}`);
  await CompOff.updateOne(
    { _id: row._id, status: "pending" },
    { $set: { status: grant ? "granted" : "rejected", grantedBy: actorId, grantedAt: new Date(), note: String(note || row.note) } }
  );
  return CompOff.findById(row._id).lean();
};

// Expire grants past their window. Per-instance, which is why comp-off cannot be
// a counter. Idempotent; safe to run from the daily sweep.
const expireCompOffs = async (todayKey = dayKey()) => {
  const res = await CompOff.updateMany(
    { status: "granted", expiresAt: { $lt: todayKey } },
    { $set: { status: "expired" } }
  );
  return { expired: res.modifiedCount || 0 };
};

const listCompOffs = async (adminId) => CompOff.find({ adminId }).sort({ earnedFor: -1 }).lean();

const listRequests = async (scopeFilter = {}, { status, adminId } = {}) => {
  const q = { ...scopeFilter };
  if (status) q.status = status;
  if (adminId) q.adminId = adminId;
  return LeaveRequest.find(q).sort({ createdAt: -1 }).populate("adminId", "name").populate("decidedBy", "name").lean();
};

module.exports = {
  availableOf, ensureBalance, balancesFor, rollYear,
  managerChain, holdersOfApproveAll, resolveApprovers,
  validate, apply, decide, cancel,
  earnCompOff, decideCompOff, expireCompOffs, listCompOffs, listRequests,
};
