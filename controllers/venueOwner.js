const jwt = require("jsonwebtoken");
const VenueOwner = require("../models/VenueOwner");
const Venue = require("../models/Venue");
const { SendOTP, VerifyOTP } = require("../utils/otp");

// Step 1 — Initiate claim: send OTP to phone on record
const initiateClaim = async (req, res) => {
  try {
    const { slug, phone, name, role } = req.body;
    if (!slug || !phone || !name) {
      return res.status(400).json({ message: "slug, phone, and name are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name phone status").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }

    // Check if already claimed
    const existing = await VenueOwner.findOne({ venueId: venue._id }).lean();
    if (existing && existing.verificationStatus !== "pending") {
      return res.status(409).json({ message: "This venue has already been claimed" });
    }

    // Send OTP
    const { ReferenceId } = await SendOTP(phone);

    return res.status(200).json({
      success: true,
      referenceId: ReferenceId,
      venueId: venue._id,
      venueName: venue.name,
      message: "OTP sent to your phone",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Step 2 — Verify OTP and create VenueOwner account
const verifyClaim = async (req, res) => {
  try {
    const { slug, phone, name, role, otp, referenceId } = req.body;
    if (!slug || !phone || !name || !otp || !referenceId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name status").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }

    // Verify OTP
    const result = await VerifyOTP(phone, referenceId, otp);
    if (!result.Valid) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // Create or update VenueOwner
    let venueOwner = await VenueOwner.findOne({ venueId: venue._id });
    if (!venueOwner) {
      venueOwner = new VenueOwner({
        name,
        phone,
        role: role || "owner",
        venueId: venue._id,
        verificationStatus: "phone_verified",
        claimedAt: new Date(),
        lastLoginAt: new Date(),
      });
    } else {
      venueOwner.verificationStatus = "phone_verified";
      venueOwner.claimedAt = new Date();
      venueOwner.lastLoginAt = new Date();
    }
    await venueOwner.save();

    // Update venue status to claimed
    await Venue.findByIdAndUpdate(venue._id, { status: "pending_outreach" });

    // Issue JWT
    const token = jwt.sign(
      { type: "venue_owner", venueOwnerId: venueOwner._id, venueId: venue._id, role: venueOwner.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(200).json({
      success: true,
      token,
      venueOwner: {
        id: venueOwner._id,
        name: venueOwner.name,
        phone: venueOwner.phone,
        role: venueOwner.role,
        venueId: venue._id,
        venueName: venue.name,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Login — for returning venue owners
const login = async (req, res) => {
  try {
    const { phone, otp, referenceId } = req.body;
    if (!phone || !otp || !referenceId) {
      return res.status(400).json({ message: "phone, otp, and referenceId are required" });
    }

    const result = await VerifyOTP(phone, referenceId, otp);
    if (!result.Valid) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const venueOwner = await VenueOwner.findOne({ phone }).populate("venueId", "name slug status");
    if (!venueOwner) {
      return res.status(404).json({ message: "No venue account found for this phone number" });
    }

    venueOwner.lastLoginAt = new Date();
    await venueOwner.save();

    const token = jwt.sign(
      { type: "venue_owner", venueOwnerId: venueOwner._id, venueId: venueOwner.venueId._id, role: venueOwner.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(200).json({
      success: true,
      token,
      venueOwner: {
        id: venueOwner._id,
        name: venueOwner.name,
        phone: venueOwner.phone,
        role: venueOwner.role,
        venue: venueOwner.venueId,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Send OTP for login
const sendLoginOTP = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "Phone is required" });

    const venueOwner = await VenueOwner.findOne({ phone }).lean();
    if (!venueOwner) {
      return res.status(404).json({ message: "No venue account found for this phone number" });
    }

    const { ReferenceId } = await SendOTP(phone);
    return res.status(200).json({ success: true, referenceId: ReferenceId });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { initiateClaim, verifyClaim, login, sendLoginOTP };
