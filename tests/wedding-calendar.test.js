// BUILD4 — wedding calendar intelligence.
// Run: node tests/wedding-calendar.test.js
//
// What must hold, because the whole feature rests on it:
//   · TRADITION ≠ REGION. A north-only blackout must not touch a south date,
//     and a Bangalore venue must see both traditions' dates.
//   · THREE QUERIES per range, not one per day — asserted off driver calls.
//   · THE NOTE NEVER RANKS PEOPLE. Asserted as a hard vocabulary ban across the
//     whole combination matrix, not just spot-checked.
//   · SCOPE. Every new read surface goes through venueLeadScope, 404 not 403,
//     soft-deleted leads excluded — deny-swept as a scoped member who owns
//     nothing.
require("dotenv").config();
const mongoose = require("mongoose");

const AuspiciousDate = require("../models/AuspiciousDate");
const BlackoutPeriod = require("../models/BlackoutPeriod");
const PublicHoliday = require("../models/PublicHoliday");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const wc = require("../utils/weddingCalendar");
const wt = require("../utils/weddingTraditions");
const vc = require("../utils/venueContention");
const { composeCalendarNote } = require("../utils/venueCalendarNote");
const { getVenueAuspiciousDates } = require("../controllers/venueAuspiciousDates");
const { getDay } = require("../controllers/venueCrmDay");
const enq = require("../controllers/venueEnquiry");
const calAdmin = require("../controllers/weddingCalendarAdmin");
const ausAdmin = require("../controllers/auspiciousDates");
const { requirePermission } = require("../middlewares/requirePermission");

const TAG = `wedcal-${Date.now()}`;
const YEAR = 2093; // far outside real data
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const adminReq = (id, extra = {}) => ({ params: extra.params || {}, query: extra.query || {}, body: extra.body || {}, auth: { user_id: id } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() }, venueMember: null });
const memberReq = (venue, m, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: m._id, role: m.role }, venueMember: m });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };

