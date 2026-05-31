const mongoose = require("mongoose");
const StageRepository = require("../repositories/StageRepository");

const VALID_CATEGORIES = ["open", "won", "lost"];

const err = (status, message) =>
  Object.assign(new Error(message), { status });

// Derive a URL-safe slug from a display name. Lowercase, trim, non-alphanumerics → "_",
// collapse repeats, strip leading/trailing underscores.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

const getAllStages = async () => {
  const stages = await StageRepository.findAll();
  return { stages };
};

const createStage = async ({ name, color, category } = {}) => {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw err(400, "name is required");
  }
  const slug = slugify(name);
  if (!slug) throw err(400, "name produces an empty slug");

  const cat = category || "open";
  if (!VALID_CATEGORIES.includes(cat)) {
    throw err(
      400,
      `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`
    );
  }

  const existing = await StageRepository.findBySlug(slug);
  if (existing) throw err(409, "Stage already exists");

  const order = (await StageRepository.maxOrder()) + 1;
  const doc = { name: name.trim(), slug, category: cat, order };
  if (typeof color === "string" && color.length) doc.color = color;
  return await StageRepository.create(doc);
};

// Rename / recolor / reorder a single stage. NEVER changes slug — leads store the slug,
// so renaming is display-only to keep existing leads valid.
const updateStage = async (id, { name, color, category, order } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw err(400, "Invalid stage id");
  const existing = await StageRepository.findById(id);
  if (!existing) throw err(404, "Stage not found");

  const fields = {};
  if (typeof name === "string" && name.trim().length > 0) {
    fields.name = name.trim();
  }
  if (typeof color === "string" && color.length > 0) {
    fields.color = color;
  }
  if (typeof category === "string") {
    if (!VALID_CATEGORIES.includes(category)) {
      throw err(
        400,
        `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`
      );
    }
    fields.category = category;
  }
  if (typeof order === "number" && Number.isFinite(order)) {
    fields.order = order;
  }

  if (Object.keys(fields).length === 0) return existing;
  return await StageRepository.updateById(id, fields);
};

// Bulk reorder. Sets each stage's order to its index in the provided id array.
const reorderStages = async (orderedIds) => {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw err(400, "orderedIds must be a non-empty array");
  }
  for (const id of orderedIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw err(400, `Invalid stage id in orderedIds: ${id}`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await StageRepository.updateById(orderedIds[i], { order: i });
  }
  const stages = await StageRepository.findAll();
  return { stages };
};

const deleteStage = async (id, moveToSlug) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw err(400, "Invalid stage id");
  const existing = await StageRepository.findById(id);
  if (!existing) throw err(404, "Stage not found");
  if (existing.isSystem === true) {
    throw err(400, "Cannot delete a system stage");
  }
  const total = await StageRepository.countAll();
  if (total <= 1) throw err(400, "Cannot delete the only stage");

  if (typeof moveToSlug !== "string" || moveToSlug.length === 0) {
    throw err(400, "moveTo is required to delete a stage");
  }
  if (moveToSlug === existing.slug) {
    throw err(400, "moveTo must be a different stage");
  }
  const target = await StageRepository.findBySlug(moveToSlug);
  if (!target) throw err(400, `moveTo slug not found: ${moveToSlug}`);

  const movedLeads = await StageRepository.reassignLeads(
    existing.slug,
    moveToSlug
  );
  await StageRepository.softDeleteById(id);

  return { deleted: String(id), movedLeads, movedTo: moveToSlug };
};

module.exports = {
  getAllStages,
  createStage,
  updateStage,
  reorderStages,
  deleteStage,
};
