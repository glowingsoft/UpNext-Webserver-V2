const { User, generateResetToken } = require("@models/UserModel");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { sendResponse, validateParams } = require("@utils/responseUtil");
const { formatUserResponse, attachProfile } = require("@utils/userResponseUtil");
const { syncProfileFlags } = require("@utils/profileFlagsUtil");
const { sendEmailViaBrevo } = require("@utils/emailUtil");
const { registrationOtpEmailTemplate, forgotPasswordOtpEmailTemplate } = require("@utils/emailTemplates");
const { createOrSkipDevice, Devices } = require("@models/Devices");
const { createSession, renewSession, revokeSession, revokeAllSessions } = require("@models/Session");
const validator = require("validator");
const bcrypt = require("bcryptjs");
const { userCache } = require("@config/nodeCache");
const { UserProfile } = require("@models/UserProfile");
const BusinessProfile = require("@models/BusinessProfile");

const register = async (req, res) => {
  const {
    email,
    phoneNumber,
    deviceId,
    deviceType,
    userType,
    profileIcon,
    name,
    password,
    timezone,
    location,
    language,
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const validationOptions = {
      rawData: ["name", "phoneNumber", "email", "password", "deviceId", "deviceType", "timezone"],
      minLengthFields: {
        password: 6, // Password must be at least 6 characters long
      },
    };
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    // Validate phone number format
    if (phoneNumber && !validator.isMobilePhone(phoneNumber, "any", { strictMode: true })) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_phone",
      });
    }

    // Fetch existing user
    const existingEmail = await User.findOne({
      email: email.trim().toLowerCase(),
    });

    const existingPhone = await User.findOne({
      phoneNumber: phoneNumber.trim().toLowerCase(),
      "verificationStatus.phoneNumber": "verified",
    });

    if (existingEmail) {
      if ((existingEmail.email === email.trim().toLowerCase(), existingEmail.verificationStatus.email === "verified")) {
        return sendResponse({
          res,
          statusCode: 409,
          translationKey: "email_already",
        });
      }
    }

    if (existingPhone) {
      if (existingPhone.phoneNumber === phoneNumber.trim().toLowerCase()) {
        return sendResponse({
          res,
          statusCode: 409,
          translationKey: "phone_number_already",
        });
      }
    }

    let existingUser = existingEmail;

    // Restrict admin creation
    let finalUserType = userType || "user"; // default to user
    if (userType === "admin") {
      const adminCreationToken = req.header("x-admin-access-token");
      if (adminCreationToken === process.env.ADMIN_ACCESS_TOKEN) {
        finalUserType = "admin";
      } else {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "unauthorized_to",
        });
      }
    }

    let user;
    if (existingUser) {
      // Update existing user if email is not verified
      existingUser.verificationStatus.email = "pending";
      existingUser.verificationStatus.phoneNumber = "pending";
      user = existingUser;
      Object.assign(user, req.body);
      user.accountState.userType = finalUserType;
      user.accountState.roles = [finalUserType];
      if (language) {
        user.language = language;
      }
    } else {
      // Create and save the user within the session
      user = new User({
        email,
        phoneNumber,
        deviceId,
        deviceType,
        profileIcon,
        name,
        password,
        timezone,
        location,
        language,
        accountState: { userType: finalUserType, roles: [finalUserType] },
      });
    }

    const otp = user.generateOtp("email", user.timezone);

    await user.save({ session });

    // Send email within the transaction
    const subject = "Welcome! Verify Your Email";
    const mBody = registrationOtpEmailTemplate(otp);
    //await sendEmailViaBrevo([email], subject, mBody);

    // Commit the transaction
    await session.commitTransaction();

    // Format the user response using the utility function
    const response = formatUserResponse(user);

    // Save device information (not part of the transaction)
    createOrSkipDevice(user._id, deviceId, deviceType);

    // Send successful response with token and user data
    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "signup_successful",
      data: response,
    });
  } catch (error) {
    // Only abort the transaction if it hasn't been committed yet
    await session.abortTransaction();
    // Handle validation errors from Mongoose
    const statusCode = error.name === "ValidationError" ? 400 : 500;
    const translationKey = error.name === "ValidationError" ? Object.values(error.errors)[0].message : error.message;

    return sendResponse({
      res,
      statusCode,
      translationKey,
      error,
    });
  } finally {
    session.endSession(); // Ensure the session is always ended
  }
};

