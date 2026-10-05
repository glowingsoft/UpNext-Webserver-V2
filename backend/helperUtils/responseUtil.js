const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { camelCase } = require("lodash");
// Relative, not aliased: responseUtil is required from everywhere, including
// before module-alias registration in some entrypoints
const { attachRouteDistances, routeDistancesEnabled, sortNearestFirst } = require("./routeDistanceHelper");

/**
 * Sends a JSON response with optional status code, message, data, and meta information.
 * @param {object} res - Express response object.
 * @param {number} [statusCode=200] - HTTP status code (default: 200).
 * @param {string} [translationKey=''] - Base message to send in the response (default: '').
 * @param {object|array|null} [data=null] - Data to send in the response body (default: null).
 * @param {object} [meta] - Additional metadata to include in the response (optional).
 */

const sendResponse = ({
  res,
  statusCode = 200,
  translationKey = "",
  data = null,
  meta = null,
  error = null,
  translateMessage = true,
  values = {}, // Add values parameter for dynamic translation
}) => {
  // Log the error regardless of the translation flag

  // Prepare the response object
  const response = {};
  if (translateMessage) {
    // Get the translation key from the locale file and replace the placeholders using the provided values
    let message = res?.req?.__(translationKey);

    // If the message is missing, undefined, or equals the raw translationKey, fall back to translationKey
    if (!message || message.trim() === "" || message === translationKey) {
      // Fallback: Convert key to readable text
      message = keyToReadableText(translationKey);
    }

    // If values are provided, replace placeholders in the translation
    if (values && typeof values === "object") {
      Object.keys(values).forEach((key) => {
        const placeholder = `{${key}}`;
        message = message.replace(placeholder, values[key]);
      });
    }
    response.message = message;
  } else {
    response.message = translationKey;
  }

  // Check if response.message is an empty object, and set a default message if so
  if (typeof response.message === "object" && response.message !== null && Object.keys(response.message).length === 0) {
    response.message = "Something went wrong"; // Default message for empty objects
  }

  // Ensure response.message is a string before using trim()
  if (typeof response.message === "string" && response.message.trim() === "") {
    response.message = translationKey; // Fallback to translation key if the message is empty
  } else if (!response.message) {
    // If response.message is undefined or null, set it to the translation key
    response.message = translationKey;
  }
  // Include data in the response if provided
  if (data !== undefined && data !== null) {
    // logger.log("Response Data:", data);
    response.data = data;
  }

  // Include meta information if provided
  if (meta) {
    response.meta = meta;
  }
  if (process.env.NODE_ENV === "dev" || process.env.NODE_ENV === "localhost") {
    if (error !== null && error !== undefined) {
      if (error instanceof Error) {
        // Extract important properties from the Error object
        response.error = {
          message: error.message,
          stack: error.stack, // You may not want to include the stack trace in production
          name: error.name,
        };
      } else if (typeof error === "object") {
        try {
          // Serialize the object if it's not an instance of Error
          response.error = JSON.stringify(error);
        } catch (err) {
          response.error = "Error: Could not serialize the error object.";
        }
      } else {
        // If the error is a primitive value (string, boolean, number, etc.)
        response.error = error;
      }
      console.log(error);
    }
  }
  // Straight-line distanceKm is already on the payload; when the caller sent
  // their position and routing is configured, swap it for the real road
  // distance before the response goes out (see @utils/routeDistanceHelper).
  // Gated synchronously so every other response stays on the sync path it has
  // always been on — 737 call sites, none of which await this function.
  const { lat, lng, sortBy } = res?.req?.query || {};
  if (routeDistancesEnabled() && lat != null && lng != null && response.data) {
    attachRouteDistances({ lat, lng, payload: response.data })
      // The pipeline ordered this page by straight-line distance; now that the
      // rows carry road distances, put them back in nearest-first order.
      .then(() => sortBy === "distance_near_far" && sortNearestFirst(response.data))
      .catch((error) => console.error(`[routeDistance] enrichment failed: ${error?.message}`))
      .finally(() => res.status(statusCode).json(response));
    return;
  }

  // Send the response with the appropriate status code
  res.status(statusCode).json(response);
};

