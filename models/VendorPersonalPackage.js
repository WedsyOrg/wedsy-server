const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VendorPersonalPackageSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, required: true },
    name: { type: String, required: true },
    services: { type: [String], default: [] },
    price: { type: Number, required: true, default: 0 },
    amountToVendor: { type: Number, required: true, default: 0 },
    amountToWedsy: { type: Number, required: true, default: 0 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "VendorPersonalPackage",
  VendorPersonalPackageSchema
);