//login

const login = async (req, res) => {
  try {
    const { email, password, deviceId, deviceType, timezone, userType, language } = req.body;

    const validationOptions = {
      rawData: ["email", "password", "deviceId", "deviceType", "timezone"],
    };
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    const user = await User.findByCredentials(email, password);

    // Check if an error occurred
    if (user.error) {
      if (user.error === "user_not_found") {
        return sendResponse({
          res,
          statusCode: 404,
          translationKey: "user_not_found", // Use your translation key for user not found
        });
      } else if (user.error === "incorrect_password") {
        return sendResponse({
          res,
          statusCode: 401,
          translationKey: "incorrect_password", // Use your translation key for incorrect password
        });
      }
    }

    // Restrict admin login
    if (user.accountState.userType === "admin" && userType !== "admin") {
      const adminCreationToken = req.header("x-admin-access-token");
      if (adminCreationToken === process.env.ADMIN_ACCESS_TOKEN) {
      } else {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "unauthorized_to_1",
        });
      }
    }

    // Check the user's verification status
    const verificationStatus = user.verificationStatus?.email;
    if (verificationStatus === "pending") {
      const otp = user.generateOtp("email", user.timezone || "UTC");
      await user.save();
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "your_account",
        data: { otp }, // Optionally include OTP in the response for testing purposes
      });
    }
    if (verificationStatus === "rejected") {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "your_account_1",
      });
    }

    if (user.accountState.status === "restricted" || user.accountState.status === "suspended") {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "your_account_2",
      });
    }

    if (verificationStatus !== "verified") {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "your_account_3",
      });
    }
    if (userType) {
      if (user.accountState.roles && !user.accountState.roles.includes(userType)) {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "unauthorized_to_login_as " + userType,
        });
      }
      // User has the required role
      if (user.accountState.userType !== userType) {
        user.accountState.userType = userType; // Update the userType in accountState
        await user.save();
      }
    }

    if (language) {
      user.language = language; // Update the language
      await user.save();
    }
    // Update the user's timezone
    user.timezone = timezone;

    // 2FA gate: password check passed, but don't issue a session yet —
    // send an OTP and make the client complete login via verifyLoginOtp
    if (user.security?.twoFactorEnabled) {
      const otp = user.generateOtp("twoFactor", user.timezone || "UTC");
      await user.save();
      // await sendEmailViaBrevo([user.email], "Your UpNext Verification Code", twoFactorOtpEmailTemplate(otp));
      return sendResponse({
        res,
        statusCode: 200,
        translationKey: "two_factor_otp_sent",
        data: { requiresTwoFactor: true, email: user.email, otp }, // otp included for testing purposes, same as other OTP flows in this file
      });
    }

    return await completeLogin({ user, deviceId, deviceType, res });
  } catch (error) {
    console.log("error:", error);
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: error.message,
    });
  }
};

// Shared tail of the login flow — issues the session/JWT and formats the
// response. Used both by a direct (non-2FA) login and by verifyLoginOtp
// once the second factor has been confirmed.
const completeLogin = async ({ user, deviceId, deviceType, res }) => {
  const { sessionId, refreshToken } = await createSession({ userId: user._id, deviceId, deviceType });
  const token = user.generateAuthToken(sessionId, deviceType);
  // authMiddleware doesn't run on this route, so the stored profile flags are
  // whatever the account's last authenticated request left behind — resolve
  // them before formatting or a profile created out of band reads as missing.
  await syncProfileFlags(user);
  // Format the user response using the utility function
  const response = formatUserResponse(user, token, [], ["resetToken"]);
  response.refreshToken = refreshToken;
  const { profile, error: profileError } = await attachProfile(user);
  if (profileError) {
    return sendResponse({
      res,
      statusCode: 403,
      translationKey: profileError,
    });
  }
  response.profile = profile;
  // Save device information (not part of the transaction)
  createOrSkipDevice(user._id, deviceId, deviceType);
  // Send successful response with token and user data
  return sendResponse({
    res,
    statusCode: 200,
    translationKey: "login_success",
    data: response,
  });
};

