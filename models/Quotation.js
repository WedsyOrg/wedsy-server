const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const QuotationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    location: { type: String, required: true },
    comment: { type: String, required: true },
    image: { type: String, required: true },
    source: { type: String, required: true, default: "Default" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Quotation", QuotationSchema);
