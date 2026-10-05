const sgMail = require("@sendgrid/mail");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { PinpointClient, SendMessagesCommand } = require("@aws-sdk/client-pinpoint");

var SibApiV3Sdk = require("sib-api-v3-sdk");

// Define the default app name
const DEFAULT_APP_NAME = "biolderPlate";

const sesClient = new SESClient({
  region: process.env.AWS_EMAIL_REGION,
  credentials: {
    accessKeyId: process.env.AWS_EMAIL_SECRET_ID,
    secretAccessKey: process.env.AWS_EMAIL_SECRET_KEY,
  },
});

//todo template for otp email
// const otpEmailTemplate = (otp) => {
//   return `<div>
//     <h1>Welcome to biolderPlate";</h1>
//     <p>Your OTP code is <strong>${otp}</strong></p>
//     <p>Use this code to complete your registration</p>
//   </div>`;
// };

/**
 * Send an email using AWS SES
 * @param {string} title - The title of the email (usually appears as the "from" name)
 * @param {Array} emails - List of recipient email addresses
 * @param {string} subject - Subject of the email
 * @param {string} body - Body of the email (HTML or plain text)
 * @param {Object} [config] - Additional configuration options (optional)
 * @param {string} [config.fromEmail] - From email address (default is set by AWS SES)
 * @param {Object} [config.attachments] - Attachments for the email (AWS SES supports raw email for attachments)
 * @param {boolean} [config.isHtml] - Flag to indicate if the body is HTML
 * @returns {Promise} - Promise resolving to AWS SES response or rejecting with an error
 */
const sendEmailViaAwsSes = async (emails, subject, body, config = {}) => {
  try {
    const { fromEmail = `biolderPlate"; App <${process.env.AWS_SENDER_EMAIL}>`, isHtml = true } = config;

    const params = {
      Source: fromEmail,
      Destination: {
        ToAddresses: emails,
      },
      Message: {
        Subject: {
          Data: subject,
        },
        Body: {
          [isHtml ? "Html" : "Text"]: {
            Data: body,
          },
        },
      },
    };

    const command = new SendEmailCommand(params);
    const response = await sesClient.send(command);
    return response;
  } catch (error) {
    console.error("Error sending email via AWS SES:", error);
    throw error;
  }
};

// Initialize the Pinpoint client
const pinpointClient = new PinpointClient({
  region: process.env.AWS_EMAIL_REGION,
  credentials: {
    accessKeyId: process.env.AWS_EMAIL_SECRET_ID,
    secretAccessKey: process.env.AWS_EMAIL_SECRET_KEY,
  },
});

/**
 * Send an SMS using Amazon Pinpoint
 * @param {string} phoneNumber - The recipient's phone number in E.164 format (+1234567890)
 * @param {string} message - The SMS message content
 * @returns {Promise} - A promise that resolves to the result of the Pinpoint SendMessagesCommand
 */
const sendSmsViaPinpoint = async (phoneNumber, message) => {
  try {
    const params = {
      ApplicationId: process.env.AWS_PINPOINT_APP_ID,
      MessageRequest: {
        Addresses: {
          [phoneNumber]: {
            ChannelType: "SMS",
          },
        },
        MessageConfiguration: {
          SMSMessage: {
            Body: message,
            MessageType: "TRANSACTIONAL", // Use "PROMOTIONAL" for marketing messages
            SenderId: process.env.AWS_PINPOINT_SENDER_ID, // Optional: Use if you have a sender ID
          },
        },
      },
    };

    const command = new SendMessagesCommand(params);
    const response = await pinpointClient.send(command);
    console.log("SMS sent successfully:", response);
    return response;
  } catch (error) {
    console.error("Error sending SMS via Amazon Pinpoint:", error);
    throw error;
  }
};

// Initialize SendGrid with your API key
// sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Send an email using SendGrid
 * @param {string} title - The title of the email (usually appears as the "from" name)
 * @param {Array} emails - List of recipient email addresses
 * @param {string} subject - Subject of the email
 * @param {string} body - Body of the email (HTML or plain text)
 * @param {Object} [config] - Additional configuration options (optional)
 * @param {string} [config.fromEmail] - From email address (default is set by SendGrid)
 * @param {Object} [config.attachments] - Attachments for the email
 * @param {boolean} [config.isHtml] - Flag to indicate if the body is HTML
 * @returns {Promise} - Promise resolving to SendGrid response or rejecting with an error
 */
const sendEmailViaSgrid = async (title, emails, subject, body, config = {}) => {
  try {
    // Set the default title if none is provided
    const emailTitle = title || DEFAULT_APP_NAME;

    const { fromEmail = process.env.SENDGRID_SENDER_EMAIL, attachments = [], isHtml = true } = config;

    const msg = {
      to: emails,
      from: {
        email: fromEmail,
        name: emailTitle,
      },
      subject: subject,
      [isHtml ? "html" : "text"]: body,
      attachments: attachments,
    };
    console.log(msg);

    const response = await sgMail.send(msg);
    return response;
  } catch (error) {
    console.error("Error sending email via sGrid:", error);
    throw error;
  }
};

const sendEmailViaBrevo = async (emails, subject, body, config = {}) => {
  var defaultClient = SibApiV3Sdk.ApiClient.instance;
  // Get the API key
  var apiKey = defaultClient.authentications["api-key"];
  apiKey.apiKey = process.env.BREVO_EMAIL_API_KEY; // Use the environment variable for the API key

  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  // Initial assignment from parameters
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = body;
  sendSmtpEmail.sender = { email: "support@upnextapp.com", name: "UpNext Support" };

  // Ensure to field is dynamically updated
  sendSmtpEmail.to = emails.map((email) => ({ email }));
  try {
    // Send email
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("Email paused in dev environment", data);
  } catch (error) {
    console.error("Error sending email:", error);
    // throw new Error (error.response.body)
  }
};

module.exports = {
  sendEmailViaAwsSes,
  sendSmsViaPinpoint,
  sendEmailViaSgrid,
  sendEmailViaBrevo,
};
