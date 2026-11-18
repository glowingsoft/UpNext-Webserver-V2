const Booking = require("@models/Bookings");
const { getInstantSettings } = require("@utils/instantPricing");

const contestNoShow = async ({ bookingId, businessId, note, now = new Date() }) => {
  if (!businessId) return { error: "no_show_cannot_contest", status: 409 };
  if (note !== undefined && typeof note !== "string") return { error: "invalid_request", status: 400 };
  const { noShowContestWindowHours } = await getInstantSettings();
  if (!Number.isFinite(noShowContestWindowHours) || noShowContestWindowHours <= 0 ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid no-show contest deadline");
  }
  const cutoff = new Date(now.getTime() - noShowContestWindowHours * 60 * 60 * 1000);
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      business: businessId,
      "noShow.status": "reported",
      "noShow.reportedAt": { $gte: cutoff, $lte: now },
    },
    { $set: { "noShow.status": "contested", "noShow.contestedAt": now, "noShow.contestNote": note || "" } },
    { new: true, runValidators: true },
  ).lean();
  if (!booking) return { error: "no_show_cannot_contest", status: 409 };
  return { data: { bookingId: booking._id, noShow: booking.noShow, arrived: booking.checkIns?.arrived || null } };
};

module.exports = { contestNoShow };
