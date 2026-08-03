const EventMandatoryQuestion = require("../models/EventMandatoryQuestion");

// Bug 62/63 — whitelist the structured config block (see the model). Junk is
// coerced/dropped, never 500s. Returns undefined when no config was sent.
const cleanConfig = (raw) => {
  if (!raw || typeof raw !== "object") return undefined;
  const type = ["note", "options"].includes(raw.type) ? raw.type : null;
  return {
    type,
    noteMaxLen: Math.max(0, parseInt(raw.noteMaxLen, 10) || 0),
    axes: Array.isArray(raw.axes)
      ? raw.axes
          .filter((a) => a && a.name)
          .map((a) => ({
            name: String(a.name),
            options: Array.isArray(a.options) ? a.options.map(String) : [],
          }))
      : [],
    priceMatrix: raw.priceMatrix && typeof raw.priceMatrix === "object" ? raw.priceMatrix : {},
  };
};

// Bug 62/63 — day-one Mandatory Section seed. Idempotent adopt-by-title (the
// dept-seed pattern): creates a missing question; upgrades an existing one
// ONLY while its config.type is still unset — a founder-edited config is
// never overwritten. Runs lazily on the list read, fire-safe.
const SEED = [
  {
    title: "Transportation",
    config: { type: "note", noteMaxLen: 50, axes: [], priceMatrix: {} },
  },
  {
    title: "Generator",
    config: {
      type: "options",
      noteMaxLen: 0,
      axes: [
        { name: "Size", options: ["64Kw", "128Kw"] },
        { name: "Duration", options: ["6hrs", "12hrs"] },
      ],
      priceMatrix: {
        "64Kw": { "6hrs": 8000, "12hrs": 15000 },
        "128Kw": { "6hrs": 15000, "12hrs": 28000 },
      },
    },
  },
];
const ensureMandatorySeed = async () => {
  for (const q of SEED) {
    const existing = await EventMandatoryQuestion.findOne({ title: q.title });
    if (!existing) {
      await EventMandatoryQuestion.create({ ...q, itemRequired: true });
    } else if (!existing.config || !existing.config.type) {
      existing.config = q.config;
      await existing.save();
    }
  }
  // Bug 69 — legacy duplicate cleanup. The old free-text questions ("Is
  // transportation required?", "Generator (6Hrs) - Format - …") render as
  // duplicates next to the seeded configured rows. Once a CONFIGURED question
  // exists for a concept, its UNCONFIGURED look-alikes (title contains the
  // concept word, config.type null/absent) are removed. Conservative:
  // configured rows are never touched; no soft flag exists on this model, so
  // removal is a hard delete. Idempotent — nothing matches on later runs.
  const configured = await EventMandatoryQuestion.find(
    { "config.type": { $in: ["note", "options"] } },
    { title: 1 }
  ).lean();
  for (const concept of ["transport", "generator"]) {
    if (!configured.some((q) => new RegExp(concept, "i").test(q.title))) continue;
    const gone = await EventMandatoryQuestion.deleteMany({
      title: { $regex: concept, $options: "i" },
      $or: [
        { config: { $exists: false } },
        { "config.type": null },
        { "config.type": { $exists: false } },
      ],
    });
    if (gone.deletedCount) {
      console.log(`[mandatory] Bug 69 dedupe: removed ${gone.deletedCount} legacy "${concept}" question(s)`);
    }
  }
};

const CreateNew = (req, res) => {
  const { title, image, description, price, itemRequired, config } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    const cfg = cleanConfig(config);
    new EventMandatoryQuestion({
      title,
      image,
      description,
      price,
      itemRequired,
      ...(cfg !== undefined ? { config: cfg } : {}),
    })
      .save()
      .then((result) => {
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = async (req, res) => {
  try {
    await ensureMandatorySeed();
  } catch (e) {
    console.error("[mandatory] seed failed:", e.message);
  }
  EventMandatoryQuestion.find({})
    .then((result) => {
      res.send(result);
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Get = (req, res) => {
  const { _id } = req.params;
  EventMandatoryQuestion.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send(result);
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { title, image, description, price, itemRequired, config } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    // config is $set ONLY when the body carries one — the legacy settings
    // screen PUTs without it, and must never wipe a founder-edited matrix.
    const cfg = cleanConfig(config);
    EventMandatoryQuestion.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
          image,
          description,
          price,
          itemRequired,
          ...(cfg !== undefined ? { config: cfg } : {}),
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const Delete = (req, res) => {
  const { _id } = req.params;
  EventMandatoryQuestion.findByIdAndDelete({ _id })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

module.exports = { CreateNew, GetAll, Get, Update, Delete };
