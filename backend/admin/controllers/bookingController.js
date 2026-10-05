const { UserProfile } = require("@models/UserProfile");
const { sendResponse, validateParams, parsePaginationParams } = require("@utils/responseUtil");
const {
  getAllBookingsAdmin,
  getBookingById,
  paymentStatusLabel,
  bookingPriceBreakdown,
} = require("../../app/services/bookingService");

// GeoJSON Point + address, or null when the profile has no address saved —
// { coordinates: [0,0], address: "" } is the schema default, not a place.
const asLocation = (location) => {
  if (!location?.address && !location?.coordinates?.some(Boolean)) return null;
  return {
    address: location.address || "",
    coordinates: location.coordinates || [0, 0],
  };
};

// ─── Get all bookings (Admin) — global list across every business/customer ─
const getAllBookings = async (req, res) => {
  try {
    const { page, limit } = parsePaginationParams(req);
    const { status, scope, date, businessId, userId, keyword } = req.query;

    const { data, meta } = await getAllBookingsAdmin({
      page,
      limit,
      status,
      scope,
      date,
      businessId,
      userId,
      keyword,
      locale: req.language || req.user?.language,
    });

    const bookings = data.map((booking) => ({
      _id: booking._id,
      bookingId: booking.bookingId,
      client: {
        _id: booking.userInfo?._id,
        name: booking.userInfo?.name,
        profileIcon: booking.userInfo?.profileIcon,
      },
      service: booking.name,
      type: booking.preferredServiceType,
      requestedAt: booking.createdAt,
      date: booking.date,
      slot: booking.slot,
      status: booking.status,
      source: booking.source,
      payment: paymentStatusLabel(booking.paymentInfo?.status),
      // The raw Payment.status alongside the label the tab filters speak —
      // "pending" covers both an authorization hold and an untouched card.
      paymentStatus: booking.paymentInfo?.status ?? null,
      price: bookingPriceBreakdown(booking),
      // Same shape as `client` above — the panel links through to the business,
      // so it needs the profile id, and the row shows its avatar.
      provider: {
        _id: booking.businessInfo?._id,
        businessName: booking.businessInfo?.businessName,
        image: booking.businessInfo?.image,
      },
    }));

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "bookings_fetched",
      data: bookings,
      meta,
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

// ─── Get single booking (Admin) ─────────────────────────────────────────────
const getBooking = async (req, res) => {
  const { bookingId } = req.params;

  const validationOptions = { pathParams: ["bookingId"], objectIdFields: ["bookingId"] };
  if (!validateParams(req, res, validationOptions)) return;

  try {
    const {
      data: booking,
      error,
      status,
    } = await getBookingById({
      id: bookingId,
      userType: "admin",
      locale: req.language || req.user?.language,
      timezone: req.user?.timezone,
    });

    if (error) {
      return sendResponse({ res, statusCode: status || 404, translationKey: error });
    }

    // getBookingById already resolves the live rating onto target[0] (and the
    // booking's own review below) — recomputing it here was a second identical
    // Review aggregation per request.
    const target = booking.target?.[0];
    const rating = target?.rating || { avgRating: 0, totalReviews: 0 };

    // A booking has no location of its own — it happens either at the business
    // or at the customer's address, depending on the service type — so both
    // sides are surfaced and the panel picks by `bookedService.type`. The
    // business side rides along on the shared pipeline; the customer's lives on
    // UserProfile, which that pipeline deliberately doesn't join (it also
    // serves the business-facing endpoints).
    const customerProfile = booking.userInfo?._id
      ? await UserProfile.findOne({ user: booking.userInfo._id }).select("location").lean()
      : null;

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "booking_fetched",
      data: {
        _id: booking._id,
        bookingId: booking.bookingId,
        status: booking.status,
        source: booking.source,
        // Which collection bookedService._id points at — "service" | "package".
        scope: booking.scope,
        coverImage: booking.photos?.[0] || null,
        client: {
          _id: booking.userInfo?._id,
          name: booking.userInfo?.name,
          email: booking.userInfo?.email ?? null,
          profileIcon: booking.userInfo?.profileIcon,
          location: asLocation(customerProfile?.location),
        },
        provider: {
          _id: booking.businessInfo?._id,
          businessName: booking.businessInfo?.businessName,
          image: booking.businessInfo?.image,
          location: asLocation(booking.businessInfo?.location),
        },
        requestedAt: booking.createdAt,
        // Last status/payment transition — the list only carries requestedAt.
        updatedAt: booking.updatedAt,
        bookedService: {
          // The panel links through to the service/package; without the id it
          // could only match on name.
          _id: target?._id ?? null,
          name: booking.name,
          description: booking.description,
          type: booking.preferredServiceType,
          price: booking.price,
          durationMins: booking.sessionSlotMins,
          photos: booking.photos,
          rating,
        },
        date: booking.date,
        slot: booking.slot,
        payment: paymentStatusLabel(booking.paymentInfo?.status),
        paymentStatus: booking.paymentInfo?.status ?? null,
        price: bookingPriceBreakdown(booking),
        // Billing trail. Both are computed by flattenBookingDetails and were
        // being discarded: transactionId is the Stripe PaymentIntent id to
        // search on in the dashboard, platformFeeAmount our application fee
        // (stored in cents, already converted to major units there).
        transactionId: booking.transactionId ?? null,
        platformFeeAmount: Number((Number(booking.platformFeeAmount) || 0).toFixed(2)),
        // The review left for THIS booking, or null — reviewer already carries
        // a full profileIcon URL.
        review: booking.review ?? null,
      },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "internal_server", error });
  }
};

module.exports = {
  getAllBookings,
  getBooking,
};
