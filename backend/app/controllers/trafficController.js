const Traffic = require("@models/Traffic");
const { sendResponse, validateParams } = require("@utils/responseUtil");

const SOURCE_PATTERNS = [
  ["google", /google\./i],
  ["facebook", /facebook\.|fb\.|fbclid/i],
  ["instagram", /instagram\./i],
  ["twitter", /twitter\.|t\.co$|x\.com/i],
  ["whatsapp", /whatsapp|wa\.me/i],
];

const SOURCE_KEYS = ["google", "facebook", "instagram", "twitter", "whatsapp", "mobile", "other", "direct"];

// Explicit `source` (query/body) wins, then the Referer host, then the user agent.
const detectSource = (req) => {
  const explicit = String(req.query?.source || req.body?.source || "").toLowerCase();
  if (explicit) return SOURCE_KEYS.includes(explicit) ? explicit : "other";

  const referer = req.get("referer") || req.get("referrer") || "";
  if (referer) {
    let host = referer;
    try {
      host = new URL(referer).hostname;
    } catch {
      // keep the raw header
    }
    const match = SOURCE_PATTERNS.find(([, re]) => re.test(host));
    return match ? match[0] : "other";
  }

  return /mobile|android|iphone/i.test(req.get("user-agent") || "") ? "mobile" : "direct";
};

// Public: records one visit to a profile and bumps the per-source counter.
const recordVisit = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["profileId"], objectIdFields: ["profileId"] })) return;

  try {
    const source = detectSource(req);
    const traffic = await Traffic.findOneAndUpdate(
      { profileId: req.params.profileId },
      {
        $inc: { totalVisits: 1, [`sources.${source}`]: 1 },
        $set: { lastSource: source, lastIp: req.ip, lastVisitedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "traffic_recorded",
      data: { totalVisits: traffic.totalVisits },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "traffic_record_error", error });
  }
};

// Public: read the traffic counters for a profile.
const getTraffic = async (req, res) => {
  if (!validateParams(req, res, { pathParams: ["profileId"], objectIdFields: ["profileId"] })) return;

  try {
    const traffic = await Traffic.findOne({ profileId: req.params.profileId })
      .select("profileId totalVisits sources lastSource lastVisitedAt -_id")
      .lean();

    return sendResponse({
      res,
      statusCode: 200,
      translationKey: "traffic_fetched",
      data: traffic || { profileId: req.params.profileId, totalVisits: 0, sources: {} },
    });
  } catch (error) {
    return sendResponse({ res, statusCode: 500, translationKey: "traffic_record_error", error });
  }
};

module.exports = { recordVisit, getTraffic };
