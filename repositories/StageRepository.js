const Stage = require("../models/Stage");
const findAll = async () => Stage.find({ deletedAt: null }).sort({ order: 1 }).lean();
const findBySlug = async (slug) => Stage.findOne({ slug, deletedAt: null }).lean();
const countAll = async () => Stage.countDocuments({ deletedAt: null });
module.exports = { findAll, findBySlug, countAll };
