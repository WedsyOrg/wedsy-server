const StepDefinitionService = require("../services/StepDefinitionService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[stepDefinition]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// GET /step-definition — list (any admin; the lead page + instantiation read it).
const GetAll = async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    res.status(200).json({ phases: StepDefinitionService.PHASES, list: await StepDefinitionService.list({ includeArchived }) });
  } catch (error) {
    respond(res, error);
  }
};

// POST /step-definition — create a step (settings:edit:all).
const Create = async (req, res) => {
  try {
    res.status(201).json(await StepDefinitionService.create(req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

// PUT /step-definition/:id — rename / toggle / re-phase.
const Update = async (req, res) => {
  try {
    res.status(200).json(await StepDefinitionService.update(req.params.id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

// DELETE /step-definition/:id — archive (soft).
const Delete = async (req, res) => {
  try {
    res.status(200).json(await StepDefinitionService.archive(req.params.id));
  } catch (error) {
    respond(res, error);
  }
};

// PUT /step-definition/reorder — { orderedIds: [...] }.
const Reorder = async (req, res) => {
  try {
    res.status(200).json({ list: await StepDefinitionService.reorder((req.body || {}).orderedIds) });
  } catch (error) {
    respond(res, error);
  }
};

// POST /step-definition/seed — idempotent 3-phase Wedsy seed.
const Seed = async (req, res) => {
  try {
    res.status(200).json(await StepDefinitionService.seed());
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { GetAll, Create, Update, Delete, Reorder, Seed };
