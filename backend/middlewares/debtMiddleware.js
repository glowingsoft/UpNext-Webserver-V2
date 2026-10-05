const { sendResponse } = require("@utils/responseUtil");
const { User } = require("@models/UserModel");
const { getOutstandingDebt } = require("../app/services/paymentService");

/**
 * Debt lock gatekeeper (spec Phase 4): a user whose capture failed cannot
 * check availability or create new bookings until the outstanding balance
 * is settled via the "Complete Payment" endpoint.
 * Reads the flag fresh from the DB — the cached auth user may be stale.
 */
const blockOutstandingDebt = async (req, res, next) => {
  try {
    if (req.user?.userType !== "user") return next();

    const dbUser = await User.findById(req.user._id).select("hasOutstandingDebt").lean();
    if (!dbUser?.hasOutstandingDebt) return next();

    // The flag only says "something is owed"; the list says what, so the block
    // screen can show every unpaid booking instead of one and a locked account
    // the customer can't reason about.
    const debt = await getOutstandingDebt(req.user._id);

    return sendResponse({
      res,
      statusCode: 403,
      translationKey: "outstanding_debt",
      data: {
        // Kept for older clients; same value the settle screen would default to.
        outstandingBooking: debt.bookings[0]?._id ?? null,
        outstandingDebt: debt,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = { blockOutstandingDebt };
