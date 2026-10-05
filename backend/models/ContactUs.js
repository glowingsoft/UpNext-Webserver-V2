// models/ContactUs.js
const mongoose = require('mongoose');

const ContactUsSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    default: "",
  },
  subject: {
    type: String,
    required: true,
    trim: true,
    default: "",
  },
  message: {
    type: String,
    required: true,
    trim: true,
    default: "",
  },
  status: {
    type: String,
    enum: ['pending', 'responded', 'resolved', 'closed'],
    default: 'pending',
  },
}, {
  timestamps: true,
});

const ContactUs = mongoose.model('ContactUs', ContactUsSchema);

module.exports = ContactUs;