// Second step of login when 2FA is enabled — verifies the emailed OTP,
// then completes login exactly like the non-2FA path does.
const verifyLoginOtp = async (req, res) => {
  const { email, otp, deviceId, deviceType, timezone } = req.body;
  const validationOptions = {
    rawData: ["email", "otp", "deviceId", "deviceType", "timezone"],
  };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return sendResponse({ res, statusCode: 404, translationKey: "user_not_found" });
    }

    const otpInfo = user.otpInfo.twoFactorOtp;
    if (!otpInfo.otp || otpInfo.otpUsed || otpInfo.otp !== otp.toString()) {
      return sendResponse({ res, statusCode: 400, translationKey: "invalid_otp" });
    }

    const currentTime = moment.tz(Date.now(), timezone || user.timezone || "UTC").valueOf();
    if (otpInfo.otpExpires && new Date(otpInfo.otpExpires).getTime() < currentTime) {
      return sendResponse({ res, statusCode: 400, translationKey: "otp_has" });
    }

    otpInfo.otp = "";
    otpInfo.otpExpires = "";
    otpInfo.otpUsed = true;
    user.timezone = timezone || user.timezone;
    await user.save();

    return await completeLogin({ user, deviceId, deviceType, res });
  } catch (error) {
    console.error("Error verifying login OTP:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error",
      error,
    });
  }
};

// Generate OTP
const generateOtp = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, phoneNumber, type } = req.body;
    const validationOptions = {
      rawData: [type === "email" ? "email" : "phoneNumber"],
    };
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    // Validate phone number format
    if (type === "phoneNumber" && phoneNumber && !validator.isMobilePhone(phoneNumber, "any", { strictMode: true })) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_phone",
      });
    }

    let user;
    if (type === "email") {
      user = await User.findOne({ email: email.toLowerCase() }).select("email accountState otpInfo");
    } else if (type === "phoneNumber") {
      user = await User.findOne({ phoneNumber }).select("phoneNumber accountState otpInfo");
    }

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    // Check if account is restricted
    if (["restricted", "suspended"].includes(user.accountState.status)) {
      return sendResponse({
        res,
        statusCode: 403,
        translationKey: "your_account_4",
      });
    }

    const otp = user.generateOtp(type, user.timezone);

    // if (otp.error) {
    //   if (otp.error === "too_many_otp_requests") {
    //     return sendResponse({
    //       res,
    //       statusCode: 400,
    //       translationKey: "too_many_otp_requests",
    //     });
    //   }
    // }

    await user.save({ session });

    // Send email or SMS within the transaction
    const subject = "Password Reset OTP";
    const mBody = forgotPasswordOtpEmailTemplate(otp);
    //await sendEmailViaBrevo([email], subject, mBody);

    await session.commitTransaction();
    session.endSession();

    return sendResponse({
      res,
      statusCode: 201,
      translationKey: "otp_generated",
      data: { otp },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message,
      error: error,
    });
  }
};

