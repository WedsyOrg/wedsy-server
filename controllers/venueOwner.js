const jwt = require("jsonwebtoken");
const axios = require("axios");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueTeamActivity = require("../models/VenueTeamActivity");
const Venue = require("../models/Venue");
const VenueClaimRequest = require("../models/VenueClaimRequest");
const NotificationFailureLog = require("../models/NotificationFailureLog");
const { SendOTP, VerifyOTP } = require("../utils/otp");
const enrichVenue = require("../utils/enrichVenue");

// Helper — mask phone number: 9876543210 → 98•••••210
const maskPhone = (phone) => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5) return "••••••••••";
  const first2 = digits.slice(0, 2);
  const last3 = digits.slice(-3);
  const middle = "•".repeat(digits.length - 5);
  return first2 + middle + last3;
};

// GET /venue-owner/claim-info/:slug — returns masked phone for the venue
const getClaimInfo = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id name phone status").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const alreadyClaimed = await VenueOwner.findOne({ venueId: venue._id, verificationStatus: { $ne: "pending" } }).lean();
    if (alreadyClaimed) return res.status(409).json({ message: "This venue has already been claimed" });

    return res.status(200).json({
      venueName: venue.name,
      venueId: venue._id,
      hasPhone: !!venue.phone,
      maskedPhone: venue.phone ? maskPhone(venue.phone) : null,
      phoneLength: venue.phone ? venue.phone.replace(/\D/g, "").length : 0,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venue-owner/claim — verify phone match then send OTP
const initiateClaim = async (req, res) => {
  try {
    const { slug, phone, name, role } = req.body;
    if (!slug || !phone || !name) {
      return res.status(400).json({ message: "slug, phone, and name are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name phone status").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const alreadyClaimed = await VenueOwner.findOne({ venueId: venue._id, verificationStatus: { $ne: "pending" } }).lean();
    if (alreadyClaimed) return res.status(409).json({ message: "This venue has already been claimed" });

    // Phone match check
    const inputDigits = phone.replace(/\D/g, "");
    const dbDigits = (venue.phone || "").replace(/\D/g, "");

    if (dbDigits && inputDigits !== dbDigits) {
      return res.status(400).json({
        message: "Phone number does not match our records",
        mismatch: true,
      });
    }

    // If no phone on record, skip match check and proceed
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

// POST /venue-owner/claim/verify — verify OTP and create account
const verifyClaim = async (req, res) => {
  try {
    const { slug, phone, name, role, otp, referenceId } = req.body;
    if (!slug || !phone || !name || !otp || !referenceId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name status").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const DEV_OTP = "000000";
    console.log("[DEV] otp:", otp, "NODE_ENV:", process.env.NODE_ENV, "match:", otp === DEV_OTP);
    const result = otp === DEV_OTP && process.env.NODE_ENV !== "production"
      ? { Valid: true }
      : await VerifyOTP(phone, referenceId, otp);
    if (!result.Valid) return res.status(400).json({ message: "Invalid or expired OTP" });

    let venueOwner = await VenueOwner.findOne({ venueId: venue._id });
    if (!venueOwner) {
      venueOwner = new VenueOwner({
        name, phone, role: role || "owner",
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
    await Venue.findByIdAndUpdate(venue._id, { status: "pending_outreach" });

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

// POST /venue-owner/claim/document — AI document verification (Tier 2)
const verifyDocument = async (req, res) => {
  try {
    const { slug, documentBase64, documentType, name, phone, role } = req.body;
    if (!slug || !documentBase64 || !name || !phone) {
      return res.status(400).json({ message: "slug, document, name and phone are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name address").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    // Call Claude to verify document
    let attempt = 0;
    let verified = false;
    let reason = "";

    while (attempt <= 2) {
      try {
        const response = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 500,
            messages: [{
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: documentType || "image/jpeg", data: documentBase64 }
                },
                {
                  type: "text",
                  text: `This is a business document uploaded to claim the venue "${venue.name}" located at "${venue.address}" in Bangalore, India.

Verify if this document belongs to this venue. Check if the venue name or address on the document matches.

Return ONLY this JSON:
{
  "verified": true or false,
  "confidence": "high" or "medium" or "low",
  "reason": "brief explanation",
  "extractedName": "business name found on document",
  "extractedAddress": "address found on document"
}`
                }
              ]
            }]
          },
          {
            headers: {
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json"
            }
          }
        );

        const text = response.data.content[0].text;
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON in response");
        const result = JSON.parse(match[0]);
        verified = result.verified && result.confidence !== "low";
        reason = result.reason;
        break;
      } catch (e) {
        attempt++;
        if (attempt > 2) {
          await NotificationFailureLog.create({
            service: "ClaudeDocVerification",
            params: { slug },
            error: e.message,
            attempts: attempt,
            createdAt: new Date()
          }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (verified) {
      // Create VenueOwner with document verification
      let venueOwner = await VenueOwner.findOne({ venueId: venue._id });
      if (!venueOwner) {
        venueOwner = new VenueOwner({
          name, phone, role: role || "owner",
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
      await Venue.findByIdAndUpdate(venue._id, { status: "pending_outreach" });

      const token = jwt.sign(
        { type: "venue_owner", venueOwnerId: venueOwner._id, venueId: venue._id, role: venueOwner.role },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );

      return res.status(200).json({ success: true, token, venueOwner: { id: venueOwner._id, name, phone, role: role || "owner", venueId: venue._id, venueName: venue.name } });
    } else {
      return res.status(400).json({ success: false, message: "Document could not be verified automatically", reason, fallback: true });
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venue-owner/claim/manual — Tier 4 manual review form, OR self
// sign-up for venues that aren't in the database yet.
//
// Branching:
//   - slug present  → existing-venue manual claim (legacy Tier 4 flow). Venue
//                     must resolve; duplicate pending requests are deduped by
//                     venueId.
//   - slug missing + newVenueName present → self sign-up for a brand-new
//                     venue. No Venue lookup; dedupe by phone+email instead;
//                     tier is "new_venue_signup".
const submitManualClaim = async (req, res) => {
  try {
    const {
      slug,
      name,
      designation,
      phone,
      email,
      howHeard,
      message,
      newVenueName,
      newVenueType,
      newVenueAddress,
    } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).json({ message: "name, phone, and email are required" });
    }

    // --- Self sign-up branch (new venue, not in DB) ---
    if (!slug) {
      if (!newVenueName) {
        return res.status(400).json({ message: "newVenueName is required when slug is not provided" });
      }

      // Dedupe by phone+email so the same owner double-submitting gets a
      // friendly "already under review" rather than a stack of duplicates.
      const existingSelf = await VenueClaimRequest.findOne({
        phone,
        email,
        tier: "new_venue_signup",
        status: "pending_manual_review",
      }).lean();
      if (existingSelf) {
        return res.status(200).json({
          success: true,
          message: "Your request is already under review. We'll reach out within 24 hours.",
        });
      }

      await VenueClaimRequest.create({
        newVenueName,
        newVenueType: newVenueType || "",
        newVenueAddress: newVenueAddress || "",
        name,
        designation: designation || "owner",
        phone,
        email,
        howHeard: howHeard || "",
        message: message || "",
        tier: "new_venue_signup",
        status: "pending_manual_review",
      });

      return res.status(201).json({
        success: true,
        message: "Request submitted. Our team will reach out within 24 hours.",
      });
    }

    // --- Existing-venue manual claim branch (unchanged behavior) ---
    const venue = await Venue.findOne({ slug }).select("_id name").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    // Check for duplicate pending request
    const existing = await VenueClaimRequest.findOne({ venueId: venue._id, status: "pending_manual_review" }).lean();
    if (existing) {
      return res.status(200).json({ success: true, message: "Your request is already under review. We'll reach out within 24 hours." });
    }

    await VenueClaimRequest.create({
      venueId: venue._id,
      venueName: venue.name,
      venueSlug: slug,
      name,
      designation: designation || "owner",
      phone,
      email,
      howHeard: howHeard || "",
      message: message || "",
      tier: "phone_mismatch",
      status: "pending_manual_review",
    });

    return res.status(201).json({
      success: true,
      message: "Request submitted. Our team will reach out within 24 hours.",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venue-owner/auth/send-otp
const sendLoginOTP = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "Phone is required" });
    // Owner account OR an active team member with this phone may log in.
    const venueOwner = await VenueOwner.findOne({ phone }).lean();
    const member = venueOwner ? null : await VenueTeamMember.findOne({ phone, isActive: true }).lean();
    if (!venueOwner && !member) {
      return res.status(404).json({ message: "No venue account found for this phone number" });
    }
    const { ReferenceId } = await SendOTP(phone);
    return res.status(200).json({ success: true, referenceId: ReferenceId });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venue-owner/auth — login
const login = async (req, res) => {
  try {
    const { phone, otp, referenceId } = req.body;
    if (!phone || !otp || !referenceId) return res.status(400).json({ message: "phone, otp, and referenceId are required" });
    const DEV_OTP = "000000";
    const result = otp === DEV_OTP && process.env.NODE_ENV !== "production"
      ? { Valid: true }
      : await VerifyOTP(phone, referenceId, otp);
    if (!result.Valid) return res.status(400).json({ message: "Invalid or expired OTP" });
    const venueOwner = await VenueOwner.findOne({ phone }).populate("venueId", "name slug status");

    // No owner account for this phone → try an active team member (per-member login).
    if (!venueOwner) {
      const member = await VenueTeamMember.findOne({ phone, isActive: true }).populate("venueId", "name slug status");
      if (!member) return res.status(404).json({ message: "No venue account found" });
      member.lastLoginAt = new Date();
      await member.save();
      const memberToken = jwt.sign(
        {
          type: "venue_owner", // same type — owner = member with role "owner"
          venueId: member.venueId._id,
          memberId: member._id,
          ownerId: member.ownerId,
          role: member.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );
      VenueTeamActivity.create({
        venueId: member.venueId._id,
        actorId: String(member._id),
        actorName: member.name,
        action: "member_login",
        targetMemberId: String(member._id),
      }).catch((e) => console.error("Failed to log member login:", e.message));
      return res.status(200).json({
        success: true,
        token: memberToken,
        venueOwner: { id: member._id, name: member.name, phone: member.phone, role: member.role, venue: member.venueId, isMember: true },
      });
    }

    venueOwner.lastLoginAt = new Date();
    await venueOwner.save();
    const token = jwt.sign(
      { type: "venue_owner", venueOwnerId: venueOwner._id, venueId: venueOwner.venueId._id, role: venueOwner.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    // Fire-and-forget Google enrichment so the owner sees fresh photos/zone
    // next time they hit the dashboard. Never block the login response on it.
    setImmediate(() => {
      enrichVenue(venueOwner.venueId._id).catch((err) => {
        console.warn(`[enrichVenue] login enrichment failed for venue ${venueOwner.venueId._id}: ${err.message}`);
      });
    });
    return res.status(200).json({ success: true, token, venueOwner: { id: venueOwner._id, name: venueOwner.name, phone: venueOwner.phone, role: venueOwner.role, venue: venueOwner.venueId } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getClaimInfo, initiateClaim, verifyClaim, verifyDocument, submitManualClaim, sendLoginOTP, login };
