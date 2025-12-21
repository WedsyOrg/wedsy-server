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
    // User is optional because reviews can come from a public share-link (non-logged-in customer).
    user: { type: ObjectId, required: false, ref: "User", default: null },
    // For non-logged-in customers we store minimal contact info.
    customer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    // Replies (typically from vendor/admin)
    replies: {
      type: [
        {
          message: { type: String, required: true, default: "" },
          by: {
            id: { type: ObjectId, required: true },
            role: {
              type: String,
              enum: ["user", "vendor", "admin"],
              required: true,
            },
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
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