// Helper: Convert key to readable default translation
function keyToReadableText(key) {
  if (!key || typeof key !== "string" || key.trim() === "") return "";
  const withSpaces = key.replace(/[_\.]+/g, " ");
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

// Helper function to parse pagination parameters
const parsePaginationParams = (req) => {
  let { page = 1, limit = 10 } = req.query;

  // Parse page and limit as integers and ensure they are valid
  page = parseInt(page, 10);
  limit = parseInt(limit, 10);

  if (isNaN(page) || page < 1) {
    page = 1;
  }
  if (isNaN(limit) || limit < 1) {
    limit = 10;
  }

  // Cap the limit to a maximum of 50
  if (limit > 100) {
    limit = 100;
  }
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

// Helper function to generate meta information
const generateMeta = (page, limit, total) => {
  return {
    currentPage: page,
    totalPages: Math.ceil(total / limit),
    totalRecords: total,
    limit: limit,
  };
};
const validateObjectIdsArr = (res, ids, fieldNames) => {
  const invalidParams = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const fieldName = fieldNames[i];

    // Check if ObjectId is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      invalidParams.push(fieldName); // Add the field name to invalid params
    }
  }

  // If invalid ObjectIds are found
  if (invalidParams.length > 0) {
    sendResponse({
      res,
      statusCode: 400,
      translationKey: "invalid_object_ids", // Translation key
      values: { fields: invalidParams.join(", ") }, // Pass invalid field names as values
    });
    return false;
  }

  return true; // All ObjectIds are valid
};

// Helper function to convert underscores to spaces
const convertUnderscoresToSpaces = (str) => String(str).replace(/_/g, " ");

// const validationOptions ={
//   queryParams:["name","plan"],
//   rawData:["title"],
//   formFields:["age"],
//   objectIdFields:["123"],
//   dateFields: {
//     startDate: "YYYY-MM-DD",
//     endDate: "YYYY-MM-DD",
//   },
// }
// if (!validateParams(req, res, validationOptions)) {
//   return; // Invalid request data response already sent by validateParams
// }

