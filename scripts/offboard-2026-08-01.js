/* Offboard the six who left on 2026-08-01, and flag the service account.
 *
 * THE HOLE THIS CLOSES. Six of fifteen active admins left Wedsy on 1 August 2026
 * and are still fully active: holding roles, blocking every payroll run for want
 * of a salary record, eligible for leave, and able to log in. That is a live
 * access and payroll problem, not untidy data.
 *
 * WHAT AN EXIT WRITES, and why three fields:
 *   meta.exitedAt   the last working day, INCLUSIVE - the authoritative fact
 *   status:"exited" the fast index; every selector that filters status:"active"
 *                   drops them at once
 *   isDisabled      access revoked - a separate question, set here too
 *
 * NOT RETROACTIVE. August still computes: they were employed on 1 August, so an
 * August payroll run includes them for that day. September onwards excludes them.
 * Nothing is deleted - leads, enquiries, attendance and leave all stay attached.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT. --confirm is required to write anything.
 *   - ABORTS before writing if ANY name is missing, ambiguous, already exited,
 *     or leaves a REAL orphan. The org chart is checked ON PROD, here, not
 *     assumed - it could not be verified from a dev database, where 13 of these
 *     15 people do not exist.
 *   - DEPENDENCY ORDER. A leaver whose reports are ALSO on this list orphans
 *     nobody; checking each person in isolation could not see that and refused
 *     wrongly (Aafiya manages Lekiwao and Mahin, and all three are leaving).
 *     The set is planned as a whole and processed LEAVES-FIRST, so the chart is
 *     never momentarily broken part-way through the run. Only a report OUTSIDE
 *     the set is an orphan, and it is still named and still aborts.
 *   - Idempotent: a second run finds nothing to do and says so.
 *
 * RUN IT ON THE EC2 BOX, against prod:
 *
 *   ssh <ec2>
 *   cd /path/to/wedsy-server-crm
 *   node scripts/offboard-2026-08-01.js            # DRY RUN
 *   node scripts/offboard-2026-08-01.js --confirm  # apply
 *   node scripts/offboard-2026-08-01.js            # verify (nothing left to do)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const EXIT_DAY = "2026-08-01";
const LEAVERS = ["Aafiya", "Asiya", "Mahin", "Puspita", "Lekiwao", "Hiren"];
const SERVICE_ACCOUNTS = ["Wedsy Admin"];
const line = (s = "") => console.log(s);

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("DATABASE_URL not set - refusing to run.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const Admin = require("../models/Admin");
  const Offboarding = require("../services/OffboardingService");
  const { employedOn } = require("../utils/employment");

  line(`Target : ${mongoose.connection.host}/${mongoose.connection.name}`);
  line(`Mode   : ${CONFIRM ? "APPLY (--confirm)" : "DRY RUN (read-only)"}`);
  line(`Exit   : ${EXIT_DAY} (last working day, inclusive)`);
  line("");

  const all = await Admin.find({}, { name: 1, email: 1, status: 1, isDisabled: 1, meta: 1, joinedAt: 1, reportingManagerId: 1 }).lean();
  line(`admins on this database: ${all.length}`);

  const problems = [];
  const plan = [];
  const nameMatches = (needle) =>
    all.filter((a) => new RegExp(`\\b${needle}`, "i").test(String(a.name || "")));

  for (const needle of LEAVERS) {
    const found = nameMatches(needle);
    if (found.length === 0) { problems.push(`${needle}: no admin matches that name`); continue; }
    if (found.length > 1) {
      problems.push(`${needle}: AMBIGUOUS - matches ${found.map((f) => `${f.name} <${f.email}>`).join(" | ")}`);
      continue;
    }
    const a = found[0];
    if (a.status === "exited" || (a.meta && a.meta.exitedAt)) {
      line(`  already exited, skipping: ${a.name}`);
      continue;
    }
    plan.push({ admin: a });
  }

  // ── THE ORG-CHART CHECK, on the real data, ACROSS THE WHOLE SET ──────────
  // Reports are resolved for everyone first, then judged against the exit set:
  // a report who is also leaving is not an orphan.
  let exitOrder = [];
  if (plan.length) {
    const members = plan.map((p) => p.admin);
    const reportsByAdmin = await Offboarding.reportsForMany(members.map((m) => m._id));
    const planned = Offboarding.planExitOrder(members, reportsByAdmin);

    for (const o of planned.orphans) {
      problems.push(
        `${o.admin.name}: has ${o.staying.length} direct report(s) who are NOT on this list - ` +
          `${o.staying.map((r) => r.name).join(", ")}. Reassign them first; an exit must not orphan the chart.`
      );
    }
    if (planned.cycle.length) {
      problems.push(
        `Reporting cycle among ${planned.cycle.map((c) => c.name).join(", ")} - the chart loops back on itself. ` +
          "A human needs to look at that before anyone is exited."
      );
    }
    exitOrder = planned.order;

    // Show what the set looks like, so the reviewer can see nothing is orphaned.
    line("");
    line("Reporting lines within the exit set:");
    for (const m of members) {
      const rs = reportsByAdmin.get(String(m._id)) || [];
      const inSet = new Set(members.map((x) => String(x._id)));
      const shown = rs.map((r) => `${r.name}${inSet.has(String(r._id)) ? " (also leaving)" : " (STAYING)"}`);
      line(`  ${String(m.name).padEnd(22)} reports: ${shown.length ? shown.join(", ") : "none"}`);
    }
  }

  const svcPlan = [];
  for (const needle of SERVICE_ACCOUNTS) {
    const found = nameMatches(needle);
    if (found.length !== 1) { problems.push(`${needle}: expected exactly one match, found ${found.length}`); continue; }
    const a = found[0];
    if (a.meta && a.meta.isServiceAccount) { line(`  already flagged, skipping: ${a.name}`); continue; }
    svcPlan.push(a);
  }

  if (problems.length) {
    line("");
    line("ABORTING - nothing has been written. Resolve these first:");
    for (const p of problems) line(`  - ${p}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  line("");
  line(`Plan: ${exitOrder.length} exit(s), ${svcPlan.length} service-account flag(s)`);
  line("Processed LEAVES-FIRST, so nobody is a manager of an unexited report at any point:");
  exitOrder.forEach((admin, i) => {
    const before = employedOn(admin, EXIT_DAY);
    line(`  ${String(i + 1).padStart(2)}. EXIT  ${String(admin.name).padEnd(22)} <${admin.email}>  status ${admin.status} -> exited, isDisabled -> true`);
    line(`          employed on ${EXIT_DAY} today: ${before.employed} (must stay TRUE after - August still computes)`);
  });
  for (const a of svcPlan) line(`  FLAG  ${String(a.name).padEnd(22)} <${a.email}>  meta.isServiceAccount -> true`);

  if (!CONFIRM) {
    line("");
    line("DRY RUN - nothing was written.");
    line("Re-run with --confirm on the EC2 box to apply.");
    await mongoose.disconnect();
    return;
  }

  line("");
  line("Applying...");
  // In this order, each recordExit passes its OWN orphan guard unchanged: by the
  // time a manager is reached, their reports are already marked exited and no
  // longer count. The per-person guard is not weakened anywhere.
  for (const admin of exitOrder) {
    const out = await Offboarding.recordExit(
      { adminId: admin._id, exitedAt: EXIT_DAY, reason: "Left Wedsy" },
      null
    );
    line(`  ${admin.name}: exited ${EXIT_DAY} - employed on the last day: ${out.employedOnLastDay}, day after: ${out.employedDayAfter}`);
  }
  for (const a of svcPlan) {
    await Offboarding.markServiceAccount(a._id, null);
    line(`  ${a.name}: flagged as a service account`);
  }

  // -- fresh count, so the run reports its own result ------------------------
  const after = await Admin.find({}, { name: 1, status: 1, isDisabled: 1, meta: 1 }).lean();
  const exited = after.filter((a) => a.status === "exited");
  const svc = after.filter((a) => a.meta && a.meta.isServiceAccount);
  const activePeople = after.filter((a) => a.status === "active" && !(a.meta && a.meta.isServiceAccount));
  line("");
  line("After:");
  line(`  exited: ${exited.length}   service accounts: ${svc.length}   active people: ${activePeople.length}`);
  line(`  still able to log in among the exited: ${exited.filter((a) => !a.isDisabled).length} (should be 0)`);
  line("");
  line("Done. Re-run without --confirm to verify nothing is left to do.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e && e.message);
  process.exit(1);
});