//Verify otp
const verifyOtp = async (req, res) => {
  // const session = await mongoose.startSession();
  // session.startTransaction();

  try {
    const { email, phoneNumber, type, otp, deviceId } = req.body;
    const validationOptions = {
      rawData: [type === "email" ? "email" : "phoneNumber"],
    };
    if (type === "email") {
      validationOptions.rawData.push("otp");
    }
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    // Validate phone number format if the OTP is for phone
    if (type === "phoneNumber" && phoneNumber && !validator.isMobilePhone(phoneNumber, "any", { strictMode: true })) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_phone",
      });
    }

    let user;
    if (type === "email") {
      user = await User.findOne({ email: email.toLowerCase() }).select(
        "email accountState otpInfo verificationStatus timezone",
      );
    } else if (type === "phoneNumber") {
      user = await User.findOne({ phoneNumber }).select("phoneNumber accountState otpInfo verificationStatus timezone");
    }

    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    // Access the correct OTP based on the type (email or phone)
    const userOtpInfo = type === "email" ? user.otpInfo.emailOtp : user.otpInfo.phoneNumberOtp;

    if (type === "email") {
      // Check if the OTP matches
      if (userOtpInfo.otp !== otp.toString()) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "invalid_otp",
        });
      }

      // Check if the OTP has expired
      const currentTime = moment.tz(Date.now(), user.timezone).valueOf();
      if (userOtpInfo.otpExpires && userOtpInfo.otpExpires < currentTime) {
        return sendResponse({
          res,
          statusCode: 400,
          translationKey: "otp_has",
        });
      }
    }

    // Clear the OTP and OTP expiration after successful verification
    userOtpInfo.otp = "";
    userOtpInfo.otpExpires = "";
    userOtpInfo.otpUsed = true; // Mark OTP as used
    user.verificationStatus[type] = "verified"; // Mark verification as complete

    // Generate a password reset token (JWT or a UUID)
    const resetToken = generateResetToken(); // Function to generate a secure token
    user.resetToken = resetToken; // Save the token to the user model

    await user.save();
    // await session.commitTransaction();
    // session.endSession();

    // Fetch the updated user and profile icon simultaneously
    const updatedUser = await User.findById(user._id);

    // Generate a new auth token for the user
    const { sessionId, refreshToken } = await createSession({ userId: user._id, deviceId });
    const token = user.generateAuthToken(sessionId);

    await syncProfileFlags(updatedUser);

    // Format the user response using the utility function
    const response = formatUserResponse(updatedUser, token);
    response.refreshToken = refreshToken;
    response.profile = (await attachProfile(user)).profile;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "otp_verified",
      data: response,
    });
  } catch (error) {
    // await session.abortTransaction();
    // session.endSession();
    console.error("Error during OTP verification:", error);
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error",
      error: error,
    });
  }
};

// Reset Password
const resetPassword = async (req, res) => {
  try {
    const { email, newPassword, resetToken, deviceId } = req.body;

    const validationOptions = {
      rawData: ["email", "newPassword", "resetToken"],
    };
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    // Find the user by email
    const user = await User.findOne({
      email: email.trim().toLowerCase(),
      resetToken: resetToken,
    });

    if (!user) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "no_valid",
      });
    }

    // Update the password and mark OTP as used
    user.password = newPassword;
    user.otpInfo.otpUsed = true; // Mark OTP as used
    user.otpInfo.otp = ""; // Clear OTP
    user.otpInfo.otpExpires = ""; // Clear OTP expiration
    user.resetToken = ""; // Clear OTP token

    await user.save();

    // Resetting the password logs every device out — including this one's previous
    // session — then issues a fresh session for the device that completed the reset.
    await revokeAllSessions({ userId: user._id });
    const { sessionId, refreshToken } = await createSession({ userId: user._id, deviceId });

    // Fetch the updated user with profile icon populated and generate a token simultaneously
    const [updatedUser, token] = await Promise.all([User.findById(user._id), user.generateAuthToken(sessionId)]);

    await syncProfileFlags(updatedUser);

    // Format the user response using the utility function
    const response = formatUserResponse(updatedUser, token);
    response.refreshToken = refreshToken;
    response.profile = (await attachProfile(user)).profile;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "password_has",
      data: response,
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_1",
      error: error,
    });
  }
};

// Change password for the logged-in user (requires current password)
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const validationOptions = {
      rawData: ["currentPassword", "newPassword"],
      minLengthFields: {
        newPassword: 6,
      },
    };
    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    // Non-string values (e.g. unquoted JSON numbers) pass validateParams
    // and its min-length check, but make bcrypt.compare throw.
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "invalid_password_format",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    const isMatch = user.password ? await bcrypt.compare(currentPassword, user.password) : false;
    if (!isMatch) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "incorrect_password",
      });
    }

    if (newPassword === currentPassword) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "new_password_same_as_old",
      });
    }

    user.password = newPassword;
    await user.save();

    userCache.del(user._id.toString());

    // Force every other device to log in again with the new password;
    // this device's own session (req.sessionId) stays valid.
    await revokeAllSessions({ userId: user._id, exceptSessionId: req.sessionId });

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "password_changed",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "an_error_1",
      error: error,
    });
  }
};

