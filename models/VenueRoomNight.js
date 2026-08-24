const mongoose = require("mongoose");

// Phase 5 (PMS) — one doc per (room, occupied night). The UNIQUE compound
// index is the atomic double-booking guard: concurrent allotments for an
// overlapping range race on insertMany here, and exactly one can win — no
// transactions needed on a standalone local Mongo.
const VenueRoomNightSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    room: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Midnight UTC of the occupied night.
    night: { type: Date, required: true },

    // ── WHO THE NIGHT IS FOR ─────────────────────────────────────────────────
    // Set on every row this build writes, held or allotted, so a booking's
    // nights can be found without going through its allotments — which is the
    // whole point, because a HELD night has no allotment to go through.
    //
    // Optional only for rows written before this existed; those are always
    // allotted, so their booking is still reachable via `allotment`. Readers
    // that need the owner should use roomNightOwnerFilter() rather than
    // assuming this field is present.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking" },

    // ── HELD vs ALLOTTED ─────────────────────────────────────────────────────
    // NULL means HELD: the booking has reserved this room for this night, but
    // no guest has been named yet. Non-null means a guest is in it.
    //
    // This was `required: true`, which is exactly what made the reservation gap
    // possible — a night could not exist until somebody had picked a guest for
    // it, so a booking that needed twenty rooms reserved none of them.
    //
    // Allotting later SETS this field on the row that is already here. The row
    // is never deleted and re-inserted, so there is no instant — not even one
    // between two awaits — in which the night is free for somebody else to
    // take. That is what makes a held night swappable without releasing the
    // guarantee.
    allotment: { type: mongoose.Schema.Types.ObjectId, ref: "VenueRoomAllotment", default: null },
  },
  { timestamps: true }
);

// THE GUARANTEE, UNCHANGED. A held row occupies a REAL room id, so any other
// claim on that room-night — held or allotted — collides here regardless of
// which kind it is.
//
// This is why "held" is not a synthetic slot id. A row like {room: SLOT_1,
// night} does NOT share an index key with {room: <real room>, night}, so a
// named-room allotment would sail straight past twenty slot rows and the
// guarantee would be application-enforced rather than structural. Holding real
// rooms is what makes the collision impossible to defeat.
VenueRoomNightSchema.index({ room: 1, night: 1 }, { unique: true });
VenueRoomNightSchema.index({ allotment: 1 });
// Release-on-cancel and the swap both look rows up by owner.
VenueRoomNightSchema.index({ booking: 1, night: 1 });

module.exports = mongoose.models.VenueRoomNight || mongoose.model("VenueRoomNight", VenueRoomNightSchema);
