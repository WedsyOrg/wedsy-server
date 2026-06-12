/**
 * controllers/venueTemplate.js
 *
 * CRUD for per-venue WhatsApp message templates (venueOwnerAuth + ownership).
 *   GET    /venues/:slug/templates
 *   POST   /venues/:slug/templates
 *   PATCH  /venues/:slug/templates/:templateId
 *   DELETE /venues/:slug/templates/:templateId
 */
const Venue = require("../models/Venue");
const VenueMessageTemplate = require("../models/VenueMessageTemplate");

async function resolveOwnedVenue(req, res) {
  const { slug } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

const listTemplates = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const templates = await VenueMessageTemplate.find({ venue: venue._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ templates, total: templates.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const createTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { name, body } = req.body || {};
    if (!name || !String(name).trim() || !body || !String(body).trim()) {
      return res.status(400).json({ message: "name and body are required" });
    }
    const template = await VenueMessageTemplate.create({
      venue: venue._id,
      name: String(name).trim(),
      body: String(body).trim(),
      createdBy: req.venueOwner.venueOwnerId,
    });
    return res.status(201).json({ template });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { templateId } = req.params;
    const template = await VenueMessageTemplate.findOne({ _id: templateId, venue: venue._id });
    if (!template) return res.status(404).json({ message: "Template not found" });
    const { name, body } = req.body || {};
    if (name !== undefined && String(name).trim()) template.name = String(name).trim();
    if (body !== undefined && String(body).trim()) template.body = String(body).trim();
    await template.save();
    return res.status(200).json({ template });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { templateId } = req.params;
    const deleted = await VenueMessageTemplate.findOneAndDelete({ _id: templateId, venue: venue._id });
    if (!deleted) return res.status(404).json({ message: "Template not found" });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listTemplates, createTemplate, updateTemplate, deleteTemplate };
