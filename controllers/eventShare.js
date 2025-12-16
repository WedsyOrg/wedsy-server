const crypto = require("crypto");
const Event = require("../models/Event");
const EventShare = require("../models/EventShare");

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function buildShareLink(eventId, token) {
  // Keep consistent with existing admin copy/share links
  return `https://wedsy.in/event/${eventId}/view?share=${token}`;
}

const ListShares = (req, res) => {
  const { _id } = req.params;
  // Default behavior: only return active shares so "Remove" immediately disappears from UI.
  // (We keep records with active=false for auditing/history.)
  EventShare.find({ event: _id, active: true })
    .sort({ createdAt: -1 })
    .lean()
    .then((list) => res.send({ list }))
    .catch((error) => res.status(400).send({ message: "error", error }));
};

const CreateShare = async (req, res) => {
  const { _id } = req.params;
  const { user_id, isAdmin } = req.auth;
  const { name = "", phone = "", email = "", relationship = "" } = req.body || {};

  const event = await Event.findById(_id).lean();
  if (!event) return res.status(404).send({ message: "Event not found" });

  const token = generateToken();
  const tokenHash = sha256(token);

  try {
    const doc = await new EventShare({
      event: _id,
      name,
      phone,
      email,
      relationship,
      tokenHash,
      active: true,
      createdBy: user_id || null,
      createdByModel: isAdmin ? "Admin" : "User",
    }).save();

    res.status(201).send({
      message: "success",
      share: {
        _id: doc._id,
        event: doc.event,
        name: doc.name,
        phone: doc.phone,
        email: doc.email,
        relationship: doc.relationship,
        active: doc.active,
        createdAt: doc.createdAt,
      },
      shareLink: buildShareLink(_id, token),
    });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const UpdateShare = async (req, res) => {
  const { _id, shareId } = req.params;
  const { name, phone, email, relationship, active } = req.body || {};

  const update = {};
  if (typeof name === "string") update.name = name;
  if (typeof phone === "string") update.phone = phone;
  if (typeof email === "string") update.email = email;
  if (typeof relationship === "string") update.relationship = relationship;
  if (typeof active === "boolean") update.active = active;

  if (Object.keys(update).length === 0) {
    return res.status(400).send({ message: "No valid fields to update" });
  }

  EventShare.findOneAndUpdate({ _id: shareId, event: _id }, { $set: update }, { new: true })
    .lean()
    .then((doc) => {
      if (!doc) return res.status(404).send({ message: "Share not found" });
      res.send({ message: "success", share: doc });
    })
    .catch((error) => res.status(400).send({ message: "error", error }));
};

const RevokeShare = (req, res) => {
  const { _id, shareId } = req.params;
  EventShare.findOneAndUpdate(
    { _id: shareId, event: _id },
    { $set: { active: false } },
    { new: true }
  )
    .lean()
    .then((doc) => {
      if (!doc) return res.status(404).send({ message: "Share not found" });
      // Return the updated document for easier debugging/confirmation in the UI.
      res.send({ message: "success", share: doc });
    })
    .catch((error) => res.status(400).send({ message: "error", error }));
};

const RotateShareToken = async (req, res) => {
  const { _id, shareId } = req.params;

  const token = generateToken();
  const tokenHash = sha256(token);

  try {
    const doc = await EventShare.findOneAndUpdate(
      { _id: shareId, event: _id },
      { $set: { tokenHash, active: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).send({ message: "Share not found" });
    res.send({ message: "success", shareLink: buildShareLink(_id, token) });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

module.exports = {
  ListShares,
  CreateShare,
  UpdateShare,
  RevokeShare,
  RotateShareToken,
  sha256,
};


