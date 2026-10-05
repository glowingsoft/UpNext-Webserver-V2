/**
 * DB Bootstrap – versioned, safe, internal-only admin creation
 */

const mongoose = require("mongoose");
const { User } = require("@models/UserModel");
const AdminSettings = require("@models/AdminSettings");

const BOOTSTRAP_VERSION = process.env.BOOTSTRAP_VERSION || 1; // Increment this to trigger bootstrap again
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const bootstrapSchema = new mongoose.Schema(
    { version: { type: Number, default: 1 } },
    { timestamps: true } 
);

const Bootstrap =
    mongoose.models.SystemBootstrap ||
    mongoose.model("SystemBootstrap", bootstrapSchema);

const BOOTSTRAP_USERS = [
    {
        envEmail: "BOOTSTRAP_GUEST_EMAIL",
        envPassword: "BOOTSTRAP_GUEST_PASSWORD",
        name: "Guest User",
        userType: "guest",
    },
    {
        envEmail: "BOOTSTRAP_ADMIN_EMAIL",
        envPassword: "BOOTSTRAP_ADMIN_PASSWORD",
        name: "Admin",
        userType: "admin",
    },
];

async function runDBBootstrap() {
    try {
        const existing = await Bootstrap.findOne();
        if (existing?.version >= BOOTSTRAP_VERSION) {
            console.log("ℹ️ Bootstrap already up-to-date");
            return;
        }

        // Admin Settings
        if (!(await AdminSettings.findOne())) {
            await AdminSettings.create({
                terms_and_conditions: { en: "Your terms and conditions text here." },
                customer_terms_and_conditions: { en: "Your customer terms and conditions text here." },
                about_us: { en: "Information about us here." },
                privacy_policy: { en: "Your privacy policy text here." },
            });
            console.log("✅ Admin settings created");
        }
  
        // Bootstrap Users
        for (const { envEmail, envPassword, name, userType } of BOOTSTRAP_USERS) {
            const email = process.env[envEmail];
            const password = process.env[envPassword];

            if (!email || !password) continue;

            const exists = await User.findOne({
                email: email.toLowerCase(),
                "accountState.userType": userType,
            });

            if (exists) continue;

            try {
                await User.create({
                    name,
                    email: email.toLowerCase(),
                    password,
                    timezone: TIMEZONE,
                    accountState: { userType, status: "active" },
                    verificationStatus: { email: "verified", phoneNumber: "pending" },
                });
                console.log(`✅ ${userType} user created`);
            } catch (err) {
                console.error(`❌ Failed to create ${userType} user:`, err.message);
            }
        }

        // Mark bootstrap complete
        await Bootstrap.findOneAndUpdate(
            {},
            { $set: { version: BOOTSTRAP_VERSION } },
            { upsert: true }
        );
    } catch (err) {
        console.error("❌ DB bootstrap failed", err);
        throw err;
    }
}

module.exports = runDBBootstrap;
