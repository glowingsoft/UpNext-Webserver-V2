/**
 * Driving/walking distance from the caller to a business, via the Google
 * Routes API (computeRouteMatrix).
 *
 * Every distance this backend reports is the same pair: the caller's lat/lng
 * to one BusinessProfile's coordinates. Services, packages, promotions and
 * bookings all borrow the business's location — none has one of its own — so a
 * single enrichment pass serves every `distanceKm` in every response.
 *
 * The aggregation pipelines still compute the straight-line `distanceKm`
 * (`haversineKmExpr` in @utils/aggregationHelper) exactly as before: it is
 * free, it is what `nearestFirstStages` sorts on before pagination, and it is
 * the fallback whenever routing is unavailable. This module runs *after* the
 * query, over the page that is about to be sent, and overwrites `distanceKm`
 * with the road distance, tagging each one with `distanceMode`.
 *
 * A reported distance is always a real route: `distanceMode` is only ever
 * "driving" or "walking". Where Google answers that neither exists, the
 * distance is dropped from the response entirely rather than falling back to a
 * straight line the caller can't actually travel — an omitted `distanceKm` is
 * already what the pipelines emit when there is no distance to report.
 */

// Required lazily and relatively: responseUtil pulls this module in, and that
// is loaded from everywhere — this must not force the Redis client to connect
// at require time, nor depend on module-alias already being registered.
const redisCache = () => require("../config/redis/redisCache");

const ROUTE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

// Two fixed points don't drift apart and the road network between them rarely
// changes, so a resolved route stays good for a long time.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

// The caller's position is rounded before it becomes a cache key, so everyone
// within ~110 m shares one cached route instead of each paying for their own.
// The business end is rounded far finer — it is a fixed point, and collapsing
// two neighbouring businesses onto one key would report the wrong distance.
const ORIGIN_PRECISION = 3;
const DEST_PRECISION = 5;

// Distance is the lower of the driving and walking route — but only where
// walking is a real option. Walking routes are almost always the shorter of
// the two (pedestrian cut-throughs, no one-way restrictions), and Google will
// happily return one for a 178 km trek across an international border that it
// refuses to give driving directions for, so without a ceiling "lowest" means
// "walking" essentially always. Beyond this range only driving counts.
const WALKING_MAX_KM = Number(process.env.ROUTE_WALKING_MAX_KM) || 2;

// computeRouteMatrix caps a WALK request at 100 elements. One origin means one
// element per destination, and 50 leaves plenty of headroom.
const MAX_DESTINATIONS_PER_CALL = 50;

// A slow routing call must never hold a response open; on abort the page falls
// back to the straight-line distance it already had.
const REQUEST_TIMEOUT_MS = 4000;

const routeDistancesEnabled = () => !!process.env.GOOGLE_MAPS_API_KEY;

// GeoJSON order: [lng, lat]. [0, 0] is the locationSchema default — a business
// that never set a location, not a place in the Gulf of Guinea — so it is
// dropped rather than spent as a billable element.
const isValidCoords = (coords) =>
  Array.isArray(coords) &&
  coords.length === 2 &&
  Number.isFinite(coords[0]) &&
  Number.isFinite(coords[1]) &&
  Math.abs(coords[0]) <= 180 &&
  Math.abs(coords[1]) <= 90 &&
  !(coords[0] === 0 && coords[1] === 0);

const coordKey = (coords, precision) => coords.map((n) => n.toFixed(precision)).join(",");

const cacheKey = (travelMode, originKey, destKey) => `routedist:${travelMode}:${originKey}:${destKey}`;

/**
 * Walks a response payload and returns every node carrying a `distanceKm`
 * alongside resolvable coordinates. Covers all the shapes the pipelines emit:
 * `business.distanceKm` (servicePipeline), a top-level `distanceKm` beside
 * `location` (packagePipeline, businessHelperPipeline, promotion targets),
 * `businessInfo.distanceKm` (getBookingById), and homeController's relocated
 * `location.distanceKm` — where the node holding the distance is the location
 * object itself, so `coordinates` is read off the node before its `location`.
 */
