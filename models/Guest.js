const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const { RSVP_STATUS, SIDE, EVENT_KEY } = require("../utils/coupleEnums");

// COUPLE APP § 06.1 — ONE GUEST on the couple's list, and the only place a
// guest number lives. The Guests tab, Budget catering, the website RSVP tally
// and the Payments estimate all read the headcount derived from these rows
// (§ 06.3); nothing keeps its own copy.
//
// weddingId is an Event._id. A couple's wedding IS the Event document the CRM,
// the admin event tool and the vendor apps already read — see
// docs/couple-app-api.md for why there is no parallel Wedding collection.
const GuestSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },
    first: { type: String, required: true, trim: true, maxlength: 100 },
    last: { type: String, default: "", trim: true, maxlength: 100 },
    side: { type: String, enum: SIDE, required: true },
    group: { type: String, default: "", trim: true, maxlength: 80 }, // Family / Friends / Work / …
    phone: { type: String, default: "", trim: true, maxlength: 30 },

    // THE MATCH KEY for the website RSVP (§ 06.3). The couple types
    // "+91 98450 11223" and the guest's phone posts "+919845011223" — the same
    // person, two strings. This field is the normalised form of `phone`
    // (utils/phone.normalisePhone: digits WITH a country code, no "+"), written
    // by the service on every create and every phone edit, so the match is an
    // indexed equality test and never a scan-and-compare.
    phoneNormalised: { type: String, default: "", index: true },

    // How many people this invitation covers, the guest included. The headcount
    // is Σ party where rsvp ≠ "no" — so 1, never 0, for a real invitation.
    party: { type: Number, default: 1, min: 0 },

    // Which functions they are invited to (§ 06.3 "Events": defined once on the
    // Event, consumed here). Keys, not ids, so a day reordered on the Event
    // does not silently re-invite anybody.
    events: { type: [{ type: String, enum: EVENT_KEY }], default: [] },

    rsvp: { type: String, enum: RSVP_STATUS, default: "pending" },
    note: { type: String, default: "", maxlength: 2000 },

    // Where the row came from. "website" rows were created by a stranger
    // posting the public RSVP form, so the couple can tell them apart from the
    // names they typed themselves.
    source: { type: String, enum: ["couple", "website", "import"], default: "couple" },
    repliedAt: { type: Date, default: null },

    // Who added them — a partner (User) or a shared family member.
    createdBy: { type: ObjectId, ref: "User", default: null },
    createdByMember: { type: ObjectId, ref: "SharedMember", default: null },
  },
  { timestamps: true }
);

// The list read, and the filters on it (?side&rsvp&event&q all narrow within
// one wedding).
GuestSchema.index({ weddingId: 1, createdAt: 1 });
GuestSchema.index({ weddingId: 1, rsvp: 1 });
// The RSVP match: one wedding's guest with this number, or none.
GuestSchema.index({ weddingId: 1, phoneNormalised: 1 });

module.exports = mongoose.models.Guest || mongoose.model("Guest", GuestSchema);
