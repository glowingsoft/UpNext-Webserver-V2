const mongoose = require("mongoose");

const trafficSchema = new mongoose.Schema({
  profileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    unique: true,
    index: true,
  },

  totalVisits: {
    type: Number,
    default: 0,
  },

  sources: {
    google: { type: Number, default: 0 },
    facebook: { type: Number, default: 0 },
    instagram: { type: Number, default: 0 },
    twitter: { type: Number, default: 0 },
    whatsapp: { type: Number, default: 0 },
    mobile: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
    direct: { type: Number, default: 0 },
  },

  lastSource: String,
  lastIp: String,
  lastVisitedAt: Date,
});

module.exports = mongoose.model("Traffic", trafficSchema);
