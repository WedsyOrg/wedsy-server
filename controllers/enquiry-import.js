const LeadImportService = require("../services/LeadImportService");

const fileFromRequest = (req) => {
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  return file && file.data ? file.data : null;
};

// POST /enquiry/import/preview (multipart: file)
const Preview = async (req, res) => {
  try {
    const buffer = fileFromRequest(req);
    if (!buffer) {
      return res.status(400).json({ message: "Attach a CSV file as multipart field 'file'" });
    }
    const result = await LeadImportService.preview(buffer);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error("[import:preview]", error);
    res.status(status).json({ message: status === 500 ? "Something went wrong with this import — please retry." : error.message });
  }
};

// POST /enquiry/import/commit (multipart: file + mapping/stageMapping JSON fields)
const Commit = async (req, res) => {
  try {
    const buffer = fileFromRequest(req);
    if (!buffer) {
      return res.status(400).json({ message: "Attach a CSV file as multipart field 'file'" });
    }
    const parseJson = (v, fallback) => {
      if (v === undefined || v === null || v === "") return fallback;
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return fallback;
      }
    };
    const options = {
      mapping: parseJson(req.body.mapping, {}),
      stageMapping: parseJson(req.body.stageMapping, {}),
      ownerMap: parseJson(req.body.ownerMap, {}),
      skipDuplicates: req.body.skipDuplicates !== "false" && req.body.skipDuplicates !== false,
      assignOnImport: req.body.assignOnImport === "true" || req.body.assignOnImport === true,
    };
    const result = await LeadImportService.commit(buffer, options, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error("[import:commit]", error);
    res.status(status).json({ message: status === 500 ? "Something went wrong with this import — please retry." : error.message });
  }
};

// GET /enquiry/import/sample — downloadable CSV in our standard shape.
const Sample = async (req, res) => {
  try {
    const csv = await LeadImportService.sampleCsv();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=wedsy-import-sample.csv");
    res.status(200).send(csv);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error("[import:sample]", error);
    res.status(status).json({ message: status === 500 ? "Something went wrong with this import — please retry." : error.message });
  }
};

module.exports = { Preview, Commit, Sample };
