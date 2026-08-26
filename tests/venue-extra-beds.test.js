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
async function fixture({ bedRate, nights = 2 } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    rooms: [{ name: "104", isActive: true }],
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
  return { venue, owner, lead, booking, allotment };
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
