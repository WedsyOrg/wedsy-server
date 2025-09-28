const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: "" },
    profilePhoto: { type: String, default: "" },
    address: {
      apartment: { type: String, default: "" },
      street: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      landmark: { type: String, default: "" },
      pinCode: { type: String, default: "" },
    },
    wishlist: {
      decor: { type: [ObjectId], ref: "Decor", required: true, default: [] },
      vendor: { type: [ObjectId], ref: "Vendor", required: true, default: [] },
      decorPackage: {
        type: [ObjectId],
        ref: "DecorPackage",
        required: true,
        default: [],
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
