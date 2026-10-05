const mongoose = require("mongoose");
const { translationSchema } = require("./Models");

const FAQSchema = new mongoose.Schema(
  {
    question: {
      type: translationSchema,
      required: true,
      default: () => ({}),
    },
    answer: {
      type: translationSchema,
      required: true,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

const Faq = mongoose.model("Faq", FAQSchema);

module.exports = Faq;
