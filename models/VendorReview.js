const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Ratings, User, Date/Time, Text, Multiple Image, Like & Reply
const VendorReviewSchema = new mongoose.Schema(
  {
    review: {
      type: String,
      required: true,
    },
    images: {
      type: [String],
      default: [],
    },
    rating: {
      type: Number,
      required: true,
      default: 0,
    },
    category: {
      type: String,
      required: true,
    },
    vendor: { type: ObjectId, required: true, ref: "Vendor" },
    user: { type: ObjectId, required: true, ref: "User" },
    likes: {
      type: [
        {
          id: { type: ObjectId, required: true },
          role: {
            type: String,
            enum: ["", "user", "vendor", "admin"],
            default: "",
          },
        },
      ],
      default: [],
    },
    dislikes: {
      type: [
        {
          id: { type: ObjectId, required: true },
          role: {
            type: String,
            enum: ["", "user", "vendor", "admin"],
            default: "",
          },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorReview", VendorReviewSchema);
