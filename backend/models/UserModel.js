const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const validator = require("validator");
const { randomBytes } = require("crypto");

// Define subscription statuses
const SubscriptionType = {
  PLAN1: "plan1", //free
  PLAN2: "plan2", //monthly
  PLAN3: "plan3", // yearly
};

// Define subscription schema
const subscriptionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: Object.values(SubscriptionType),
    required: true,
    default: SubscriptionType.PLAN1, // Default subscription for all users
  },
  startDate: {
    type: Date,
    default: Date.now, // Start date defaults to now for other subscriptions
  },
  endDate: {
    type: Date, // Can be null for lifetime subscriptions (like spark connection)
  },
});

const userSchema = new mongoose.Schema(
  {
    profileIcon: {
      type: String,
      default: "",
    },

    name: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      required: [true, "email_required"], // Generic error message key
      unique: true,
      validate: {
        validator: function (value) {
          return validator.isEmail(value);
        },
        message: "email_invalid", // Generic error message key
      },
    },
    previousEmail: {
      // replaced with email when user is deleted
      type: String,
      default: "",
    },
    phoneNumber: {
      type: String,
      default: "",
    },

    verificationStatus: {
      email: {
        type: String,
        enum: ["pending", "verified", "rejected"],
        default: "pending",
      },
      phoneNumber: {
        type: String,
        enum: ["pending", "verified", "rejected"],
        default: "pending",
      },
    },

    password: {
      type: String,
      default: "",
    },
    accountState: {
      userType: {
        type: String,
        enum: ["user", "business", "admin", "guest"],
        default: "user",
      },
      roles: {
        type: [String],
        default: [],
      },
      hasUserProfile: {
        type: Boolean,
        default: false,
      },
      hasBusinessProfile: {
        type: Boolean,
        default: false,
      },
      status: {
        type: String,
        enum: ["active", "inactive", "suspended", "softDeleted", "hardDeleted", "restricted","pending"],
        default: "active",
      },
      reason: {
        type: String,
        default: "",
      },
      suspensionDate: {
        type: Date,
      },
      finalDeletionDate: {
        type: Date, // field to keep track of final deletion date
      },
    },

    otpInfo: {
      emailOtp: {
        otp: {
          type: String,
          default: "",
        },
        otpUsed: {
          type: Boolean,
          default: false,
        },
        otpExpires: {
          type: Date,
        },
        otpRequestCount: {
          type: Number,
          default: 0,
        },
        otpRequestTimestamp: {
          type: Date,
          default: Date.now,
        },
      },
      phoneNumberOtp: {
        otp: {
          type: String,
          default: "",
        },
        otpUsed: {
          type: Boolean,
          default: false,
        },
        otpExpires: {
          type: Date,
        },
        otpRequestCount: {
          type: Number,
          default: 0,
        },
        otpRequestTimestamp: {
          type: Date,
          default: Date.now,
        },
      },
      // Kept separate from emailOtp so a 2FA login/enrollment code never
      // collides with an in-flight registration or password-reset OTP
      twoFactorOtp: {
        otp: {
          type: String,
          default: "",
        },
        otpUsed: {
          type: Boolean,
          default: false,
        },
        otpExpires: {
          type: Date,
        },
        otpRequestCount: {
          type: Number,
          default: 0,
        },
        otpRequestTimestamp: {
          type: Date,
          default: Date.now,
        },
      },
    },

    resetToken: {
      //used to reset password
      type: String,
      default: "",
    },
    timezone: {
      type: String,
      default: "",
      required: true,
    },
    language: {
      type: String,
      default: "en",
    },

    blockedUsers: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },
    reportCount: {
      type: Number,
      default: 0,
    },
    reportedBy: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },

    // Subscription Details
    // subscriptions: {
    //   type: [subscriptionSchema],
    //   default: [
    //     {
    //       status: SubscriptionType.PLAN1,
    //       startDate: null,
    //       endDate: null, // No expiry for the default subscription
    //     },
    //   ],
    // },

    provider: {
      // Social provider details
      type: String,
      enum: ["google", "facebook", "apple", "email"], // Provider types
      default: "email",
    },
    googleId: {
      type: String,
      default: null,
      index: true, // social login resolves the account by provider id
    },
    facebookId: {
      type: String,
      default: null,
      index: true, // social login resolves the account by provider id
    },
    appleId: {
      type: String,
      default: null,
      index: true, // social login resolves the account by provider id
    },
    currency: {
      type: String,
      default: "usd",
    },
    stripe: {
      accountId: String,
      customerId: String,
      onboardingComplete: Boolean,
      chargesEnabled: Boolean,
      payoutsEnabled: Boolean,
    },
    security: {
      twoFactorEnabled: {
        type: Boolean,
        default: false,
      },
    },
    // Debt state, kept in sync by syncDebtLock in @services/paymentService.
    // The bookings themselves (paymentStatus "failed") remain the source of
    // truth — these are a mirror so the user document shows the whole picture
    // rather than a single id, and so the booking gate can skip a query.
    // Set when an instant-booking hold is declined; cleared by the next
    // successful hold. Blocks new instant bookings only.
    instantBlocked: {
      type: Boolean,
      default: false,
    },
    hasOutstandingDebt: {
      type: Boolean,
      default: false,
    },
    // Every unpaid booking, oldest first. Replaces relying on the single field
    // below, which could only ever hold the most recent failure.
    outstandingBookings: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Booking" }],
      default: [],
    },
    // Total still owed across outstandingBookings.
    outstandingAmount: {
      type: Number,
      default: 0,
    },
    // The one to settle next (oldest unpaid) — retained so existing clients
    // reading a single booking id keep working.
    outstandingBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Hash password before saving to database
