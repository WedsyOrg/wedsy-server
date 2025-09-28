const mongoose = require("mongoose");

const AdminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    password: { type: String, required: true },
    roles: { type: [String], required: true, enum: ["owner", "crm"] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Admin", AdminSchema);
