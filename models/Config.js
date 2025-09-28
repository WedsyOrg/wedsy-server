const mongoose = require("mongoose");

const ConfigSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
    },
    data: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Config: MUA-Taxation
// data: {bidding:{sgst,cgst}, personalPackage:{sgst,csgt}, wedsyPackage:{sgst,cgst}}

// Config: MUA-BookingAmount
// data: {bidding:{bookingAmount[Percentage/Condition],percentage,condition:[{condition<lt,eq,gt>,value,bookingAmount,amount,percentage}]}, personalPackage:{percentage}, wedsyPackage:{percentage}}

module.exports = mongoose.model("Config", ConfigSchema);
