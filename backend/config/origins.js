const isDev = process.env.NODE_ENV !== "production";

const localRegex = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

const allowedOrigins = ["https://upnextbookings.com/", localRegex];

module.exports = {
  isDev,
  allowedOrigins,
  connectSrc: ["'self'", "https://upnextbookings.com/", "http://localhost:*", "http://127.0.0.1:*"],
};