// Generic validation function
// Generic validation function
const validateParams = (req, res, options = {}) => {
  const {
    queryParams = [],
    pathParams = [],
    formFields = [],
    rawData = [],
    objectIdFields = [],
    dateFields = {},
    timeFields = {},
    enumFields = {}, // Field for enum validations
    minLengthFields = {}, // Field for minimum length validations
    locationFields = {}, // Field for location validations
  } = options;

  // Validate query parameters
  const missingParamsQuery = [];
  for (const param of queryParams) {
    if (req.query[param]) {
      req.query[camelCase(param)] = convertUnderscoresToSpaces(req.query[param]);
    } else {
      missingParamsQuery.push(param);
    }
  }

  if (missingParamsQuery.length > 0) {
    sendResponse({
      res,
      statusCode: 400,
      translationKey: "missing_query_parameters", // Use a general key from translations
      values: { fields: missingParamsQuery.join(", ") }, // Pass the actual missing field as a value
    });
    return false;
  }

  // Validate path parameters
  const missingParamsPath = [];
  for (const param of pathParams) {
    if (req.params[param]) {
      req.params[camelCase(param)] = convertUnderscoresToSpaces(req.params[param]);
    } else {
      missingParamsPath.push(param);
    }
  }

  if (missingParamsPath.length > 0) {
    sendResponse({
      res,
      statusCode: 400,
      translationKey: "missing_path_parameters", // Use a general key from translations
      values: { fields: missingParamsPath.join(", ") }, // Pass the actual missing field as a value
    });
    return false;
  }

  // Validate form fields
  const missingParamsForm = [];
  for (const param of formFields) {
    if (req.body[param]) {
      req.body[camelCase(param)] = convertUnderscoresToSpaces(req.body[param]);
    } else {
      missingParamsForm.push(param);
    }
  }

  if (missingParamsForm.length > 0) {
    sendResponse({
      res,
      statusCode: 400,
      translationKey: "missing_form_fields", // Use a general key from translations
      values: { fields: missingParamsForm.join(", ") }, // Pass the actual missing field as a value
    });
    return false;
  }

  // Validate raw data
  const missingParamsRaw = [];
  for (const param of rawData) {
    const value = extractNestedFields(req.body, param);

    if (
      (typeof value === "string" && value.trim() !== "") ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "object" && value !== null)
    ) {
      // Optional: You can still set camelCase version if needed, though nesting complicates this
      // e.g., req.body[camelCase(param)] = value;
    } else {
      missingParamsRaw.push(param);
    }
  }

  if (missingParamsRaw.length > 0) {
    sendResponse({
      res,
      statusCode: 400,
      translationKey: "missing_raw_fields", // Use a general key from translations
      values: { fields: missingParamsRaw.join(", ") }, // Pass the actual missing field as a value
    });
    return false;
  }

  // Validate MongoDB ObjectId fields from different sources
  const objectIdsToValidate = [];
  const fieldNames = [];

  for (const field of objectIdFields) {
    let value =
      extractNestedFields(req.body, field) ||
      extractNestedFields(req.params, field) ||
      extractNestedFields(req.query, field);
    if (value) {
      if (Array.isArray(value)) {
        for (const val of value) {
          objectIdsToValidate.push(val);
          fieldNames.push(field); // Indicate it's from an array
        }
      } else {
        objectIdsToValidate.push(value);
        fieldNames.push(field);
      }
    }
  }
  if (!validateObjectIdsArr(res, objectIdsToValidate, fieldNames)) {
    return false;
  }

  // Validate date fields (only verify format if available, don't check for missing)
  for (const [field, format] of Object.entries(dateFields)) {
    const dateValue =
      extractNestedFields(req.body, field) ||
      extractNestedFields(req.params, field) ||
      extractNestedFields(req.query, field);
    if (dateValue) {
      const isValidDate = moment(dateValue, format, true).isValid();
      if (!isValidDate) {
        sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_date_format", // Use translation key
          values: { field, format }, // Replace placeholders with actual values
        });
        return false;
      }
    }
  }
  //time fields validation
  for (const [field, format] of Object.entries(timeFields)) {
    const timeValue =
      extractNestedFields(req.body, field) ||
      extractNestedFields(req.params, field) ||
      extractNestedFields(req.query, field);
    if (timeValue) {
      const isValidTime = moment(timeValue, format, true).isValid();
      if (!isValidTime) {
        sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_time_format", // Use translation key
          values: { field, format }, // Replace placeholders with actual values
        });
        return false;
      }
    } else {
      sendResponse({
        res,
        statusCode: 400,
        translationKey: "missing_time_field", // Use translation key
        values: { field }, // Pass the missing field as a value
      });
      return false;
    }
  }

  // Validate enum fields
  for (const [field, allowedValues] of Object.entries(enumFields)) {
    const value =
      extractNestedFields(req.body, field) ||
      extractNestedFields(req.params, field) ||
      extractNestedFields(req.query, field);

    if (value) {
      if (Array.isArray(value)) {
        // Check if every item in the array is allowed
        const invalidValues = value.filter((v) => !allowedValues.includes(v));
        if (invalidValues.length > 0) {
          sendResponse({
            res,
            statusCode: 400,
            translationKey: "invalid_enum_value",
            values: {
              field,
              allowedValues: allowedValues.join(", "),
              invalidValues: invalidValues.join(", "),
            },
          });
          return false;
        }
      } else {
        // Single value check
        if (Array.isArray(allowedValues) && allowedValues.length > 0) {
          if (!allowedValues.includes(value)) {
            sendResponse({
              res,
              statusCode: 400,
              translationKey: "invalid_enum_value",
              values: { field, allowedValues: allowedValues.join(", ") },
            });
            return false;
          }
        }
      }
    }
  }

  // Validate minimum length fields
  for (const [field, minLength] of Object.entries(minLengthFields)) {
    const value = req.body[field] || req.params[field] || req.query[field];
    if (value && value.length < minLength) {
      sendResponse({
        res,
        statusCode: 400,
        translationKey: "min_length_violation", // Use translation key
        values: { field, minLength }, // Replace placeholders with actual values
      });
      return false;
    }
  }
  //sample input
  //location validation
  for (const [field, location] of Object.entries(locationFields)) {
    const value =
      extractNestedFields(req.body, field) ||
      extractNestedFields(req.params, field) ||
      extractNestedFields(req.query, field);
    if (value) {
      const locationArray = value.split(",");
      if (locationArray.length !== 2) {
        sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_location_format", // Use translation key
          values: { field }, // Replace placeholders with actual values
        });
        return false;
      }
      const [latitude, longitude] = locationArray;
      if (
        isNaN(latitude) ||
        isNaN(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_location_values", // Use translation key
          values: { field }, // Replace placeholders with actual values
        });
        return false;
      }
    } else {
      sendResponse({
        res,
        statusCode: 400,
        translationKey: "missing_location_field", // Use translation key
        values: { field }, // Replace placeholders with actual values
      });
      return false;
    }
  }

  return true;
};

