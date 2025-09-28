const mongoose = require("mongoose");

const EventCommunitySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EventCommunity", EventCommunitySchema);
