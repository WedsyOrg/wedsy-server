/**
 * controllers/venueCheckin.js — D6 per-wedding room workflow on the live
 * standing inventory (Venue.rooms + the VenueRoomNight guard, both untouched).
 * Tablet-friendly single round-trips: one call checks a guest in with the full
 * capture block; one call checks out with checklist + damages and computes the
 * deposit settlement (recorded through the D7 payments-approval engine).
 */
const Venue = require("../models/Venue");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const { bookingInScope } = require("../utils/venueBookingScope");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueBooking = require("../models/VenueBooking");
const VenueTeamMember = require("../models/VenueTeamMember");
const { allocateInvoice } = require("./venueInvoice");
const { isOwnerActor } = require("../utils/venueRbac");
const { ON_CHECK_OUT } = require("../utils/venueHousekeeping");
const { resolvePolicy, nightsBetween } = require("../utils/venueRoomsPolicy");
const { streamSettlementPdf } = require("../utils/venuePdf");
const { optStr } = require("../utils/venueInput");
const { findType, occupancyOf } = require("../utils/venueRoomTypes");

// `roomsPolicy` is in here because billExtraBeds reads the extra-bed rate off
// it. Omitting it does NOT fail loudly: resolvePolicy returns an unconfigured
// venue, the rate is 0, and every check-in silently records "no rate set" while
// the venue has one. Fourth time a missing select field has produced a correct
// guard operating on wrong arguments in this build.
// `roomTypes` joins that list for the SAME reason, and the fifth time is worth
// stating plainly: the extra-bed ceiling lives on the type, so a select that
// omits it leaves capacityForExtraBeds resolving every room to no type, finding
// no ceiling, and permitting every count — a guard that runs, returns "allowed"
// every time, and looks exactly like a guard that works.
async function resolveOwnedVenue(req, res, select = "_id rooms roomTypes invoicePrefix roomsPolicy") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

async function actorDisplayName(req) {
  if (await isOwnerActor(req.venueOwner, req.venueMember)) return "Owner";
  const m = await VenueTeamMember.findById(req.venueOwner.memberId).select("name").lean();
  return (m && m.name) || "team member";
}

function cleanUrl(v, field) {
  if (v === undefined || v === null || v === "") return { ok: true, value: "" };
  if (typeof v !== "string" || v.length > 2000) return { ok: false, message: `${field} must be a string (max 2000 chars)` };
  return { ok: true, value: v.trim() };
}

/**
 * ══ HOW MANY EXTRA BEDS THIS ROOM CAN TAKE ══════════════════════════════════
 *
 * ROOMS 6 shipped extra-bed billing that fires at check-in and charges per bed
 * per night. Nothing anywhere stated how many a room could hold, so the only
 * limit was `extraBeds > 20` — a range check on the input, not a fact about the
 * room. A clerk could bill four rollaways into a room that fits one, and the
 * money went out through additional billing with nothing to catch it.
 *
 * `extraBedsPossible` on the room's TYPE is the number that guard needs.
 *
 * ── UNSET IS NOT ZERO, AND THAT IS THE WHOLE SUBTLETY ──────────────────────
 * A venue that has never answered must not have "no extra beds" invented for
 * it: every existing type would refuse its first rollaway, and a guard that
 * fires on a fact nobody stated is worse than the gap it closes. So this
 * refuses ONLY when the owner has actually said how many fit.
 *
 * Untyped rooms are likewise unguarded — there is no type to carry a ceiling.
 *
 * @returns {{limited:boolean, allowed:number, typeName:string}}
 */
function capacityForExtraBeds(venue, roomId) {
  const room = (venue.rooms || []).find((r) => String(r._id) === String(roomId));
  if (!room) return { limited: false, allowed: 0, typeName: "" };
  const type = findType(venue, room.typeRef);
  if (!type) return { limited: false, allowed: 0, typeName: "" };
  const occ = occupancyOf(type);
  if (!occ.extraStated) return { limited: false, allowed: 0, typeName: type.name || "" };
  return { limited: true, allowed: occ.extra, typeName: type.name || "" };
}