/**
 * Check if a given ID is a valid nanoid (default 21 characters, a-zA-Z0-9, _ and -)
 */
function isValidNanoid(id) {
  const nanoidRegex = /^[A-Za-z0-9_-]{21}$/;
  return nanoidRegex.test(id);
}

const extractNestedFields = (obj, fieldPath) => {
  const fields = fieldPath.split(".");
  let value = obj;

  for (const field of fields) {
    if (value !== null && value !== undefined && value[field] !== undefined) {
      value = value[field];
    } else {
      return null;
    }
  }
  return value;
};

// Example usage
const exampleMiddleware = (req, res, next) => {
  const validationOptions = {
    queryParams: ["some_query_param"],
    pathParams: ["some_path_param"],
    formFields: ["title", "description", "image"],
    objectIdFields: ["userId", "postId"],
  };

  if (!validateParams(req, res, validationOptions)) {
    return; // Invalid request data response already sent by validateParams
  }

  next();
};

/**
 * Convert UTC date to a specific timezone and format it as AM/PM
 * @param {string} date - The date to be converted.
 * @param {string} timezone - The timezone to convert to.
 * @param {string} outputFormat - The desired output format (default is AM/PM format).
 * @param {string} inputFormat - The input format for the date (default is ISO 8601).
 * @returns {string} The formatted date in the specified timezone and format.
 */
const convertUtcToTimezoneAMPM = (
  date,
  timezone,
  outputFormat = "hh:mm A", // Default output format is AM/PM
  inputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ", // Default input format (ISO 8601)
) => {
  // Check if the date is valid before proceeding
  if (!date || !moment(date, inputFormat, true).isValid()) {
    console.error("Invalid date format:", date);
    return "Invalid Date"; // Return a fallback value
  }

  const momentDate = moment(date, inputFormat, true); // Parse date with strict input format

  if (timezone) {
    // Apply timezone conversion if timezone is provided
    return momentDate.tz(timezone).format(outputFormat); // Return in AM/PM format
  } else {
    // Simply format the date without timezone conversion
    return momentDate.format(outputFormat); // Return in AM/PM format
  }
};

/**
 * Converts a date from a specified input format to a specified user timezone.
 * If the timezone is null or not provided, it formats the date without applying a timezone.
 * @param {string | Date} date - The date to convert.
 * @param {string} [timezone] - The user's timezone (e.g., "Asia/Karachi"). If null, no timezone conversion is applied.
 * @param {string} [outputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional output date format. Defaults to MongoDB format.
 * @param {string | string[]} [inputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional input date format(s). Defaults to UTC format.
 * @returns {string} The converted date in the user's timezone or formatted date if timezone is null.
 */
const convertUtcToTimezone = (
  date,
  timezone,
  outputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ",
  inputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ",
) => {
  const momentDate = moment(date, inputFormat, true); // Parse date with strict input format

  if (timezone) {
    // Apply timezone conversion if timezone is provided
    return momentDate.tz(timezone).format(outputFormat);
  } else {
    // Simply format the date without timezone conversion
    return momentDate.format(outputFormat);
  }
};

