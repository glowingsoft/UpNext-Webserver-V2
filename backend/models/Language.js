const mongoose = require("mongoose");

const languageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "language_title_required"], // Custom error message key
    },
    transliteration: {
      type: String,
      default: "",
      trim: true,
      required: [true, "language_transliteration_required"],
    },
    flag: {
      type: String,
      default: "",
    },
    code: {
      type: String,
      required: [true, "language_code_required"], // Custom error message key
      unique: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.createdAt;
        delete ret.updatedAt;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform: function (doc, ret) {
        delete ret.createdAt;
        delete ret.updatedAt;
        delete ret.__v;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("Language", languageSchema);
