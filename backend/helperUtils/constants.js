// Date format constants
const DATE_FORMATS = {
  INPUT_DATE_FORMAT: "DD-MM-YYYY", // Format for input dates
  OUTPUT_DATE_FORMAT: "MMMM Do YYYY", // Format for output dates to be displayed to users
  UTC_FORMAT: "YYYY-MM-DDTHH:mm:ss.SSSZ", // ISO 8601 format with UTC timezone
  DB_DATE_FORMAT: "YYYY-MM-DD", // Format for storing dates without time
  DEFAULT_TIMEZONE: "UTC", // Default timezone if none is specified
};


module.exports = {
  DATE_FORMATS,
};