const logout = async (req, res) => {
  try {
    const { deviceId } = req.body;
    const userId = req.user._id;

    // Use $pull to remove the specific device from the devices array
    await Promise.all([
      Devices.updateOne(
        { userId: userId }, // Find the user by userId
        { $pull: { devices: { deviceId: deviceId } } }, // Remove the device with matching deviceId
      ),
      revokeSession({ userId, deviceId }), // Invalidate this device's token
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "logged_out",
    });
  } catch (err) {
    return sendResponse({
      res,
      statusCode: 400,
      translationKey: err.message,
      error: err.message,
    });
  }
};
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;
    const email = req.user.email;

    // Generate a random email using the userId and original email
    const randomEmail = `deleted_user_${userId}_${Date.now()}@example.com`;

    // Update the user's account state to hardDeleted and set the finalDeletionDate
    await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          email: randomEmail, // replace with random email
          previousEmail: email, // store the original email
          "accountState.status": "hardDeleted",
          "accountState.finalDeletionDate": new Date(), // set to now or your logic
        },
      },
      { new: true },
    );
    await Promise.all([
      Devices.updateOne(
        { userId: userId },
        { $set: { devices: [] } }, // This will empty the array of devices for the user
      ),
      UserProfile.updateOne(
        { user: userId },
        { $set: { status: "deleted" } }, // Mark the profile as deleted
      ),
      BusinessProfile.updateOne(
        { user: userId },
        { $set: { status: "deleted" } }, // Mark the business profile as deleted
      ),
      revokeAllSessions({ userId }), // Invalidate every device's token
    ]);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "account_deleted",
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message,
      error: error,
    });
  }
};

// Exchanges a still-valid refresh token for a new short-lived access token,
// so the client doesn't need to log in again every time the 1hr access token expires.
const refreshAccessToken = async (req, res) => {
  const { refreshToken } = req.body;

  if (!validateParams(req, res, { rawData: ["refreshToken"] })) {
    return;
  }

  try {
    const renewed = await renewSession({ refreshToken });
    if (!renewed) {
      return sendResponse({
        res,
        statusCode: 401,
        translationKey: "invalid_refresh_token",
      });
    }

    const user = await User.findById(renewed.userId).select("_id");
    if (!user) {
      return sendResponse({
        res,
        statusCode: 404,
        translationKey: "user_not",
      });
    }

    const token = user.generateAuthToken(renewed.sessionId, renewed.deviceType);

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "token_refreshed",
      data: { token, refreshToken: renewed.refreshToken },
    });
  } catch (error) {
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: "internal_server",
      error,
    });
  }
};

