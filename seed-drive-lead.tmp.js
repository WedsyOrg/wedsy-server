require("dotenv").config();
const m = require("mongoose");
const Venue = require("./models/Venue");
const VenueEnquiry = require("./models/VenueEnquiry");
(async () => {
  await m.connect("mongodb://127.0.0.1:27017/rm5_drive");
  const v = await Venue.findOne({ slug: "rm5-drive" });
  v.roomsPolicy = { configured: true, includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000 };
  if (!v.spaces || !v.spaces.length) v.spaces = [{ name: "Lawn", isBookable: true }];
  await v.save();
  await VenueEnquiry.deleteMany({ venueId: v._id, coupleName: "Priya & Arjun" });
  const lead = await VenueEnquiry.create({
    venueId: v._id, coupleName: "Priya & Arjun", coupleNameManual: true,
    couplePhone: "9800005555", stage: "negotiating",
    checkIn: new Date("2035-09-30T10:00:00Z"), checkOut: new Date("2035-10-02T10:00:00Z"),
    datesFinalised: true, requirements: { roomsNeeded: 20 },
    estimatedValue: 500000, functions: [],
  });
  console.log(JSON.stringify({ leadId: String(lead._id), spaceId: String(v.spaces[0]._id) }));
  await m.disconnect();
})();
