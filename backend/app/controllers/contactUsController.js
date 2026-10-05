// controllers/contactUsController.js
const ContactUs = require("@models/ContactUs");
const { sendResponse, validateParams } = require("@utils/responseUtil");
const { sendEmailViaBrevo } = require("@utils/emailUtil");

// Create a new contact request
const createContactRequest = async (req, res) => {
  const { name, subject, message } = req.body;

  const validationOptions = {
    rawData: ["name", "subject", "message"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return;
  }

  try {
    const contactRequest = new ContactUs({
      name,
      subject,
      message,
      status: "pending", // Set the default status
    });

    const emailSubject = "Contact Us Request by " + name;
    const emailBody = `${message} \n Name: ${name} \n Subject: ${subject}`;

    const supportEmail = process.env.SUPPORT_EMAIL;

    await Promise.all([
      contactRequest.save(),
      //  sendEmailViaBrevo([supportEmail], emailSubject, emailBody, {
      // isHtml: false,
      // }),
    ]);

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "contact_request_4",
    });
  } catch (error) {

    if (error.name === "ValidationError") {
      const errorMessages = Object.values(error.errors).map(
        (err) => err.message
      );
      // Use the first error message key for translation
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: errorMessages[0], // Directly use the error key in the translationKey
        error: error,
      });
    }

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error: error,
    });
  }
};


module.exports = {
  createContactRequest,
};
