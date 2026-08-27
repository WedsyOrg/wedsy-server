// ROOMS 6 slice 3 — extra beds reach the money as ADDITIONAL BILLING.
//
// They happen at CHECK-IN, after the booking was confirmed and its value
// agreed — which is precisely what additional billing is for. So this uses the
// path that already exists: no second money route, and summarizeSchedule
// remains the single derivation.
//
// Run: node tests/venue-extra-beds.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");
const checkin = require("../controllers/venueCheckin");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { describeAdditionalDetail } = require("../utils/venueRoomsPolicy");
const { buildStatementPdf } = require("../utils/venueStatementPdf");

const TAG = `beds-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r; };
const D = (s) => new Date(`${s}T00:00:00Z`);
const pdfText = (built) => {
  const raw = built.buffer.toString("latin1");
  const runs = [];
  for (const arr of raw.match(/\[(.*?)\]\s*TJ/gs) || []) {
    for (const hex of arr.match(/<([0-9a-fA-F]+)>/g) || []) runs.push(Buffer.from(hex.slice(1, -1), "hex"));
  }
  return Buffer.concat(runs).toString("latin1");
};

let seq = 0;
const made = [];
async function fixture({ bedRate, nights = 2, typeSpec = null } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  // ROOMS 10: the room may belong to a TYPE that states how many extra beds
  // fit. Built through the model the way a real venue holds it, so the guard is
  // handed the shape a real caller produces.
  const typeId = new mongoose.Types.ObjectId();
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    ...(typeSpec
      ? { roomTypes: [{ _id: typeId, name: typeSpec.name || "Quad", ...typeSpec.fields }] }
      : {}),
    rooms: [{ name: "104", isActive: true, ...(typeSpec ? { typeRef: typeId } : {}) }],
    roomsPolicy: bedRate === undefined
      ? { configured: true, includedWithVenue: "all" }
      : { configured: true, includedWithVenue: "all", extraBedRate: bedRate },
  });
  const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}${seq}`.slice(0, 14), isActive: true });
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
    couplePhone: String(9600000000 + seq), stage: "booked",
  });
  const booking = await VenueBooking.create({
    venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 400000,
    days: [{ date: D("2036-09-30"), eventType: "wedding", guestCount: 100 }],
    paymentSchedule: [{ label: "Full", amount: 400000, dueDate: D("2036-09-01") }],
  });
  const allotment = await VenueRoomAllotment.create({
    venue: venue._id, booking: booking._id, room: venue.rooms[0]._id,
    guestName: "Ravi Menon", checkInAt: D("2036-09-30"),
    checkOutAt: new Date(D("2036-09-30").getTime() + nights * 86400000), status: "allotted",
  });
  made.push({ venue, lead, owner });
  return { venue, owner, lead, booking, allotment, typeId };
}
const req = (f, extra = {}) => ({
  params: { slug: f.venue.slug, allotmentId: String(f.allotment._id), ...(extra.params || {}) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: f.venue._id, venueOwnerId: f.owner._id },
  venueMember: null,
});
const checkIn = (f, body) => call(checkin.checkInAllotment, req(f, { body }));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ ROOMS 10: A ROOM CANNOT BE BILLED MORE BEDS THAN IT HOLDS ══════════
    // ROOMS 6 shipped per-bed billing with no ceiling anywhere. The only limit
    // was `extraBeds > 20` — a range check on the input, not a fact about the
    // room — so four rollaways could be billed into a room that fits one, and
    // the money left through additional billing with nothing to catch it.
    console.log("\n[the ceiling: beds 4 + 1 extra = a maximum of 5]");
    {
      // The founder's case, exactly: the beds sleep four, one rollaway fits.
      const f = await fixture({ bedRate: 800, nights: 2, typeSpec: { name: "Standard Quadruple", fields: { bedsSleep: 4, extraBedsPossible: 1 } } });

      // The arithmetic, asserted as literals rather than recomputed.
      const { occupancyOf } = require("../utils/venueRoomTypes");
      const stored = await Venue.findById(f.venue._id).select("roomTypes").lean();
      const occ = occupancyOf(stored.roomTypes[0]);
      eq(occ.base, 4, "🔴 base is what the permanent beds hold");
      eq(occ.extra, 1, "🔴 …one extra bed fits");
      eq(occ.maximum, 5, "🔴 …so the maximum is 5 — DERIVED, never typed");
      ok(stored.roomTypes[0].maxOccupancy === 0 || stored.roomTypes[0].maxOccupancy === undefined,
        "…and no independent total was stored that could contradict those two");

      // One bed is within the ceiling and bills normally.
      const okRes = await checkIn(f, { guestCount: 5, extraBeds: 1 });
      eq(okRes.code, 200, "one extra bed is allowed");
      eq(okRes.body.extraBedCharge.charged, true, "…and billed");
    }

    console.log("\n[a second extra bed on that room is refused, out loud]");
    {
      const f = await fixture({ bedRate: 800, nights: 2, typeSpec: { name: "Standard Quadruple", fields: { bedsSleep: 4, extraBedsPossible: 1 } } });
      const r = await checkIn(f, { guestCount: 6, extraBeds: 2 });
      eq(r.code, 409, "🔴 two extra beds into a room that fits one → 409");
      eq(r.body.code, "extra_beds_over_capacity", "…with a code the screen can act on");
      eq(r.body.allowed, 1, "…naming what the room actually takes");
      eq(r.body.requested, 2, "…and what was asked for");
      ok(/104/.test(r.body.message), `…and which room: "${r.body.message}"`);

      // NOTHING happened — asserted positively on the stored documents.
      const a = await VenueRoomAllotment.findById(f.allotment._id).lean();
      eq(a.status, "allotted", "🔴 the allotment is STILL allotted, not checked in");
      eq(a.checkIn.extraBeds, 0, "…and no bed count was recorded");
      const bk = await VenueBooking.findById(f.booking._id).lean();
      eq(bk.paymentSchedule.filter((x) => x.isAdditional).length, 0,
        "🔴 …and not one rupee of additional billing was raised");
    }

    console.log("\n[a type set up with NO extra beds refuses the first one]");
    {
      const f = await fixture({ bedRate: 800, nights: 2, typeSpec: { name: "Twin", fields: { bedsSleep: 2, extraBedsPossible: 0 } } });
      const r = await checkIn(f, { guestCount: 3, extraBeds: 1 });
      eq(r.code, 409, "an explicit zero is a real answer and is enforced");
      ok(/takes no extra beds/.test(r.body.message), `…worded for a zero: "${r.body.message}"`);
    }

    console.log("\n[but silence is NOT a zero — an unanswered type is not guarded]");
    {
      // Every type in production predates this field. If unset meant zero,
      // every venue would refuse its first rollaway on the day this ships —
      // a guard firing on a fact nobody stated, which is worse than the gap.
      const f = await fixture({ bedRate: 800, nights: 2, typeSpec: { name: "Legacy", fields: { bedsSleep: 4 } } });
      const r = await checkIn(f, { guestCount: 5, extraBeds: 2 });
      eq(r.code, 200, "🔴 a type that never stated a ceiling still checks in");
      eq(r.body.extraBedCharge.charged, true, "…and bills as it always did");
    }

    console.log("\n[a room with no type at all is likewise unguarded]");
    {
      const f = await fixture({ bedRate: 800, nights: 2 });
      const r = await checkIn(f, { guestCount: 4, extraBeds: 3 });
      eq(r.code, 200, "no type means no ceiling to enforce");
    }

    console.log("\n[a legacy maxOccupancy states the ceiling without being migrated]");
    {
      // An owner who typed "sleeps 4, max 5" already said one extra bed fits.
      // Reading that back is not inventing a number — it is the same fact.
      const f = await fixture({ bedRate: 800, nights: 2, typeSpec: { name: "Old Deluxe", fields: { sleeps: 4, maxOccupancy: 5 } } });
      const r = await checkIn(f, { guestCount: 6, extraBeds: 2 });
      eq(r.code, 409, "🔴 the ceiling implied by a legacy pair is enforced");
      eq(r.body.allowed, 1, "…recovered as 5 − 4 = 1, with nothing written back");
      const stored = await Venue.findById(f.venue._id).select("roomTypes").lean();
      ok(stored.roomTypes[0].extraBedsPossible === undefined,
        "…and the stored document was NOT migrated behind the owner's back");
    }

    console.log("\n[the charge]");
    {
      const f = await fixture({ bedRate: 800, nights: 2 });
      const before = summarizeSchedule(await VenueBooking.findById(f.booking._id));
      const r = await checkIn(f, { guestCount: 3, extraBeds: 2 });
      eq(r.code, 200, "check-in succeeds");
      eq(r.body.extraBedCharge.charged, true, "…and the beds were billed");
      eq(r.body.extraBedCharge.amount, 2 * 800 * 2, "…2 beds × Rs.800 × 2 nights");

      const bk = await VenueBooking.findById(f.booking._id).lean();
      const row = bk.paymentSchedule.find((x) => x.isAdditional);
      eq(row.extraBeds, 2, "🔴 the bed COUNT is stored as a number");
      eq(row.extraBedNights, 2, "…and the nights");
      eq(describeAdditionalDetail(row), "2 extra beds × 2 nights",
        "🔴 …and the line SAYS what it is, composed from the counts");
      ok(/room 104/.test(row.label), `…naming which room: "${row.label}"`);

      const after = summarizeSchedule(bk);
      eq(after.totals.bookingValue, before.totals.bookingValue,
        "🔴 the AGREED VALUE did not move — this is additional billing, not a repricing");
      eq(after.totals.additional, 3200, "…it is on top");
      eq(after.totals.total, 403200, "…and the couple owes agreed + additional");
      ok(after.rows.some((x) => x.isAdditional), "…through the schedule, like every other charge");
    }

    console.log("\n[🔴 summarizeSchedule was not taught what a bed is]");
    {
      const src = require("fs").readFileSync(require.resolve("../utils/venuePaymentStatus"), "utf8");
      ok(!/\bbed/i.test(src), "utils/venuePaymentStatus contains no reference to beds — still one derivation");
    }

    console.log("\n[no rate set — recorded, not charged, and it SAYS so]");
    {
      const f = await fixture({ nights: 2 }); // policy configured, no bed rate
      const r = await checkIn(f, { guestCount: 3, extraBeds: 2 });
      eq(r.code, 200, "check-in still succeeds");
      eq(r.body.extraBedCharge.charged, false, "nothing was charged");
      eq(r.body.extraBedCharge.reason, "no_rate", "🔴 …and the reason is reported, not silent");
      const bk = await VenueBooking.findById(f.booking._id).lean();
      eq(bk.paymentSchedule.filter((x) => x.isAdditional).length, 0, "no charge row");
      const a = await VenueRoomAllotment.findById(f.allotment._id).lean();
      eq(a.checkIn.extraBeds, 2, "🔴 …but the COUNT is still recorded — an owner wants to know either way");
    }

    console.log("\n[no beds — nothing happens at all]");
    {
      const f = await fixture({ bedRate: 800 });
      const r = await checkIn(f, { guestCount: 2, extraBeds: 0 });
      eq(r.code, 200, "check-in succeeds");
      eq(r.body.extraBedCharge, undefined, "🔴 no charge object at all — this is the ordinary case");
      const bk = await VenueBooking.findById(f.booking._id).lean();
      eq(bk.paymentSchedule.length, 1, "…and the schedule is untouched");
    }

    console.log("\n[🔴 it cannot bill the same stay twice]");
    {
      const f = await fixture({ bedRate: 800, nights: 2 });
      await checkIn(f, { guestCount: 3, extraBeds: 2 });
      // Force the allotment back so check-in can be replayed — the realistic
      // version is a correction, not a double tap, and either must not double-bill.
      await VenueRoomAllotment.updateOne({ _id: f.allotment._id }, { $set: { status: "allotted" } });
      const second = await checkIn(f, { guestCount: 3, extraBeds: 2 });
      eq(second.code, 200, "the second check-in succeeds");
      eq(second.body.extraBedCharge.charged, false, "…but bills nothing");
      eq(second.body.extraBedCharge.reason, "already_billed", "…because this allotment was already billed");
      const bk = await VenueBooking.findById(f.booking._id).lean();
      eq(bk.paymentSchedule.filter((x) => x.isAdditional).length, 1, "🔴 exactly ONE charge row");
      eq(summarizeSchedule(bk).totals.additional, 3200, "🔴 …and the couple owes it once");

      // The guard reads the ALLOTMENT, not the label — an owner may rename it.
      await VenueBooking.updateOne(
        { _id: f.booking._id, "paymentSchedule.isAdditional": true },
        { $set: { "paymentSchedule.$.label": "Renamed by the owner" } }
      );
      await VenueRoomAllotment.updateOne({ _id: f.allotment._id }, { $set: { status: "allotted" } });
      const third = await checkIn(f, { guestCount: 3, extraBeds: 2 });
      eq(third.body.extraBedCharge.reason, "already_billed",
        "🔴 …and renaming the row does not make it bill again — the guard is on the allotment, not the text");
    }

    console.log("\n[the statement says what it was, six weeks later]");
    {
      const f = await fixture({ bedRate: 800, nights: 2 });
      await checkIn(f, { guestCount: 3, extraBeds: 2 });
      const bk = await VenueBooking.findById(f.booking._id);
      const text = pdfText(await buildStatementPdf({
        venue: await Venue.findById(f.venue._id).lean(),
        booking: bk, summary: summarizeSchedule(bk), invoices: [], lead: f.lead,
      }));
      ok(text.length > 200, `read ${text.length} characters back out of the statement`);
      ok(text.includes("2 extra beds"), "🔴 the statement names the beds");
      ok(text.includes("\xd7"), "…with the multiplication sign intact as WinAnsi");
      ok(text.includes("room 104"), "…and which room");
      ok(text.includes("3,200"), "…and the amount");
    }

    console.log("\n[a billing failure never blocks a check-in — the guest is at the desk]");
    {
      const f = await fixture({ bedRate: 800, nights: 2 });
      const realSave = VenueBooking.prototype.save;
      let thrown = false;
      VenueBooking.prototype.save = function () { thrown = true; throw new Error("injected: booking save failed"); };
      let r;
      try { r = await checkIn(f, { guestCount: 3, extraBeds: 2 }); }
      finally { VenueBooking.prototype.save = realSave; }
      ok(thrown, "a booking-save failure was actually injected — the case is real, not skipped");
      eq(r.code, 200, "🔴 the check-in still succeeded");
      eq(r.body.extraBedCharge.charged, false, "…the charge is reported as not made");
      eq(r.body.extraBedCharge.reason, "error", "…with a reason an owner can act on");
      const a = await VenueRoomAllotment.findById(f.allotment._id).lean();
      eq(a.status, "checked_in", "🔴 …and the guest is checked in, which is the part that could not wait");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      for (const { venue, lead, owner } of made) {
        await VenueRoomNight.deleteMany({ venue: venue._id });
        await VenueRoomAllotment.deleteMany({ venue: venue._id });
        await VenueBooking.deleteMany({ venue: venue._id });
        await VenueEnquiry.deleteMany({ _id: lead._id });
        await VenueOwner.deleteMany({ _id: owner._id });
        await Venue.deleteMany({ _id: venue._id });
      }
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