userSchema.pre("save", async function (next) {
  const user = this;
  if (this.phoneNumber === "") {
    this.phoneNumber = null;
  }
  if (user.isModified("password")) {
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(user.password, salt);
  }
  // Convert the email to lowercase before saving
  if (user.isModified("email")) {
    user.email = user.email.toLowerCase().trim();
  }

  next();
});

// Generate JWT token
userSchema.methods.generateAuthToken = function (sessionId, deviceType) {
  const user = this;
  const token = jwt.sign({ _id: user._id, sid: sessionId, deviceType }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return token;
};

// Find user by credentials
userSchema.statics.findByCredentials = async (email, password) => {
  const user = await User.findOne({ email: email });

  if (!user) {
    return { error: "user_not_found" }; // Return an error key if user not found
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return { error: "incorrect_password" }; // Return an error key if password doesn't match
  }

  return user; // Return the user object if login is successful
};

userSchema.methods.generateOtp = function (type = "email", timezone = "UTC") {
  const user = this;
  const now = Date.now();

  // Generate the OTP using randomBytes for security
  const otp = (parseInt(randomBytes(3).toString("hex"), 16) % 1000000).toString().padStart(6, "0");

  // Set OTP expiry: 10 minutes for email/2FA, 5 minutes for phone
  const otpExpires = moment
    .tz(now, timezone)
    .add(type === "phoneNumber" ? 5 : 10, "minutes")
    .valueOf();

  // Update OTP details based on the type
  if (type === "email") {
    user.otpInfo.emailOtp.otp = otp;
    user.otpInfo.emailOtp.otpExpires = otpExpires;
    user.otpInfo.emailOtp.otpUsed = false;
  } else if (type === "phoneNumber") {
    user.otpInfo.phoneNumberOtp.otp = otp;
    user.otpInfo.phoneNumberOtp.otpExpires = otpExpires;
    user.otpInfo.phoneNumberOtp.otpUsed = false;
  } else if (type === "twoFactor") {
    user.otpInfo.twoFactorOtp.otp = otp;
    user.otpInfo.twoFactorOtp.otpExpires = otpExpires;
    user.otpInfo.twoFactorOtp.otpUsed = false;
  }

  return otp; // Return the OTP for sending it to the user
};

// Please Use the Rate Limited One On Production
// userSchema.methods.generateOtp = function (type = "email", timezone = "UTC") {
//   const user = this;
//   const now = Date.now();
//   const allowedOtpRequests = 3;
//
//   let otpRequestCount, otpRequestTimestamp;
//
//   if (type === "email") {
//     otpRequestCount = user.otpInfo.emailOtp.otpRequestCount;
//     otpRequestTimestamp = user.otpInfo.emailOtp.otpRequestTimestamp;
//   } else if (type === "phoneNumber") {
//     otpRequestCount = user.otpInfo.phoneNumberOtp.otpRequestCount;
//     otpRequestTimestamp = user.otpInfo.phoneNumberOtp.otpRequestTimestamp;
//   }
//
//   const timeLimit = moment(otpRequestTimestamp).add(1, "hour").valueOf();
//   if (now > timeLimit) {
//     if (type === "email") {
//       user.otpInfo.emailOtp.otpRequestCount = 0;
//       user.otpInfo.emailOtp.otpRequestTimestamp = now;
//     } else if (type === "phoneNumber") {
//       user.otpInfo.phoneNumberOtp.otpRequestCount = 0;
//       user.otpInfo.phoneNumberOtp.otpRequestTimestamp = now;
//     }
//   } else if (otpRequestCount >= allowedOtpRequests) {
//     if (process.env.NODE_ENV == "prod") {
//       return { error: "too_many_otp_requests" };
//     }
//   }
//
//   if (type === "email") {
//     user.otpInfo.emailOtp.otpRequestCount += 1;
//   } else if (type === "phoneNumber") {
//     user.otpInfo.phoneNumberOtp.otpRequestCount += 1;
//   }
//
//   const otp = (parseInt(randomBytes(3).toString("hex"), 16) % 1000000).toString().padStart(6, "0");
//
//   const otpExpires = moment
//     .tz(now, timezone)
//     .add(type === "email" ? 10 : 5, "minutes")
//     .valueOf();
//
//   if (type === "email") {
//     user.otpInfo.emailOtp.otp = otp;
//     user.otpInfo.emailOtp.otpExpires = otpExpires;
//     user.otpInfo.emailOtp.otpUsed = false;
//   } else if (type === "phoneNumber") {
//     user.otpInfo.phoneNumberOtp.otp = otp;
//     user.otpInfo.phoneNumberOtp.otpExpires = otpExpires;
//     user.otpInfo.phoneNumberOtp.otpUsed = false;
//   }
//
//   return otp;
// };

const generateResetToken = () => {
  return randomBytes(32).toString("hex"); // 64-character token
};

const User = mongoose.models.User || mongoose.model("User", userSchema);

module.exports = { User, SubscriptionType, generateResetToken };
