const Decor = require("../models/Decor");
const PricingVariation = require("../models/PricingVariation");

async function ExecutePricingVariation(_id) {
  let variation = await PricingVariation.findById(_id);
  if (!variation) return;
  let {
    variationType,
    pricingType,
    percentage,
    amount,
    decorItems,
    categories,
  } = variation;
  try {
    if (pricingType === "SellingPrice") {
      pricingType = "sellingPrice";
    } else if (pricingType === "CostPrice") {
      pricingType = "costPrice";
    }
    const query = {
      $or: [{ _id: { $in: decorItems } }, { category: { $in: categories } }],
    };
    const decors = await Decor.find(query);
    for (const decor of decors) {
      let updated = false;
      decor.productTypes = decor.productTypes.map((pt) => {
        if (
          pt[pricingType] !== undefined &&
          typeof pt[pricingType] === "number"
        ) {
          let newValue = pt[pricingType];
          if (amount !== null && amount !== undefined) {
            newValue =
              variationType === "Increase"
                ? newValue + amount
                : newValue - amount;
          }
          if (percentage !== null && percentage !== undefined) {
            newValue =
              variationType === "Increase"
                ? newValue * (1 + percentage / 100)
                : newValue * (1 - percentage / 100);
          }
          if (newValue < 0) {
            return pt;
          }
          pt[pricingType] = Math.round(newValue);
          updated = true;
        }
        return pt;
      });
      if (updated) {
        await decor.save();
      }
    }
  } catch (error) {
    console.log(error);
  } finally {
    variation.status = "Completed";
    await variation.save();
    return;
  }
}

async function RevertPricingVariation(_id) {
  let variation = await PricingVariation.findById(_id);
  if (!variation) return;
  if (variation.status !== "Completed") return;
  variation.status = "Pending";
  await variation.save();
  let {
    variationType,
    pricingType,
    percentage,
    amount,
    decorItems,
    categories,
  } = variation;
  try {
    if (pricingType === "SellingPrice") {
      pricingType = "sellingPrice";
    } else if (pricingType === "CostPrice") {
      pricingType = "costPrice";
    }
    const query = {
      $or: [{ _id: { $in: decorItems } }, { category: { $in: categories } }],
    };
    const decors = await Decor.find(query);
    for (const decor of decors) {
      let updated = false;
      decor.productTypes = decor.productTypes.map((pt) => {
        if (
          pt[pricingType] !== undefined &&
          typeof pt[pricingType] === "number"
        ) {
          let newValue = pt[pricingType];
          if (amount !== null && amount !== undefined) {
            newValue =
              variationType === "Increase"
                ? newValue - amount
                : newValue + amount;
          }
          if (percentage !== null && percentage !== undefined) {
            newValue =
              variationType === "Increase"
                ? newValue / (1 + percentage / 100)
                : newValue / (1 - percentage / 100);
          }
          if (newValue < 0) {
            return pt;
          }
          pt[pricingType] = Math.round(newValue);
          updated = true;
        }
        return pt;
      });
      if (updated) {
        await decor.save();
      }
    }
  } catch (error) {
    console.log(error);
  } finally {
    variation.status = "Reverted";
    await variation.save();
    return;
  }
}

function CreateNew(req, res) {
  const {
    title,
    variationType,
    pricingType,
    percentage,
    amount,
    decorItems,
    categories,
  } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new PricingVariation({
      title,
      variationType,
      pricingType,
      percentage,
      amount,
      decorItems,
      categories,
    })
      .save()
      .then((result) => {
        ExecutePricingVariation(result?._id);
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
}

const GetAll = (req, res) => {
  PricingVariation.find({})
    .populate("decorItems", "name productInfo.id")
    .exec()
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
  PricingVariation.findById({ _id })
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

const Revert = (req, res) => {
  const { _id } = req.params;
  PricingVariation.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
        RevertPricingVariation(_id);
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

module.exports = { CreateNew, GetAll, Get, Revert };