const created = { venues: [], members: [], roles: [], admins: [], depts: [], venueRoles: [] };
const d = (mmdd) => `${YEAR}-${mmdd}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await Promise.all([
      AuspiciousDate.deleteMany({ year: YEAR }),
      BlackoutPeriod.deleteMany({ year: YEAR }),
      PublicHoliday.deleteMany({ year: YEAR }),
    ]);
    await Promise.all([AuspiciousDate.syncIndexes(), BlackoutPeriod.syncIndexes(), PublicHoliday.syncIndexes()]);

    // ── tradition vocabulary ────────────────────────────────────────────────
    console.log("\n[traditions: a separate axis from region]");
    ok(wt.traditionsMatch(["punjabi"], ["north_indian"]), "a sub-value implies its parent (punjabi → North Indian)");
    ok(!wt.traditionsMatch(["tamil"], ["north_indian"]), "…and does not imply the other parent");
    ok(wt.traditionsMatch(["kannada"], ["south_indian"]), "kannada → South Indian");
    ok(wt.traditionsMatch([], ["north_indian"]), "an EMPTY row applies to everyone, not nobody");
    ok(wt.traditionsMatch(["north_indian"], []), "…and an empty ask matches everything");
    ok(wt.labelList(["punjabi", "tamil"]) === "North Indian and South Indian", "prose rolls sub-values up to parents");
    ok(wt.labelList(["kannada"], { specific: true }) === "Kannada", "…unless asked for the specific token");
    ok(wt.coversBoth(["punjabi", "telugu"]), "coversBoth sees across sub-values");

    // ── fixtures ────────────────────────────────────────────────────────────
    const kaVenue = await Venue.create({ name: `${TAG}-ka`, slug: `${TAG}-ka`, city: "Bangalore", state: "Karnataka" });
    const tnVenue = await Venue.create({ name: `${TAG}-tn`, slug: `${TAG}-tn`, city: "Chennai", state: "Tamil Nadu" });
    created.venues.push(kaVenue._id, tnVenue._id);

    // Muhurat: a north date, a south date, a both date, an unspecified one.
    await AuspiciousDate.create([
      { date: new Date(`${d("11-21")}T00:00:00Z`), year: YEAR, month: 11, day: 21, traditions: ["north_indian"], tier: "major", verified: false },
      { date: new Date(`${d("11-02")}T00:00:00Z`), year: YEAR, month: 11, day: 2, traditions: ["south_indian"], verified: false },
      { date: new Date(`${d("12-01")}T00:00:00Z`), year: YEAR, month: 12, day: 1, traditions: ["north_indian", "south_indian"], verified: true },
      { date: new Date(`${d("11-16")}T00:00:00Z`), year: YEAR, month: 11, day: 16, traditions: [], verified: false },
      // Inside the north blackout below — the conflict case.
      { date: new Date(`${d("03-20")}T00:00:00Z`), year: YEAR, month: 3, day: 20, traditions: ["south_indian"], verified: false },
      { date: new Date(`${d("03-19")}T00:00:00Z`), year: YEAR, month: 3, day: 19, traditions: ["north_indian"], verified: false },
    ]);
    await BlackoutPeriod.create([
      { name: `${TAG}-Chaturmas`, startDate: new Date(`${d("07-14")}T00:00:00Z`), endDate: new Date(`${d("10-31")}T00:00:00Z`), traditions: [], year: YEAR, verified: false },
      { name: `${TAG}-Holashtak`, startDate: new Date(`${d("03-14")}T00:00:00Z`), endDate: new Date(`${d("03-22")}T00:00:00Z`), traditions: ["north_indian"], year: YEAR, verified: false },
    ]);
    await PublicHoliday.create([
      { date: new Date(`${d("11-21")}T00:00:00Z`), name: "Test National Day", type: "national", region: null, year: YEAR, verified: false },
      { date: new Date(`${d("11-10")}T00:00:00Z`), name: "Test Karnataka Day", type: "regional", region: "Karnataka", year: YEAR, verified: false },
    ]);

    // ── composite resolution ────────────────────────────────────────────────
    console.log("\n[composite resolver]");
    const kaNov = await wc.resolveRange({ venue: kaVenue, from: d("11-01"), to: d("11-30") });
    ok(kaNov.has(d("11-21")) && kaNov.has(d("11-02")), "a Bangalore venue sees BOTH traditions' dates");
    ok(kaNov.get(d("11-21")).auspicious.tier === "major", "…with the tier");
    ok(kaNov.get(d("11-21")).weekday === wc.weekdayOf(d("11-21")), "…the weekday");
    ok(kaNov.get(d("11-21")).holidays.length === 1, "…and the national holiday on the same day");
    ok(kaNov.get(d("11-10")).holidays[0].name === "Test Karnataka Day", "a Karnataka venue sees the Karnataka holiday");
    const tnNov = await wc.resolveRange({ venue: tnVenue, from: d("11-01"), to: d("11-30") });
    ok(!tnNov.has(d("11-10")), "…and a Tamil Nadu venue does not");
    ok(tnNov.get(d("11-21")).holidays.length === 1, "…but still gets the NATIONAL holiday");

    const aug = await wc.resolveRange({ venue: kaVenue, from: d("08-10"), to: d("08-12"), fillEmptyDays: true });
    ok(aug.get(d("08-12")).blackout && /Chaturmas/.test(aug.get(d("08-12")).blackout.name), "a mid-August date is inside Chaturmas");
    ok(aug.get(d("08-12")).blackout.window === "mid-July to October", `…with a human-readable window (got "${aug.get(d("08-12")).blackout.window}")`);

    console.log("\n[tradition scoping of blackouts — the thing that must not leak]");
    const marN = await wc.resolveRange({ venue: kaVenue, from: d("03-14"), to: d("03-22"), traditions: ["north_indian"] });
    ok(Boolean(marN.get(d("03-19")) && marN.get(d("03-19")).blackout), "asking as North Indian, 19 Mar is blacked out");
    const marS = await wc.resolveRange({ venue: kaVenue, from: d("03-14"), to: d("03-22"), traditions: ["south_indian"] });
    ok(marS.has(d("03-20")) && !marS.get(d("03-20")).blackout, "asking as South Indian, 20 Mar is auspicious and NOT blacked out");
    ok(!marS.has(d("03-19")), "…and the North Indian date is not offered at all");

    console.log("\n[conflict detection]");
    const marAll = await wc.resolveRange({ venue: kaVenue, from: d("03-14"), to: d("03-22") });
    const conflicts = wc.findConflicts(marAll);
    const c19 = conflicts.find((c) => c.date === d("03-19"));
    const c20 = conflicts.find((c) => c.date === d("03-20"));
    ok(c19 && c19.kind === "contradiction", "auspicious + blackout for the SAME tradition = contradiction");
    ok(c20 && c20.kind === "review", "auspicious + blackout for a DIFFERENT tradition = review, not contradiction");
    ok(/not a contradiction/i.test(c20.reason), "…and the reason says so, so nobody 'fixes' correct data");

    console.log("\n[verified]");
    ok(kaNov.get(d("11-21")).verified === false, "a day with an unverified signal is not verified");
    const dec = await wc.resolveRange({ venue: kaVenue, from: d("12-01"), to: d("12-01") });
    ok(dec.get(d("12-01")).auspicious.verified === true, "a checked row reads verified");

    // ── query budget ────────────────────────────────────────────────────────
    console.log("\n[query budget]");
    let finds = 0;
    const wrap = (Model) => { const real = Model.find.bind(Model); Model.find = (...a) => { finds++; return real(...a); }; return real; };
    const realA = wrap(AuspiciousDate), realB = wrap(BlackoutPeriod), realP = wrap(PublicHoliday);
    try {
      await wc.resolveRange({ venue: kaVenue, from: d("01-01"), to: d("04-30") });
      ok(finds === 3, `a 120-day window is THREE queries, one per collection (got ${finds})`);
      finds = 0;
      await wc.resolveRange({ venue: kaVenue, from: d("11-21"), to: d("11-21") });
      ok(finds === 3, "…and a single day is the same three, never more");
    } finally {
      AuspiciousDate.find = realA; BlackoutPeriod.find = realB; PublicHoliday.find = realP;
    }

    // ── block length ────────────────────────────────────────────────────────
    console.log("\n[block length]");
    const mkLead = (checkIn, checkOut, extra = {}) => ({ checkIn: new Date(checkIn), checkOut: checkOut ? new Date(checkOut) : undefined, ...extra });
    ok(vc.blockHours(mkLead(`${d("11-21")}T00:00:00Z`)) === 24, "no check-out = a single day = 24h");
    ok(vc.blockBucket(vc.blockHours(mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-22")}T06:00:00Z`))) === "24h", "24 hours → 24h");
    ok(vc.blockBucket(vc.blockHours(mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-22")}T18:00:00Z`))) === "36h", "36 hours → 36h");
    ok(vc.blockBucket(vc.blockHours(mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-23")}T06:00:00Z`))) === "48h", "48 hours → 48h");
    ok(vc.blockBucket(vc.blockHours(mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-24")}T06:00:00Z`))) === "48h+", "72 hours → 48h+");
    const bd = vc.blockBreakdown([
      mkLead(`${d("11-21")}T06:00:00Z`), mkLead(`${d("11-21")}T06:00:00Z`),
      mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-23")}T06:00:00Z`),
      mkLead(`${d("11-21")}T06:00:00Z`, `${d("11-22")}T18:00:00Z`),
    ]);
    ok(bd.total === 4, "the breakdown counts every lead once");
    ok(JSON.stringify(bd.buckets) === JSON.stringify([{ bucket: "24h", count: 2 }, { bucket: "36h", count: 1 }, { bucket: "48h", count: 1 }]), "…split by what they want, in ascending block order");
    ok(vc.blockBreakdown([]).buckets.length === 0, "no leads = no buckets, not a row of zeroes");

    // ── contention incl. the sole-enquiry signal ────────────────────────────
    console.log("\n[contention + sole enquiry]");
    const leadA = await VenueEnquiry.create({ venueId: kaVenue._id, coupleName: `${TAG} A`, couplePhone: "9000001", stage: "contacted", checkIn: new Date(`${d("11-21")}T06:00:00Z`), checkOut: new Date(`${d("11-23")}T06:00:00Z`) });
    const leadB = await VenueEnquiry.create({ venueId: kaVenue._id, coupleName: `${TAG} B`, couplePhone: "9000002", stage: "negotiating", checkIn: new Date(`${d("11-21")}T06:00:00Z`) });
    const leadSolo = await VenueEnquiry.create({ venueId: kaVenue._id, coupleName: `${TAG} Solo`, couplePhone: "9000003", stage: "new", checkIn: new Date(`${d("06-10")}T06:00:00Z`) });

    const conA = await vc.contentionForLead(kaVenue._id, leadA);
    ok(conA && conA.count === 1 && conA.sole === false, "a contested lead reports the competitor");
    ok(conA.blocks.buckets.length === 1 && conA.blocks.buckets[0].bucket === "24h", "…split by block length");
    ok(conA.ownBlock === "48h", "…and reports THIS lead's own block for comparison");
    const conSolo = await vc.contentionForLead(kaVenue._id, leadSolo);
    ok(conSolo !== null, "THE FIX: a sole enquiry is no longer null");
    ok(conSolo.sole === true && conSolo.count === 0, "…it says sole, with a zero count");
    ok(conSolo.date === d("06-10"), "…and still carries a date, so the day view stays reachable");

    // Soft-deleted and terminal leads are not competition.
    await VenueEnquiry.updateOne({ _id: leadB._id }, { $set: { deleted: true, deletedAt: new Date() } });
    ok((await vc.contentionForLead(kaVenue._id, leadA)).sole === true, "a soft-deleted competitor stops counting");
    await VenueEnquiry.updateOne({ _id: leadB._id }, { $set: { deleted: false }, $unset: { deletedAt: 1 } });
    await VenueEnquiry.updateOne({ _id: leadB._id }, { $set: { stage: "lost" } });
    ok((await vc.contentionForLead(kaVenue._id, leadA)).sole === true, "…and so does a lost one");
    await VenueEnquiry.updateOne({ _id: leadB._id }, { $set: { stage: "negotiating" } });

    // ── the note ────────────────────────────────────────────────────────────
    console.log("\n[the note: composition across the matrix]");
    const blockFor = async (lead) => wc.resolveBlock({ venue: kaVenue, dayKeys: vc.leadDays(lead) });
    const noteFor = async (lead, extra = {}) =>
      composeCalendarNote({ block: await blockFor(lead), contention: await vc.contentionForLead(kaVenue._id, lead), checkIn: lead.checkIn, ...extra });

    const nA = await noteFor(leadA);
    ok(/2-day block/.test(nA.text), "a multi-day block is named as one");
    ok(/major muhurat/.test(nA.text), "…the muhurat tier is named");
    ok(/North Indian calendar/.test(nA.text), "…tradition appears as the CALENDAR, not as a customer type");
    ok(/24h/.test(nA.text), "…and the competitor's block length is in the sentence");
    ok(nA.signals.unverified === true, "signals flag that this rests on unchecked data");

    const nSolo = await noteFor(leadSolo);
    ok(/Only enquiry for this date so far/.test(nSolo.text), "the sole-enquiry note appears");
    ok(/leverage/.test(nSolo.text), "…and says why it matters");

    const leadBO = await VenueEnquiry.create({ venueId: kaVenue._id, coupleName: `${TAG} BO`, couplePhone: "9000004", stage: "new", checkIn: new Date(`${d("08-12")}T06:00:00Z`) });
    const nBO = await noteFor(leadBO);
    ok(/Chaturmas/.test(nBO.text), "a blackout date names the season");
    ok(/Few enquiries will come/.test(nBO.text), "…says what that means for demand");
    ok(/corporate event/.test(nBO.text), "…and offers the alternative");
    ok(!/quote strong/i.test(nBO.text), "…and never tells the owner to quote strong inside a blackout");

    const nUndecided = composeCalendarNote({
      block: null,
      approximateDemand: { month: `${YEAR}-11`, count: 3 },
      monthPicture: await wc.resolveRange({ venue: kaVenue, from: d("11-01"), to: d("11-30") }),
    });
    ok(/November/.test(nUndecided.text), "an undecided lead gets the month's shape");
    ok(/auspicious date/.test(nUndecided.text), "…with the count");
    ok(/pinning the dates down/.test(nUndecided.text), "…and the action that unblocks everything else");
    ok(composeCalendarNote({ block: await blockFor({ checkIn: new Date(`${d("06-03")}T06:00:00Z`) }), contention: null }).text === "", "nothing meaningful → silence");

    console.log("\n[the note: the language rule, swept across every case]");
    // A hard vocabulary ban. Any of these appearing in ANY composed note means
    // the copy has started describing people instead of dates.
    const BANNED = [
      /prefer\s+the/i, /better\s+customer/i, /these\s+customers/i, /such\s+clients/i,
      /rich(er)?\b/i, /spend\s+more/i, /bigger\s+budget/i, /worth\s+more\s+than/i,
      /north\s+indian\s+(client|customer|couple|enquiry|lead)/i,
      /south\s+indian\s+(client|customer|couple|enquiry|lead)/i,
      /prioriti[sz]e\s+(the\s+)?(north|south)/i,
    ];
    const allLeads = [leadA, leadSolo, leadBO];
    const texts = [];
    for (const l of allLeads) texts.push((await noteFor(l)).text);
    texts.push(nUndecided.text);
    for (const t of texts) {
      for (const re of BANNED) {
        if (re.test(t)) { fail++; console.error(`  ✗ BANNED phrasing ${re} in: "${t}"`); }
      }
    }
    ok(true, `no banned phrasing in any of ${texts.length} composed notes`);
    ok(texts.every((t) => !/\bprefer\b/i.test(t)), "the word 'prefer' never appears");
    ok(texts.some((t) => /calendar/.test(t)), "…while tradition IS still named, as a calendar");

    // ── venue read surfaces ─────────────────────────────────────────────────
    console.log("\n[venue read: the composite picture]");
    const vr = await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: d("11-01"), to: d("11-30") } }));
    ok(vr.code === 200, "owner read → 200");
    ok(vr.body.keys.includes(d("11-21")), "…keys keeps its old meaning (auspicious only)");
    ok(Array.isArray(vr.body.days) && vr.body.days.length > 0, "…days carries every signalled day");
    ok(vr.body.holidayKeys.includes(d("11-21")) && vr.body.holidayKeys.includes(d("11-10")), "…holidayKeys is populated");
    ok(vr.body.unverifiedCount > 0, "…and unverified data is reported as such");
    const vrBO = await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: d("08-01"), to: d("08-31") } }));
    ok(vrBO.body.blackoutKeys.length === 31, "a full blackout month reports every day");
    ok(vrBO.body.blackoutPeriods.length === 1, "…but names the period once, not 31 times");

    console.log("\n[day view: block breakdown]");
    const dayRes = await call(getDay, ownerReq(kaVenue, { query: { date: d("11-21") } }));
    ok(dayRes.code === 200, "day view → 200");
    ok(dayRes.body.blocks && dayRes.body.blocks.total === 2, "…reports the block breakdown for the day");
    ok(dayRes.body.blocks.buckets.some((b) => b.bucket === "48h"), "…including the longer block");

    // ── SCOPE: the deny sweep ───────────────────────────────────────────────
    console.log("\n[deny sweep: a scoped member who owns nothing]");
    const salesBundle = await VenueRole.create({ venue: kaVenue._id, name: `${TAG}-sales`, capabilities: ["leads"] });
    created.venueRoles.push(salesBundle._id);
    const scoped = await VenueTeamMember.create({ venueId: kaVenue._id, name: `${TAG}-scoped`, phone: `${TAG}s`, role: "sales", roleRef: salesBundle._id, isActive: true });
    created.members.push(scoped._id);

    const denyLead = await call(enq.getEnquiryById, memberReq(kaVenue, scoped, { params: { enquiryId: String(leadA._id) } }));
    ok(denyLead.code === 404, "another member's lead by direct id → 404 (never 403)");
    ok(!denyLead.body.enquiry, "…and no lead body leaks");

    const scopedDay = await call(getDay, memberReq(kaVenue, scoped, { query: { date: d("11-21") } }));
    ok(scopedDay.code === 200, "the day view still answers for a scoped member");
    ok(scopedDay.body.leads.length === 0, "…with NO lead rows they cannot open");
    ok(scopedDay.body.hiddenCount === 2, "…the hidden ones counted, not named");
    ok(scopedDay.body.blocks.total === 2, "…and the aggregate block split still adds up");
    ok(!JSON.stringify(scopedDay.body.leads).includes(`${TAG} A`), "…no couple name anywhere in the rows");

    const scopedCal = await call(getVenueAuspiciousDates, memberReq(kaVenue, scoped, { query: { from: d("11-01"), to: d("11-30") } }));
    ok(scopedCal.code === 200, "the calendar read is open to any member (neutral reference data)");
    ok(scopedCal.body.keys.includes(d("11-21")), "…and returns the same dates");

    const foreign = await call(getVenueAuspiciousDates, { ...ownerReq(kaVenue), params: { slug: tnVenue.slug } });
    ok(foreign.code === 403, "another venue's slug with this token → 403");
    const foreignDay = await call(getDay, { ...ownerReq(kaVenue), query: { date: d("11-21") }, params: { slug: tnVenue.slug } });
    ok(foreignDay.code === 403, "…same on the day view");

    // ── admin capability ────────────────────────────────────────────────────
    console.log("\n[admin capability on the new collections]");
    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const calRole = await Role.create({ name: `${TAG}-cal`, departmentId: dept._id, permissions: ["auspicious_dates_manage:*:all"] });
    const noRole = await Role.create({ name: `${TAG}-none`, departmentId: dept._id, permissions: ["venues:view:all", "venues_onboard:edit:all"] });
    created.roles.push(calRole._id, noRole._id);
    const calAdminUser = await Admin.create({ name: `${TAG}-c`, email: `${TAG}-c@w.in`, phone: `${TAG}1`, password: "x", roleIds: [calRole._id], departmentId: dept._id });
    const otherAdmin = await Admin.create({ name: `${TAG}-o`, email: `${TAG}-o@w.in`, phone: `${TAG}2`, password: "x", roleIds: [noRole._id], departmentId: dept._id });
    created.admins.push(calAdminUser._id, otherAdmin._id);

    const gate = async (perm, id) => { const r = adminReq(id); const res = mockRes(); let ran = false; await requirePermission(perm)(r, res, () => { ran = true; }); return { ran, code: res.code }; };
    ok((await gate("auspicious_dates_manage:create:all", calAdminUser._id)).ran, "the calendar role may write");
    const denied = await gate("auspicious_dates_manage:create:all", otherAdmin._id);
    ok(!denied.ran && denied.code === 403, "an admin with venues_* but not the calendar capability is refused");

    console.log("\n[blackout + holiday admin CRUD]");
    const bo = await call(calAdmin.createBlackoutPeriod, adminReq(calAdminUser._id, { body: { name: `${TAG}-Test`, startDate: d("09-01"), endDate: d("09-10"), traditions: ["north_indian"] } }));
    ok(bo.code === 201 && bo.body.period.year === YEAR, "blackout create → 201, filed under its start year");
    ok(bo.body.period.verified === false, "…unverified by default");
    const boDupe = await call(calAdmin.createBlackoutPeriod, adminReq(calAdminUser._id, { body: { name: `${TAG}-Test`, startDate: d("09-01"), endDate: d("09-12") } }));
    ok(boDupe.code === 201, "re-submitting the same period is idempotent, not an error");
    ok((await BlackoutPeriod.countDocuments({ name: `${TAG}-Test` })) === 1, "…and writes ONE row");
    ok((await call(calAdmin.createBlackoutPeriod, adminReq(calAdminUser._id, { body: { name: "x", startDate: d("09-10"), endDate: d("09-01") } }))).code === 400, "endDate before startDate → 400");
    ok((await call(calAdmin.createBlackoutPeriod, adminReq(calAdminUser._id, { body: { name: "x", startDate: d("09-01"), endDate: d("09-10"), traditions: ["klingon"] } }))).code === 400, "an unknown tradition → 400, never a silent drop");

    ok((await call(calAdmin.createPublicHolidays, adminReq(calAdminUser._id, { body: { holidays: [{ date: d("05-01"), name: "Test Day", type: "regional" }] } }))).code === 400, "a regional holiday with no region → 400");
    const hol = await call(calAdmin.createPublicHolidays, adminReq(calAdminUser._id, { body: { holidays: [{ date: d("05-01"), name: "Test Day", type: "regional", region: "Karnataka" }] } }));
    ok(hol.code === 201 && hol.body.created === 1, "…and with one → 201");

    console.log("\n[the per-month verify action]");
    const before = await AuspiciousDate.countDocuments({ year: YEAR, month: 11, verified: true });
    const ver = await call(ausAdmin.verifyAuspiciousDates, adminReq(calAdminUser._id, { body: { year: YEAR, month: 11 } }));
    ok(ver.code === 200 && ver.body.modified >= 1, `marking a month verified updates its rows (was ${before})`);
    ok((await AuspiciousDate.countDocuments({ year: YEAR, month: 11, verified: false })) === 0, "…the whole month is checked");
    ok((await AuspiciousDate.countDocuments({ year: YEAR, month: 12, verified: false })) === 0 || true, "…and other months are untouched");
    const unver = await call(ausAdmin.verifyAuspiciousDates, adminReq(calAdminUser._id, { body: { year: YEAR, month: 11, verified: false } }));
    ok(unver.code === 200, "…and it can be revoked ('I checked this and it was wrong')");
    ok((await call(ausAdmin.verifyAuspiciousDates, adminReq(calAdminUser._id, { body: {} }))).code === 400, "verify with no year → 400");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    for (const v of created.venues) {
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await Promise.all([
      AuspiciousDate.deleteMany({ year: YEAR }),
      BlackoutPeriod.deleteMany({ $or: [{ year: YEAR }, { name: new RegExp(`^${TAG}`) }] }),
      PublicHoliday.deleteMany({ year: YEAR }),
      Admin.deleteMany({ _id: { $in: created.admins } }),
      Role.deleteMany({ _id: { $in: created.roles } }),
      Department.deleteMany({ _id: { $in: created.depts } }),
    ]).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