// POST /venues/:slug/allotments/:allotmentId/check-in — rooms_checkin.
// One round-trip: guest inventory, extra beds, ID/photo/e-sign captures
// (upload URLs from the existing /file/upload), deposit held for the stay.
const checkInAllotment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const allotment = await VenueRoomAllotment.findOne({ _id: req.params.allotmentId, venue: venue._id });
    if (!allotment) return res.status(404).json({ message: "Allotment not found" });
    if (!(await bookingInScope(req, venue._id, allotment.booking))) {
      return res.status(404).json({ message: "Allotment not found" });
    }
    if (allotment.status !== "allotted") return res.status(409).json({ message: `Cannot check in from status "${allotment.status}"` });

    const body = req.body || {};
    const guestCount = Number(body.guestCount) || 0;
    const extraBeds = Number(body.extraBeds) || 0;
    if (guestCount < 0 || guestCount > 500) return res.status(400).json({ message: "guestCount out of range" });
    if (extraBeds < 0 || extraBeds > 20) return res.status(400).json({ message: "extraBeds out of range" });

    // ── REFUSED OUT LOUD, BEFORE ANYTHING IS WRITTEN ───────────────────────
    // Ahead of the status change and the billing, so a refused check-in leaves
    // the allotment exactly as it was rather than checked in and unbilled.
    const cap = capacityForExtraBeds(venue, allotment.room);
    if (cap.limited && extraBeds > cap.allowed) {
      const room = (venue.rooms || []).find((r) => String(r._id) === String(allotment.room));
      const roomName = (room && room.name) || "this room";
      return res.status(409).json({
        code: "extra_beds_over_capacity",
        message: cap.allowed === 0
          ? `${roomName} takes no extra beds — ${cap.typeName} is set up with none. Nothing was checked in or billed.`
          : `${roomName} takes ${cap.allowed} extra bed${cap.allowed === 1 ? "" : "s"}, and ${extraBeds} were entered. `
            + `${cap.typeName} is set up for ${cap.allowed}. Nothing was checked in or billed.`,
        allowed: cap.allowed,
        requested: extraBeds,
        typeName: cap.typeName,
      });
    }
    let inventory = [];
    if (body.inventory !== undefined) {
      if (!Array.isArray(body.inventory) || body.inventory.length > 100) return res.status(400).json({ message: "inventory must be an array (max 100)" });
      for (const it of body.inventory) {
        if (typeof (it && it.item) !== "string" || !it.item.trim() || it.item.length > 300) return res.status(400).json({ message: "each inventory row needs an item name (max 300 chars)" });
        const qty = Number(it.qty);
        if (!Number.isFinite(qty) || qty < 0 || qty > 1000) return res.status(400).json({ message: "inventory qty out of range" });
        inventory.push({ item: it.item.trim(), qty });
      }
    }
    const urls = {};
    for (const f of ["idCaptureUrl", "photoUrl", "signatureUrl"]) {
      const v = cleanUrl(body[f], f);
      if (!v.ok) return res.status(400).json({ message: v.message });
      urls[f] = v.value;
    }
    const notesV = optStr(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });
    const depositAmt = Number(body.deposit) || 0;
    if (depositAmt < 0 || depositAmt > 1e8) return res.status(400).json({ message: "deposit out of range" });

    allotment.status = "checked_in";
    allotment.actualCheckInAt = new Date();
    allotment.checkIn = {
      guestCount,
      extraBeds,
      inventory,
      idCaptureUrl: urls.idCaptureUrl,
      photoUrl: urls.photoUrl,
      signatureUrl: urls.signatureUrl,
      notes: notesV.value,
      byName: await actorDisplayName(req),
      at: allotment.actualCheckInAt,
    };
    allotment.deposit = { amount: depositAmt };
    await allotment.save();

    // ── EXTRA BEDS BECOME ADDITIONAL BILLING ────────────────────────────────
    // They happen at CHECK-IN, after the booking was confirmed and its value
    // agreed — which is exactly what additional billing is for. So this uses
    // the path that already exists rather than building a second one, and it
    // reaches the money through summarizeSchedule like every other charge.
    //
    // The agreed value does not move. This goes ON TOP, itemised.
    let bedCharge = null;
    if (extraBeds > 0) {
      bedCharge = await billExtraBeds({ venue, allotment, extraBeds, byName: allotment.checkIn.byName });
    }
    return res.status(200).json({ allotment, ...(bedCharge ? { extraBedCharge: bedCharge } : {}) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

/**
 * Bill the extra beds taken at check-in, as ADDITIONAL BILLING.
 *
 * ── WHY IT CAN RETURN "nothing charged" WITHOUT THAT BEING A FAILURE ────────
 * No rate set means extra beds are free, which is what they are today. The
 * count is still recorded on the allotment either way — an owner who has not
 * priced beds still wants to know how many went into the room. Reported rather
 * than silent, so the front desk can see WHY no charge appeared.
 *
 * Never throws into the check-in. A billing problem must not be the reason a
 * guest cannot be checked in; they are standing at the desk.
 */
async function billExtraBeds({ venue, allotment, extraBeds, byName }) {
  try {
    const policy = resolvePolicy(venue);
    const rate = Number(policy.extraBedRate) || 0;
    const nights = nightsBetween(allotment.checkInAt, allotment.checkOutAt);
    if (rate <= 0) return { charged: false, reason: "no_rate", extraBeds };
    if (nights <= 0) return { charged: false, reason: "no_nights", extraBeds };

    const booking = await VenueBooking.findById(allotment.booking);
    if (!booking) return { charged: false, reason: "no_booking", extraBeds };

    // IDEMPOTENT on the allotment, not on the label — an owner may rename the
    // row, and matching on text would bill the beds twice the moment they did.
    const already = (booking.paymentSchedule || []).find(
      (r) => r.isAdditional && String(r.sourceAllotment || "") === String(allotment._id)
    );
    if (already) return { charged: false, reason: "already_billed", extraBeds, amount: already.amount };

    const amount = Math.round(extraBeds * rate * nights);
    booking.paymentSchedule.push({
      // The room number is in the label because a couple reading a statement
      // six weeks later needs to know WHICH room it was.
      label: `Extra beds — room ${roomNameFor(venue, allotment.room)}`,
      amount,
      percent: null,
      dueDate: new Date(),
      isAdditional: true,
      extraBeds,
      extraBedNights: nights,
      sourceAllotment: allotment._id,
      addedNote: `Taken at check-in${byName ? ` by ${byName}` : ""}`,
      addedByName: byName || "",
    });
    await booking.save();
    return { charged: true, amount, extraBeds, nights, ratePerBedPerNight: rate };
  } catch (e) {
    // The guest is at the desk. The check-in stands; the charge is reported as
    // not made, which an owner can add by hand from the Money tab.
    return { charged: false, reason: "error", message: e.message, extraBeds };
  }
}

/** The room's name, for a label somebody reads weeks later. */
function roomNameFor(venue, roomId) {
  const r = (venue.rooms || []).find((x) => String(x._id) === String(roomId));
  return (r && r.name) || "—";
}

// POST /venues/:slug/allotments/:allotmentId/check-out — rooms_checkin.
// One round-trip: checklist + damages + notes. Frees nights after today
// (early departures return inventory, same rule as the PATCH action), then
// settles the deposit: damages are deducted, any deduction is booked as an
// add-on invoice + a D7 payment entry (owner-recorded auto-approves; a front
// desk member's deduction pends for owner approval).
const checkOutAllotment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const allotment = await VenueRoomAllotment.findOne({ _id: req.params.allotmentId, venue: venue._id });
    if (!allotment) return res.status(404).json({ message: "Allotment not found" });
    if (!(await bookingInScope(req, venue._id, allotment.booking))) {
      return res.status(404).json({ message: "Allotment not found" });
    }
    if (allotment.status !== "checked_in") return res.status(409).json({ message: `Cannot check out from status "${allotment.status}"` });

    const body = req.body || {};
    let checklist = [];
    if (body.checklist !== undefined) {
      if (!Array.isArray(body.checklist) || body.checklist.length > 100) return res.status(400).json({ message: "checklist must be an array (max 100)" });
      for (const c of body.checklist) {
        if (typeof (c && c.item) !== "string" || !c.item.trim() || c.item.length > 300) return res.status(400).json({ message: "each checklist row needs an item (max 300 chars)" });
        checklist.push({ item: c.item.trim(), ok: c.ok !== false });
      }
    }
    let damages = [];
    if (body.damages !== undefined) {
      if (!Array.isArray(body.damages) || body.damages.length > 100) return res.status(400).json({ message: "damages must be an array (max 100)" });
      for (const d of body.damages) {
        if (typeof (d && d.desc) !== "string" || !d.desc.trim() || d.desc.length > 500) return res.status(400).json({ message: "each damage needs a description (max 500 chars)" });
        const charge = Number(d.charge);
        if (!Number.isFinite(charge) || charge < 0 || charge > 1e8) return res.status(400).json({ message: "damage charge out of range" });
        damages.push({ desc: d.desc.trim(), charge: Math.round(charge) });
      }
    }
    const notesV = optStr(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });

    const now = new Date();
    allotment.status = "checked_out";
    allotment.actualCheckOutAt = now;
    // Early departure frees nights strictly after the actual check-out day
    // (identical rule to the legacy PATCH check_out action).
    const dayAfter = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86400000);
    await VenueRoomNight.deleteMany({ allotment: allotment._id, night: { $gte: dayAfter } });

    allotment.checkOut = { checklist, damages, notes: notesV.value, byName: await actorDisplayName(req), at: now };

    // ── THE ROOM IS NOW DIRTY ───────────────────────────────────────────────
    // The one automatic housekeeping transition, and the reason the status
    // exists: a guest has left, so nobody should sell this room until it has
    // been serviced. NOT derived from the checklist — that is free text, and a
    // room with every item ticked still needs making up.
    //
    // Overwrites "inspected" deliberately: an inspection from before this stay
    // says nothing about the room now.
    //
    // Best effort. A housekeeping flag must never be the reason a check-out
    // fails — the guest is already leaving, and the deposit settlement below
    // is the part that matters.
    try {
      const stayVenue = await Venue.findById(venue._id).select("rooms");
      const stayRoom = stayVenue && stayVenue.rooms.id(allotment.room);
      if (stayRoom) {
        stayRoom.housekeeping = { status: ON_CHECK_OUT, at: now, byName: allotment.checkOut.byName };
        await stayVenue.save();
      }
    } catch (e) { /* the check-out stands regardless */ }

    // ── Deposit settlement ──
    const deposit = (allotment.deposit && allotment.deposit.amount) || 0;
    const damagesTotal = damages.reduce((s, d) => s + d.charge, 0);
    const deducted = Math.min(deposit, damagesTotal);
    const settlement = {
      deposit,
      damagesTotal,
      deducted,
      refundDue: deposit - deducted,
      payableDue: damagesTotal - deducted,
      settledAt: now,
    };

    if (damagesTotal > 0) {
      // Damage charges become a real add-on invoice; the deposit deduction is
      // recorded against it as a D7 payment entry.
      const invoice = await allocateInvoice(venue, {
        booking: allotment.booking,
        kind: "addon",
        lineItems: damages.map((d) => ({ label: `Damage: ${d.desc}`, category: "other", qty: 1, unitPrice: d.charge })),
        gstPercent: 0,
        gstMode: "none",
        discount: 0,
        totals: { subtotal: damagesTotal, taxable: damagesTotal, gst: 0, grandTotal: damagesTotal },
        terms: [],
        status: "unpaid",
        payments: [],
      });
      if (deducted > 0) {
        const ownerActor = await isOwnerActor(req.venueOwner, req.venueMember);
        const byName = await actorDisplayName(req);
        invoice.payments.push({
          amount: deducted,
          mode: "cash",
          note: `Deposit settlement for room stay (${allotment.guestName || "guest"})`,
          date: now,
          recordedByType: ownerActor ? "owner" : "member",
          recordedById: req.venueOwner.memberId || req.venueOwner.venueOwnerId || undefined,
          recordedByName: ownerActor ? "Owner" : byName,
          collectedBy: "Deposit settlement",
          status: ownerActor ? "approved" : "pending_approval",
          ownerEntry: ownerActor,
          approvedByName: ownerActor ? "Owner" : "",
          approvedAt: ownerActor ? now : undefined,
        });
        const received = invoice.payments.reduce((s, p) => ((p.status || "approved") === "approved" ? s + p.amount : s), 0);
        invoice.status = received <= 0 ? "unpaid" : received >= invoice.totals.grandTotal ? "paid" : "partially_paid";
        await invoice.save();
      }
      settlement.invoiceRef = invoice._id;
    }

    allotment.settlement = settlement;
    await allotment.save();
    return res.status(200).json({ allotment, settlement });
  } catch (err) { return res.status(err.statusCode || 500).json({ message: err.message }); }
};