/**
 * Converts a date from a specified timezone to UTC.
 * If the timezone is null or not provided, it formats the date without applying a timezone.
 * @param {string | Date} date - The date to convert.
 * @param {string} [timezone] - The user's timezone (e.g., "Asia/Karachi"). If null, no timezone conversion is applied.
 * @param {string} [outputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional output date format. Defaults to MongoDB format.
 * @param {string | string[]} [inputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional input date format(s). Defaults to UTC format.
 * @returns {string} The converted date in UTC or formatted date if timezone is null.
 */

const convertTimezoneToUtc = (
  date,
  timezone,
  inputFormat = "YYYY-MM-DD hh:mm A",
  outputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ",
) => {
  const momentDate = moment.tz(date, inputFormat, timezone).utc();
  return momentDate.format(outputFormat); // return string
};
const convertToUtcDateOnly = (date, timezone, inputFormat = "YYYY-MM-DD") => {
  // Parse the date in the specified timezone but do not change the time zone
  const momentDate = moment.tz(date, inputFormat, timezone);

  // Format the date in the given timezone without changing the time zone
  return momentDate.format("YYYY-MM-DD[T]HH:mm:ss.SSS[+00:00]"); // Return the formatted date
};

const convertTimezoneToUtcDateOnly = (date, timezone, inputFormat = "YYYY-MM-DD hh:mm A") => {
  const momentDate = moment.tz(date, inputFormat, timezone).utc();

  // Manually set UTC time to midnight WITHOUT startOf()
  const year = momentDate.year();
  const month = momentDate.month(); // 0-based
  const day = momentDate.date();

  const utcMidnight = moment
    .utc([year, month, day]) // creates YYYY-MM-DDT00:00:00.000Z
    .format("YYYY-MM-DD[T]HH:mm:ss.SSS[+00:00]");

  return utcMidnight;
};

// Get the current date in user's timezone
//Emphasizes the returned value is UTC-based, calculated using a timezone
const getCurrentDateInTimezone = ({ timezone, isDateOnly = false, format = "YYYY-MM-DDTHH:mm:ss.SSSZ" }) => {
  if (!timezone) {
    throw new Error("Timezone is required");
  }

  let now = moment().tz(timezone);

  if (isDateOnly) {
    now = now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  }

  // Return as a native JS Date object for MongoDB compatibility
  return now.toDate();
};

const getStartAndEndOfDay = (date, timezone) => {
  const start = moment(date).tz(timezone).startOf("day").utc().startOf("day").toDate();

  const end = moment(date).tz(timezone).endOf("day").utc().startOf("day").toDate();

  return { start, end };
};

const getStartAndEndOfWeek = (date, timezone) => {
  const start = moment.tz(date, timezone).startOf("week").toDate();
  const end = moment.tz(date, timezone).endOf("week").toDate();
  return { start, end };
};
const getStartAndEndOfMonth = (date, timezone) => {
  const start = moment.tz(date, timezone).startOf("month").toDate();
  const end = moment.tz(date, timezone).endOf("month").toDate();
  return { start, end };
};

/**
 * Converts a date from a specified input format to a specified output format.
 * If the timezone is null or not provided, it formats the date without applying a timezone.
 * @param {string | Date} date - The date to convert.
 * @param {string} [outputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional output date format. Defaults to MongoDB format.
 * @param {string | string[]} [inputFormat="YYYY-MM-DDTHH:mm:ss.SSSZ"] - Optional input date format(s). Defaults to UTC format.
 * @returns {string} The formatted date.
 */
const convertDateFormat = (
  date,
  outputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ",
  inputFormat = "YYYY-MM-DDTHH:mm:ss.SSSZ",
) => {
  // Parse date with strict input format
  const momentDate = moment(date, inputFormat, true);

  // Simply format the date without timezone conversion
  return momentDate.format(outputFormat);
};

