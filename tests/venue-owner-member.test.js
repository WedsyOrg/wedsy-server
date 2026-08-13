// Owner-as-member — the owner's own VenueTeamMember row.
// Run: node tests/venue-owner-member.test.js
//
// The row makes the owner a REAL assignee (leads, tasks, follow-ups) instead of
// the UI pretending "You (owner)" means unassigned. Two things must hold at
// once, and both are asserted here:
//   · the row is a first-class assignee everywhere work is assigned;
//   · the row is NOT a login identity — no email, no password, invisible to
//     every member login lane, and owner login still yields exactly ONE identity.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueTeamActivity = require("../models/VenueTeamActivity");
const VenueRole = require("../models/VenueRole");
const VenueTask = require("../models/VenueTask");
const VenueFollowUp = require("../models/VenueFollowUp");

const team = require("../controllers/venueTeam");
const tasks = require("../controllers/venueTask");
const fu = require("../controllers/venueFollowUp");
const { getCrmOverview } = require("../controllers/venueCrmDashboard");
const { collectIdentities, memberLogin, sendLoginOTP } = require("../controllers/venueOwner");
const { ensureOwnerMember, ensureOwnerMembers, resolveActorMemberId, resolveActorIds } = require("../utils/venueOwnerMember");
const { pickRoundRobinAssignee, resolveCreateAssignment } = require("../utils/venueLeadAssign");
const { scopedLeadFilter } = require("../utils/venueLeadScope");
const T = require("../utils/venueTime");