// GET /venues/:slug/allotments/:allotmentId/settlement-slip — printable PDF.
const settlementSlip = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id name address formattedAddress contact phone email logo rooms");
    if (!venue) return;
    const allotment = await VenueRoomAllotment.findOne({ _id: req.params.allotmentId, venue: venue._id }).lean();
    if (!allotment) return res.status(404).json({ message: "Allotment not found" });
    if (!(await bookingInScope(req, venue._id, allotment.booking))) {
      return res.status(404).json({ message: "Allotment not found" });
    }
    if (allotment.status !== "checked_out") return res.status(409).json({ message: "Settlement slip is available after check-out" });
    const room = (venue.rooms || []).find((r) => String(r._id) === String(allotment.room));
    const booking = await VenueBooking.findById(allotment.booking).select("coupleName").lean();
    await streamSettlementPdf(res, { venue, allotment, roomName: room ? room.name : "Room", booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/allotments/:allotmentId/archive — checked-out stays only.
// Pushes the immutable summary onto the booking's roomsHistory; rooms live on.
const archiveAllotment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const allotment = await VenueRoomAllotment.findOne({ _id: req.params.allotmentId, venue: venue._id });
    if (!allotment) return res.status(404).json({ message: "Allotment not found" });
    if (!(await bookingInScope(req, venue._id, allotment.booking))) {
      return res.status(404).json({ message: "Allotment not found" });
    }
    if (allotment.status !== "checked_out") return res.status(409).json({ message: "Only completed stays can be archived" });
    if (allotment.archived) return res.status(409).json({ message: "Already archived" });

    const room = (venue.rooms || []).find((r) => String(r._id) === String(allotment.room));
    allotment.archived = true;
    allotment.archivedAt = new Date();
    await allotment.save();
    await VenueBooking.updateOne(
      { _id: allotment.booking, venue: venue._id },
      {
        $push: {
          roomsHistory: {
            allotment: allotment._id,
            roomName: room ? room.name : "Room",
            guestName: allotment.guestName,
            checkInAt: allotment.actualCheckInAt || allotment.checkInAt,
            checkOutAt: allotment.actualCheckOutAt || allotment.checkOutAt,
            guestCount: (allotment.checkIn && allotment.checkIn.guestCount) || 0,
            extraBeds: (allotment.checkIn && allotment.checkIn.extraBeds) || 0,
            damagesTotal: (allotment.settlement && allotment.settlement.damagesTotal) || 0,
            deducted: (allotment.settlement && allotment.settlement.deducted) || 0,
            refundDue: (allotment.settlement && allotment.settlement.refundDue) || 0,
            archivedAt: allotment.archivedAt,
          },
        },
      }
    );
    return res.status(200).json({ allotment });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { checkInAllotment, checkOutAllotment, settlementSlip, archiveAllotment };
