const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const CommunitySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    author: {
      anonymous: { type: Boolean, default: false },
      id: { type: ObjectId, required: true },
      role: {
        type: String,
        enum: ["", "user", "vendor", "admin"],
        default: "",
      },
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

module.exports = mongoose.model("Community", CommunitySchema);