const getReadableErrorMessage = (error) => {
  // Set status code based on error type
  const statusCode = error.name === "ValidationError" ? 400 : error.code === 11000 ? 409 : 500;

  // Handle duplicate key error
  if (error.code === 11000 && error.message.includes("dup key")) {
    // Try to extract all key-value pairs from the dup key object
    const match = error.message.match(/dup key: { (.+) }/);
    if (match && match[1]) {
      // Split multiple fields if present (e.g., title: "Swimming", practiceCategory: ObjectId('...'))
      const fields = match[1].split(",").map((f) => f.trim());
      // Build a readable message for all fields
      const fieldMessages = fields.map((field) => {
        // Split field into key and value
        const [key, value] = field.split(":").map((s) => s.trim());
        // Remove ObjectId(...) wrapper if present
        let cleanValue = value;
        if (/^ObjectId\(['"](.+)['"]\)$/.test(value)) {
          cleanValue = value.match(/^ObjectId\(['"](.+)['"]\)$/)[1];
        } else if (/^"(.+)"$/.test(value)) {
          cleanValue = value.replace(/^"(.+)"$/, "$1");
        }
        return `${key} '${cleanValue}'`;
      });
      return {
        code: 11000,
        statusCode,
        message: `A record with ${fieldMessages.join(" and ")} already exists.`,
      };
    }
    return { code: 11000, statusCode, message: "duplicate_value" };
  }

  // Handle Mongoose validation error with full path extraction
  if (error.name === "ValidationError") {
    // Collect all validation error messages with full path
    const messages = Object.values(error.errors || {}).map((e) => {
      // If e.path exists, build full path from e.properties.path or e.path
      let fullPath = e.path || (e.properties && e.properties.path) || "";
      // Try to extract full path from error.message if possible
      // e.g., "Course validation failed: vocabullary.items.0.word: Path `word` is required."
      let match = error.message.match(new RegExp(`([\\w\\.]+):\\s*Path \`${e.path}\` is required`));
      if (match && match[1]) {
        fullPath = match[1];
      }
      // If fullPath is available, use it in the message
      if (fullPath) {
        return `Path \`${fullPath}\` is required.`;
      }
      // Fallback to original message
      return e.message;
    });
    return {
      code: null,
      statusCode,
      message: messages.length ? messages.join(", ") : error.message,
    };
  }

  // Default error
  return { code: error.code || null, statusCode, message: error.message };
};
const getCurrentUtcDateOnly = () => {
  const now = new Date();
  function getEndDate(pricingPlan, startDate = new Date()) {
    if (!pricingPlan || pricingPlan === "free") return null;

    const start = new Date(startDate);

    if (pricingPlan === "monthly") {
      return new Date(start.setMonth(start.getMonth() + 1));
    }
    if (pricingPlan === "yearly") {
      return new Date(start.setFullYear(start.getFullYear() + 1));
    }

    return null;
  }
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(), // set time to 00:00:00 UTC
      0,
      0,
      0,
      0,
    ),
  );
};
const getEndDate = (pricingPlan, startDate = new Date()) => {
  if (!pricingPlan || pricingPlan === "free") return null;

  const start = new Date(startDate);

  if (pricingPlan === "monthly") {
    return new Date(start.setMonth(start.getMonth() + 1));
  }

  if (pricingPlan === "yearly") {
    return new Date(start.setFullYear(start.getFullYear() + 1));
  }

  return null;
};

const fireAndForget = (promise, label) => {
  promise.catch((err) => console.error(`[${label}] failed:`, err));
};

const cleanfiles = (files) => {
  const getFileName = (file) => {
    if (typeof file !== "string") return file;

    const trimmed = file.trim();

    // Empty string = no image
    if (!trimmed) return "noImg.png";

    return trimmed.split("/").pop();
  };

  if (Array.isArray(files)) {
    return files.length ? files.map(getFileName) : [];
  }

  if (files == null || (typeof files === "string" && !files.trim())) {
    return "noImg.png";
  }

  return getFileName(files);
};

module.exports = {
  sendResponse,
  parsePaginationParams,
  generateMeta,
  validateObjectIdsArr,
  validateParams,
  isValidNanoid,
  exampleMiddleware,
  convertUtcToTimezone,
  convertTimezoneToUtc,
  convertDateFormat,
  getCurrentDateInTimezone,
  getReadableErrorMessage,
  getStartAndEndOfDay,
  getStartAndEndOfWeek,
  getStartAndEndOfMonth,
  convertUtcToTimezoneAMPM,
  convertTimezoneToUtcDateOnly,
  getCurrentUtcDateOnly,
  convertToUtcDateOnly,
  getEndDate,
  fireAndForget,
  cleanfiles,
};
