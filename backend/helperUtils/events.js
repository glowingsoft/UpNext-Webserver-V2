const axios = require("axios");

const DEFAULT_EVENTS_PAGE = 1;
const DEFAULT_EVENTS_LIMIT = 5;
const DEFAULT_EVENTS_UNIT = "km";
const fetchEvents = async (params = {}) => {
  const { page = DEFAULT_EVENTS_PAGE, limit = DEFAULT_EVENTS_LIMIT, keyword, lat, lng, date } = params;

  const geoPoint = lat && lng ? `${lat},${lng}` : undefined;

  const apiKey = process.env.TICKETMASTER_API_KEY || "o5G3JW9CBaVciIq8seXtfOwIVyc2Xbj1";

  const baseUrl = process.env.TICKETMASTER_BASE_URL || "https://app.ticketmaster.com/discovery/v2/events.json";

  // No radius: the caller's point alone scopes the search, and Ticketmaster
  // applies its own default spread around it.
  const queryParams = {
    apikey: apiKey,
    page: Number(page) - 1,
    size: Number(limit),
    unit: DEFAULT_EVENTS_UNIT,
  };
  if (date) {
    queryParams.startDateTime = date + "T00:00:00Z";
    queryParams.endDateTime = date + "T23:59:59Z";
  }

  if (geoPoint) queryParams.geoPoint = geoPoint;
  if (keyword) queryParams.keyword = keyword;
  const response = await axios.get(baseUrl, { params: queryParams });
  const data = response.data;

  const events = (data._embedded?.events || []).map((event) => ({
    id: event.id,
    name: event.name,
    type: event.type,
    date: event.dates?.start?.localDate,
    time: event.dates?.start?.localTime,
    venue: event._embedded?.venues?.[0]?.name,
    city: event._embedded?.venues?.[0]?.city?.name,
    state: event._embedded?.venues?.[0]?.state?.stateCode,
    country: event._embedded?.venues?.[0]?.country?.countryCode,
    // Measured by Ticketmaster from the geoPoint, in the unit we asked for (km).
    // Absent when the caller sent no lat/lng — nothing to measure from.
    distance: event.distance ?? null,
    unit: event.units ?? null,
    image: event.images?.[0]?.url || null,
    link: event.url || event.outlets?.[0]?.url || null,
    genre: event.classifications?.[0]?.genre?.name,
    segment: event.classifications?.[0]?.segment?.name,
    subGenre: event.classifications?.[0]?.subGenre?.name,
  }));

  return {
    data: events,
    meta: {
      totalPages: data.page?.totalPages || 1,
      totalRecords: data.page?.totalElements || events.length,
      currentPage: Number(page),
      limit: Number(limit),
    },
  };
};
module.exports = {
  fetchEvents,
};