const socialAuth = async (req, res) => {
  const { provider, socialId, deviceId, deviceType, timezone, profileIcon, userType, language } = req.body;
  let { email, name } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const validationOptions = {
      rawData: ["provider", "socialId", "deviceId", "deviceType", "timezone"],
      enumFields: {
        provider: ["google", "facebook", "apple"], // Allowed values for provider
      },
    };

    if (!validateParams(req, res, validationOptions)) {
      return;
    }

    email = typeof email === "string" ? email.trim().toLowerCase() : "";
    name = typeof name === "string" ? name.trim() : "";

    // Apple only hands over the name/email on the very first authorization, and hands over
    // neither once the user hides them, so the provider id is the only field we can rely on.
    // Look the account up by it first and fall back to the email when one was sent.
    const existingUser =
      (await User.findOne({ [`${provider}Id`]: socialId })) || (email ? await User.findOne({ email }) : null);

    // A brand new account still needs an email — nothing to fall back on.
    if (!existingUser && !email) {
      return sendResponse({
        res,
        statusCode: 400,
        translationKey: "missing_raw_fields",
        values: { fields: "email" },
      });
    }

    // If user exists, update or link the social provider
    if (existingUser) {
      let providerLinked = false;

      if (existingUser.accountState.status === "restricted" || existingUser.accountState.status === "suspended") {
        return sendResponse({
          res,
          statusCode: 403,
          translationKey: "your_account_2",
        });
      }

      // userType is optional on login (same as /login): only enforce the role
      // check when the client actually asked for one.
      if (userType) {
        const roles = existingUser.accountState.roles || [];
        if (roles.length === 0) {
          // Legacy social signups were saved with roles: [] — grant the requested one
          existingUser.accountState.roles = [userType];
        } else if (!roles.includes(userType)) {
          return sendResponse({
            res,
            statusCode: 403,
            translationKey: `dont_have_profile_for_${userType}`,
          });
        }
        if (existingUser.accountState.userType !== userType) {
          existingUser.accountState.userType = userType;
        }
      }

      // Check if the social ID is already linked, if not, link it
      if (provider === "google" && !existingUser.googleId) {
        existingUser.googleId = socialId; // Link Google account
        providerLinked = true;
      } else if (provider === "facebook" && !existingUser.facebookId) {
        existingUser.facebookId = socialId; // Link Facebook account
        providerLinked = true;
      } else if (provider === "apple" && !existingUser.appleId) {
        existingUser.appleId = socialId; // Link Apple account
        providerLinked = true;
      }

      // Always update the provider and timezone, regardless of providerLinked status
      existingUser.provider = provider; // Update the provider field to reflect the latest social login
      existingUser.timezone = timezone; // Update the timezone to reflect the user's current login
      existingUser.accountState.status = "active"; // Ensure the account is active

      // Only fill these in — a later login from a provider that hides them must not blank them out
      if (name && !existingUser.name) {
        existingUser.name = name;
      }
      if (email && !existingUser.email) {
        existingUser.email = email;
      }

      if (profileIcon) {
        existingUser.profileIcon = profileIcon;
      }

      await existingUser.save({ session });

      await session.commitTransaction();
      session.endSession();

      // Same tail /login and verifyLoginOtp use, so a social login returns the
      // identical payload: profile attached (403 when it exists but is inactive),
      // resetToken excluded, flags synced, device recorded. Called after the
      // commit because it writes outside this session.
      return await completeLogin({ user: existingUser, deviceId, deviceType, res });
    } else {
      // If user does not exist, treat this as a signup.
      // userType/roles and language are seeded exactly as register() seeds them,
      // so the two signup responses carry the same accountState — left at the
      // schema defaults a social signup came back with roles: [] and always as a
      // customer, where an email signup returns ["user"] or ["business"].
      // Admin stays unreachable here: register gates it behind
      // x-admin-access-token *and* a password, and this route verifies neither
      // the social id nor a credential.
      const finalUserType = userType === "business" ? "business" : "user";
      const newUser = new User({
        email,
        name,
        provider, // Set the initial provider
        [`${provider}Id`]: socialId, // Dynamically store the provider ID
        timezone,
        language,
        verificationStatus: {
          email: "verified", // Mark email as verified
        },
        profileIcon,
        accountState: { userType: finalUserType, roles: [finalUserType] },
      });

      await newUser.save({ session });

      // Generate a token for the new user
      const { sessionId, refreshToken } = await createSession({ userId: newUser._id, deviceId, deviceType });
      const token = newUser.generateAuthToken(sessionId, deviceType);

      const response = formatUserResponse(newUser, token);
      response.refreshToken = refreshToken;

      // Save device information
      createOrSkipDevice(newUser._id, deviceId, deviceType);

      await session.commitTransaction();
      session.endSession();

      return sendResponse({
        res,
        statusCode: 201,
        translationKey: "signup_successful",
        data: response,
      });
    }
  } catch (error) {
    // Rollback transaction in case of any error — guarded because the login
    // branch commits before it responds, and aborting a committed session throws.
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    return sendResponse({
      res,
      statusCode: 500,
      translationKey: error.message,
      error: error,
    });
  }
};

module.exports = {
  register,
  login,
  generateOtp,
  verifyOtp,
  verifyLoginOtp,
  resetPassword,
  changePassword,
  logout,
  deleteAccount,
  socialAuth,
  refreshAccessToken,
};