const collectDistanceNodes = (payload) => {
  const nodes = [];
  const seen = new Set();

  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value instanceof Date || Buffer.isBuffer(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value.distanceKm === "number") {
      const coords = Array.isArray(value.coordinates) ? value.coordinates : value.location?.coordinates;
      if (isValidCoords(coords)) nodes.push({ node: value, coords, key: coordKey(coords, DEST_PRECISION) });
    }

    for (const key of Object.keys(value)) visit(value[key]);
  };

  visit(payload);
  return nodes;
};

const toWaypoint = ([lng, lat]) => ({ waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } });

/**
 * One matrix call. Returns the element array, or null when the call itself
 * failed — the caller must not cache a transport failure as "no route".
 */
const fetchMatrix = async (origin, destinations, travelMode) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body = {
      origins: [toWaypoint(origin)],
      destinations: destinations.map(toWaypoint),
      travelMode,
    };
    // routingPreference is rejected outright on a WALK request
    if (travelMode === "DRIVE") body.routingPreference = "TRAFFIC_UNAWARE";

    const response = await fetch(ROUTE_MATRIX_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        // destinationIndex is required: elements can come back out of order
        "X-Goog-FieldMask": "destinationIndex,distanceMeters,condition",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(`[routeDistance] ${travelMode} matrix ${response.status}: ${await response.text()}`);
      return null;
    }

    const elements = await response.json();
    return Array.isArray(elements) ? elements : null;
  } catch (error) {
    console.error(`[routeDistance] ${travelMode} matrix error: ${error?.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolves one travel mode for every destination: Redis first, then batched
 * matrix calls for whatever is left. Returns destKey -> km, where a stored
 * null means "asked, and no such route exists" (worth remembering) as opposed
 * to an absent key, which means "couldn't ask" and falls back to haversine.
 */
const resolveMode = async ({ origin, originKey, destinations, travelMode }) => {
  const resolved = new Map();

  const cached = await Promise.all(destinations.map((dest) => redisCache().getJson(cacheKey(travelMode, originKey, dest.key))));

  const misses = [];
  destinations.forEach((dest, index) => {
    if (cached[index]) resolved.set(dest.key, cached[index].km);
    else misses.push(dest);
  });

  for (let i = 0; i < misses.length; i += MAX_DESTINATIONS_PER_CALL) {
    const chunk = misses.slice(i, i + MAX_DESTINATIONS_PER_CALL);
    const elements = await fetchMatrix(
      origin,
      chunk.map((dest) => dest.coords),
      travelMode,
    );
    // Transport failure — leave these unresolved rather than poisoning the
    // cache with a 30-day "no route"
    if (!elements) continue;

    const fresh = new Map(chunk.map((dest) => [dest.key, null]));
    for (const element of elements) {
      const dest = chunk[element?.destinationIndex];
      if (!dest) continue;
      const hasRoute = element.condition === "ROUTE_EXISTS" && Number.isFinite(element.distanceMeters);
      fresh.set(dest.key, hasRoute ? element.distanceMeters / 1000 : null);
    }

    await Promise.all(
      [...fresh].map(([key, km]) => {
        resolved.set(key, km);
        return redisCache().setJson(cacheKey(travelMode, originKey, key), { km }, CACHE_TTL_SECONDS);
      }),
    );
  }

  return resolved;
};

// Lowest of the two, as specified; either side may be missing.
const pickLowest = (drivingKm, walkingKm) => {
  const candidates = [];
  if (Number.isFinite(drivingKm)) candidates.push({ km: drivingKm, mode: "driving" });
  if (Number.isFinite(walkingKm)) candidates.push({ km: walkingKm, mode: "walking" });
  if (!candidates.length) return null;
  return candidates.reduce((lowest, candidate) => (candidate.km < lowest.km ? candidate : lowest));
};

/**
 * Overwrites every `distanceKm` in `payload` with the shorter of its driving
 * and walking route distance, and stamps `distanceMode` ("driving"/"walking")
 * on each. Where Google reports no route either way, `distanceKm` is removed;
 * where routing couldn't be reached, the straight-line value is left alone
 * with no `distanceMode`. Mutates in place; never throws.
 */
const attachRouteDistances = async ({ lat, lng, payload }) => {
  if (!routeDistancesEnabled()) return;

  const origin = [Number(lng), Number(lat)];
  if (!isValidCoords(origin)) return;

  const nodes = collectDistanceNodes(payload);
  if (!nodes.length) return;

  // A page of 10 services often comes from far fewer businesses, and each
  // distinct business is one billable element, not one per row.
  const destinations = [...new Map(nodes.map((entry) => [entry.key, entry])).values()].map(({ key, coords }) => ({
    key,
    coords,
  }));
  const originKey = coordKey(origin, ORIGIN_PRECISION);

  const [driving, walking] = await Promise.all([
    resolveMode({ origin, originKey, destinations, travelMode: "DRIVE" }),
    resolveMode({ origin, originKey, destinations, travelMode: "WALK" }),
  ]);

  for (const { node, key } of nodes) {
    const walkingKm = walking.get(key);
    const inWalkingRange = Number.isFinite(walkingKm) && walkingKm <= WALKING_MAX_KM;
    const best = pickLowest(driving.get(key), inWalkingRange ? walkingKm : null);

    if (best) {
      node.distanceKm = Math.round(best.km * 10) / 10;
      node.distanceMode = best.mode;
      continue;
    }

    // No usable route. Only drop the distance when Google actually answered
    // for both modes — that is a real "you cannot travel this", as with the
    // India/Pakistan border, where there is no driving route at all and the
    // walking one runs 178 km. If either call never landed (quota, timeout,
    // Redis and the API both cold) we simply don't know, so the pipeline's
    // straight-line value stays put, unlabelled, exactly as it was before
    // routing existed — an outage must not blank every distance in the app.
    if (driving.has(key) && walking.has(key)) {
      delete node.distanceKm;
      delete node.distanceMode;
    }
  }
};

/**
 * Re-orders an already-enriched list nearest-first on the route distances.
 *
 * This reorders the page, it does not re-pick it: `nearestFirstStages` still
 * runs inside the aggregation on the straight-line `distanceKm`, because that
 * sort has to happen before `paginationPipeline` and route distances only
 * exist after the page has been chosen. Road distance tracks straight-line
 * distance closely enough that the two orderings rarely disagree, but a row
 * whose route doubles back can legitimately belong on the previous page.
 *
 * Rows with no distance left — Google answered "unreachable" and the key was
 * dropped — sort last, the same place `NO_DISTANCE_SORT_KEY` puts them.
 */
const sortNearestFirst = (payload) => {
  if (!Array.isArray(payload) || payload.length < 2) return;

  const keyed = payload.map((item, index) => {
    // An item's distance lives in a different place per pipeline
    // (`business.distanceKm` vs a top-level one), so take the lowest of
    // whatever the walk finds rather than guessing at the shape.
    let distance = Infinity;
    for (const { node } of collectDistanceNodes(item)) {
      if (node.distanceKm < distance) distance = node.distanceKm;
    }
    return { item, index, distance };
  });

  // Ties fall back to the incoming index, so rows the pipeline ordered by
  // rating or recency keep that order among themselves.
  keyed.sort((a, b) => a.distance - b.distance || a.index - b.index);
  keyed.forEach(({ item }, index) => {
    payload[index] = item;
  });
};

module.exports = {
  attachRouteDistances,
  collectDistanceNodes,
  routeDistancesEnabled,
  sortNearestFirst,
};