const TAG = `venue-om-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], members: [], roles: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, owner, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, role: "owner" }, venueMember: null });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

// A venue + its owner account, tracked for teardown.
async function mkVenue(suffix) {
  const venue = await Venue.create({ name: `${TAG}-${suffix}`, slug: `${TAG}-${suffix}` });
  created.venues.push(venue._id);
  const owner = await VenueOwner.create({ name: `${TAG} Owner ${suffix}`, phone: `${TAG}-own-${suffix}`, venueId: venue._id, role: "owner" });
  created.owners.push(owner._id);
  return { venue, owner };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[the row: create, shape, idempotence]");
    const { venue, owner } = await mkVenue("a");
    const mk = async (s, extra = {}) => {
      const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: owner._id, name: `${TAG}-${s}`, phone: `${TAG}-${s}`, role: "sales", isActive: true, ...extra });
      created.members.push(m._id);
      return m;
    };

    const ownerMemberId = await ensureOwnerMember(venue._id, owner._id);
    ok(Boolean(ownerMemberId), "ensureOwnerMember returns a member id");
    const row = await VenueTeamMember.findById(ownerMemberId).select("+passwordHash").populate("roleRef", "isSystem name").lean();
    created.members.push(row._id);
    ok(row.isOwnerAccount === true, "…flagged isOwnerAccount");
    ok(row.isActive === true && row.role === "owner", "…active, legacy role 'owner'");
    ok(row.name === owner.name && row.phone === owner.phone, "…carries the owner's name + phone");
    ok(row.email === "" && !row.passwordHash, "…has NO email and NO passwordHash (not a login identity)");
    ok(Boolean(row.roleRef && row.roleRef.isSystem), "…holds the system Owner bundle");

    const again = await ensureOwnerMember(venue._id, owner._id);
    ok(String(again) === String(ownerMemberId), "ensure is idempotent — same id on a second call");
    ok((await VenueTeamMember.countDocuments({ venueId: venue._id, isOwnerAccount: true })) === 1, "…and never creates a second owner row");

    // Concurrency: parallel ensures must converge on one row, not race into a
    // duplicate-key crash or two rows.
    const { venue: vRace, owner: oRace } = await mkVenue("race");
    const raced = await Promise.all([1, 2, 3].map(() => ensureOwnerMember(vRace._id, oRace._id)));
    ok(raced.every((id) => id && String(id) === String(raced[0])), "3 concurrent ensures resolve to ONE id");
    ok((await VenueTeamMember.countDocuments({ venueId: vRace._id, isOwnerAccount: true })) === 1, "…and exactly one owner row exists");

    // Owner renamed → the roster follows.
    await VenueOwner.updateOne({ _id: owner._id }, { $set: { name: `${TAG} Renamed` } });
    await ensureOwnerMember(venue._id, owner._id);
    ok((await VenueTeamMember.findById(ownerMemberId).lean()).name === `${TAG} Renamed`, "a renamed owner is reflected on the row");
    await VenueOwner.updateOne({ _id: owner._id }, { $set: { name: owner.name } });
    await ensureOwnerMember(venue._id, owner._id);

    // A deactivated owner gets no row.
    const { venue: vOff, owner: oOff } = await mkVenue("off");
    await VenueOwner.updateOne({ _id: oOff._id }, { $set: { isActive: false } });
    ok((await ensureOwnerMember(vOff._id, oOff._id)) === null, "a deactivated owner gets no member row");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[E11000 hazard: an owner who already invited themselves is ADOPTED]");
    const { venue: vAdopt, owner: oAdopt } = await mkVenue("adopt");
    const selfInvited = await VenueTeamMember.create({
      venueId: vAdopt._id,
      ownerId: oAdopt._id,
      name: "Self Invited",
      phone: oAdopt.phone, // the collision: unique {venueId, phone}
      email: `${TAG}-self@example.com`,
      role: "sales",
      passwordHash: await bcrypt.hash("selfinvitedpass", 10),
      isActive: true,
    });
    created.members.push(selfInvited._id);
    // Work already pointing at that row must survive the conversion.
    const carriedLead = await VenueEnquiry.create({ venueId: vAdopt._id, coupleName: `${TAG} Carried`, couplePhone: "9000900", stage: "contacted", assignedTo: selfInvited._id });

    const adoptedId = await ensureOwnerMember(vAdopt._id, oAdopt._id);
    ok(String(adoptedId) === String(selfInvited._id), "the existing row is ADOPTED in place — same _id, no duplicate");
    ok((await VenueTeamMember.countDocuments({ venueId: vAdopt._id })) === 1, "…still exactly one member row at that venue");
    const adopted = await VenueTeamMember.findById(adoptedId).select("+passwordHash").populate("roleRef", "isSystem").lean();
    ok(adopted.isOwnerAccount === true && adopted.role === "owner", "…flagged isOwnerAccount and upgraded to the owner role");
    ok(Boolean(adopted.roleRef && adopted.roleRef.isSystem), "…upgraded to the system Owner bundle");
    ok(adopted.email === "" && !adopted.passwordHash, "…its member login credentials are retired");
    ok(String((await VenueEnquiry.findById(carriedLead._id).lean()).assignedTo) === String(adoptedId), "…and the lead already assigned to it still points at it");

    // The retired credentials really are dead.
    const deadLogin = await call(memberLogin, { body: { email: `${TAG}-self@example.com`, password: "selfinvitedpass" } });
    ok(deadLogin.code === 401, "the adopted row's old email+password no longer logs in");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[not a login identity]");
    const idsForOwnerPhone = await collectIdentities(owner.phone);
    ok(idsForOwnerPhone.length === 1, "owner login yields exactly ONE identity (no owner-vs-self prompt)");
    ok(idsForOwnerPhone[0].kind === "owner", "…and it is the OWNER identity, not the member row");

    // A real teammate is unaffected by any of this.
    const realMember = await mk("teammate", { phone: `${TAG}-mate`, email: `${TAG}-mate@example.com`, passwordHash: await bcrypt.hash("teammatepass", 10) });
    const mateIds = await collectIdentities(`${TAG}-mate`);
    ok(mateIds.length === 1 && mateIds[0].kind === "member", "an ordinary member is still a login identity");

    // send-otp must not answer for a phone whose ONLY row is an owner account.
    const orphanVenue = await Venue.create({ name: `${TAG}-orphan`, slug: `${TAG}-orphan` });
    created.venues.push(orphanVenue._id);
    const orphanRow = await VenueTeamMember.create({ venueId: orphanVenue._id, name: "Orphan Owner Row", phone: `${TAG}-orphan-phone`, role: "owner", isOwnerAccount: true, isActive: true });
    created.members.push(orphanRow._id);
    const otpRes = await call(sendLoginOTP, { body: { phone: `${TAG}-orphan-phone` } });
    ok(otpRes.code === 404, "send-otp does not treat a bare owner-account row as an account");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[team surface: teamCount, assignable roster]");
    const salesA = await mk("A");
    const listed = await call(team.listMembers, ownerReq(venue, owner));
    const listedIds = listed.body.members.map((m) => String(m._id));
    ok(listedIds.includes(String(ownerMemberId)), "the owner row appears in the team list");
    ok(listed.body.total === listed.body.members.length, "total counts every row returned");
    ok(listed.body.teamCount === listed.body.total - 1, "teamCount excludes the owner row");
    ok(listed.body.members.find((m) => String(m._id) === String(ownerMemberId)).isOwnerAccount === true, "…flagged so the UI can label it");

    const assignable = await call(team.listAssignableMembers, ownerReq(venue, owner));
    const ownerOption = assignable.body.members.find((m) => String(m._id) === String(ownerMemberId));
    ok(Boolean(ownerOption), "the owner is offered in the Assign-To roster");
    ok(ownerOption.isOwnerAccount === true, "…flagged isOwnerAccount");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[updateMember self-guard — the memberId comparison is undefined for owner tokens]");
    const deact = await call(team.updateMember, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { isActive: false } }));
    ok(deact.code === 400, "an owner cannot deactivate their own row");
    ok((await VenueTeamMember.findById(ownerMemberId).lean()).isActive === true, "…and it is still active");

    const demote = await call(team.updateMember, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { role: "sales" } }));
    ok(demote.code === 400, "an owner cannot demote their own row");
    const sysRole = await VenueRole.findOne({ venue: venue._id, isSystem: true }).select("_id").lean();
    const salesBundle = await VenueRole.findOne({ venue: venue._id, name: "Sales" }).select("_id").lean();
    if (salesBundle) {
      const rebundle = await call(team.updateMember, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { roleId: String(salesBundle._id) } }));
      ok(rebundle.code === 400, "…nor swap its capability bundle");
      ok(String((await VenueTeamMember.findById(ownerMemberId).lean()).roleRef) === String(sysRole._id), "…the system Owner bundle is intact");
    }
    const setEmail = await call(team.updateMember, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { email: `${TAG}-sneak@example.com` } }));
    ok(setEmail.code === 400, "…nor give it an email (which would make it a login identity)");
    ok((await VenueTeamMember.findById(ownerMemberId).lean()).email === "", "…the row still has no email");

    const rename = await call(team.updateMember, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { name: `${TAG} Owner A` } }));
    ok(rename.code === 200, "renaming the owner row IS allowed");

    const pw = await call(team.setMemberPassword, ownerReq(venue, owner, { params: { memberId: String(ownerMemberId) }, body: { password: "hunter2hunter2" } }));
    ok(pw.code === 400, "the owner row cannot be given a password");

    // A MEMBER with the team capability must not get around the guard either.
    const managerBundle = await VenueRole.findOne({ venue: venue._id, name: "Manager" }).select("_id").lean();
    const manager = await mk("mgr", { role: "manager", ...(managerBundle ? { roleRef: managerBundle._id } : {}) });
    const mgrDeact = await call(team.updateMember, memberReq(venue, manager, { params: { memberId: String(ownerMemberId) }, body: { isActive: false } }));
    ok(mgrDeact.code === 400, "a manager cannot deactivate the owner's row either");

    const reInvite = await call(team.inviteMember, ownerReq(venue, owner, { body: { name: "Owner Again", phone: owner.phone } }));
    ok(reInvite.code === 400 && /owner/i.test(reInvite.body.message), "re-inviting the owner's own number is refused, by name");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[round-robin pools: sales → other active → owner last]");
    const { venue: vRR, owner: oRR } = await mkVenue("rr");
    const rrOwnerId = await ensureOwnerMember(vRR._id, oRR._id);
    created.members.push(rrOwnerId);
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrOwnerId), "owner-only venue: the owner is the last-resort pick (intake never dies)");

    const rrDesk = await VenueTeamMember.create({ venueId: vRR._id, ownerId: oRR._id, name: `${TAG}-desk`, phone: `${TAG}-desk`, role: "marketing", isActive: true });
    created.members.push(rrDesk._id);
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrDesk._id), "any other active member outranks the owner");

    const rrSales = await VenueTeamMember.create({ venueId: vRR._id, ownerId: oRR._id, name: `${TAG}-rrsales`, phone: `${TAG}-rrsales`, role: "sales", isActive: true });
    created.members.push(rrSales._id);
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrSales._id), "an active Sales member outranks both");

    // Load-balancing still ignores the owner: pile leads on Sales and the pick
    // moves to the other MEMBER, never to the owner.
    for (let i = 0; i < 3; i++) {
      await VenueEnquiry.create({ venueId: vRR._id, coupleName: `${TAG}-rr-${i}`, couplePhone: `90011${i}`, stage: "contacted", assignedTo: rrSales._id });
    }
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrSales._id), "a loaded Sales pool still keeps the lead inside Sales");
    await VenueTeamMember.updateOne({ _id: rrSales._id }, { $set: { isActive: false } });
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrDesk._id), "…and with Sales gone it falls to the other member, not the owner");
    await VenueTeamMember.updateOne({ _id: rrDesk._id }, { $set: { isActive: false } });
    ok(String(await pickRoundRobinAssignee(vRR._id)) === String(rrOwnerId), "…and only then to the owner");

    const auto = await resolveCreateAssignment({ venueId: vRR._id, requested: null, creatorMemberId: null, autoAssign: true });
    ok(String(auto.assignedTo) === String(rrOwnerId) && auto.via === "round_robin", "auto-assign on an owner-only venue lands on the owner instead of nowhere");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n['Me' resolution: My tasks shows owner-assigned items]");
    const oReq = () => ownerReq(venue, owner, { query: {} });
    ok(String(await resolveActorMemberId(ownerReq(venue, owner))) === String(ownerMemberId), "an owner token resolves 'me' to the owner's member row");
    ok(String(await resolveActorMemberId(memberReq(venue, salesA))) === String(salesA._id), "a member token resolves 'me' to itself");
    const actorIds = (await resolveActorIds(ownerReq(venue, owner))).map(String);
    ok(actorIds.includes(String(ownerMemberId)) && actorIds.includes(String(owner._id)), "authorship ids for an owner cover BOTH the member row and the legacy venueOwnerId");

    const soon = T.addVenueDays(new Date(), 1);
    const assignedToOwner = await VenueTask.create({ venue: venue._id, title: `${TAG} owner-assigned`, dueAt: soon, assignedTo: ownerMemberId, createdBy: salesA._id, status: "open" });
    const legacyOwnerTask = await VenueTask.create({ venue: venue._id, title: `${TAG} legacy owner-authored`, dueAt: soon, assignedTo: null, createdBy: owner._id, status: "open" });
    const someoneElses = await VenueTask.create({ venue: venue._id, title: `${TAG} not mine`, dueAt: soon, assignedTo: salesA._id, createdBy: salesA._id, status: "open" });

    const myTasks = await call(tasks.listTasks, oReq());
    const myTaskIds = myTasks.body.tasks.map((t) => String(t._id));
    ok(myTaskIds.includes(String(assignedToOwner._id)), "'My tasks' shows a task ASSIGNED to the owner");
    ok(myTaskIds.includes(String(legacyOwnerTask._id)), "…and still shows tasks the owner authored before the row existed");
    ok(!myTaskIds.includes(String(someoneElses._id)), "…and not a teammate's task");

    // Creating a task as the owner defaults it to the owner, not to nobody.
    const createdTask = await call(tasks.createTask, ownerReq(venue, owner, { body: { title: `${TAG} owner self-task`, dueAt: soon.toISOString() } }));
    ok(createdTask.code === 201, "an owner can create a task");
    ok(String(createdTask.body.task.assignedTo) === String(ownerMemberId), "…and it defaults to the owner instead of unassigned");
    const selfAssign = await call(tasks.createTask, ownerReq(venue, owner, { body: { title: `${TAG} explicit self`, dueAt: soon.toISOString(), assignedTo: String(ownerMemberId) } }));
    ok(selfAssign.code === 201, "an owner assigning a task to themselves is not charged for tasks_assign_others");

    // Follow-ups: assignee=me means the owner's row, not "unassigned".
    const leadForFu = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} FuLead`, couplePhone: "9000300", stage: "contacted", assignedTo: ownerMemberId });
    const unassignedLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Unowned`, couplePhone: "9000400", stage: "contacted", assignedTo: null });
    const mineFu = await VenueFollowUp.create({ venue: venue._id, lead: leadForFu._id, type: "call", dueAt: soon, status: "open", assignedTo: ownerMemberId });
    const nobodysFu = await VenueFollowUp.create({ venue: venue._id, lead: unassignedLead._id, type: "call", dueAt: soon, status: "open", assignedTo: null });

    const meFu = await call(fu.listFollowUps, ownerReq(venue, owner, { query: { assignee: "me" } }));
    const meFuIds = meFu.body.followUps.map((f) => String(f._id));
    ok(meFuIds.includes(String(mineFu._id)), "follow-ups assignee=me returns the owner's own follow-ups");
    ok(!meFuIds.includes(String(nobodysFu._id)), "…and no longer silently means 'unassigned'");
    const unFu = await call(fu.listFollowUps, ownerReq(venue, owner, { query: { assignee: "unassigned" } }));
    ok(unFu.body.followUps.map((f) => String(f._id)).includes(String(nobodysFu._id)), "…which is still reachable under its own name");

    // Dashboard my-day agrees. The card counts only what is due by end of the
    // venue's TODAY, so these two are dated inside it.
    const today = T.venueDayBounds().end;
    await VenueTask.create({ venue: venue._id, title: `${TAG} due-today assigned`, dueAt: today, assignedTo: ownerMemberId, createdBy: salesA._id, status: "open" });
    await VenueTask.create({ venue: venue._id, title: `${TAG} due-today legacy-authored`, dueAt: today, assignedTo: null, createdBy: owner._id, status: "open" });
    await VenueTask.create({ venue: venue._id, title: `${TAG} due-today teammate`, dueAt: today, assignedTo: salesA._id, createdBy: salesA._id, status: "open" });
    const ov = await call(getCrmOverview, ownerReq(venue, owner));
    ok(ov.code === 200 && ov.body.myDay.myTasksOpen === 2, "the dashboard my-day card counts the owner's assigned + authored tasks, and only those");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[scoped visibility is unaffected for owner tokens]");
    const foreign = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Foreign`, couplePhone: "9000500", stage: "contacted", assignedTo: salesA._id });
    const ownerFilter = await scopedLeadFilter({ type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, null, venue._id);
    ok(!("assignedTo" in ownerFilter), "an owner token's lead filter carries NO assignedTo constraint");
    const ownerVisible = await VenueEnquiry.find(ownerFilter).select("_id").lean();
    const visibleIds = ownerVisible.map((l) => String(l._id));
    ok(visibleIds.includes(String(foreign._id)) && visibleIds.includes(String(leadForFu._id)), "…so the owner still sees every lead, theirs and others'");

    const memberFilter = await scopedLeadFilter({ type: "venue_owner", venueId: venue._id, memberId: salesA._id, role: "sales" }, salesA, venue._id);
    ok(String(memberFilter.assignedTo) === String(salesA._id), "a scoped member is still pinned to their own leads");

    const allTasks = await call(tasks.listTasks, ownerReq(venue, owner, { query: { filter: "all" } }));
    ok(allTasks.body.tasks.map((t) => String(t._id)).includes(String(someoneElses._id)), "filter=all still shows the owner every task");

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[ensureOwnerMembers covers every owner of a venue]");
    const secondOwner = await VenueOwner.create({ name: `${TAG} CoOwner`, phone: `${TAG}-co`, venueId: venue._id, role: "owner" });
    created.owners.push(secondOwner._id);
    const allOwnerRows = await ensureOwnerMembers(venue._id);
    ok(allOwnerRows.length === 2, "a venue with two owner accounts gets two owner rows");
    const coRow = await VenueTeamMember.findOne({ venueId: venue._id, ownerId: secondOwner._id, isOwnerAccount: true }).lean();
    ok(Boolean(coRow), "…including the co-owner's");
    if (coRow) created.members.push(coRow._id);
    ok((await collectIdentities(`${TAG}-co`)).length === 1, "…and the co-owner still has exactly one login identity");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueFollowUp.deleteMany({ lead: { $in: leads.map((l) => l._id) } });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTask.deleteMany({ venue: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueTeamActivity.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
    await VenueRole.deleteMany({ _id: { $in: created.roles } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
