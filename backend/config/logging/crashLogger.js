const crypto = require("crypto");

const recentCrashes = new Map();
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function fingerprint(err) {
  return crypto
    .createHash("sha1")
    .update(
      (err?.name || "") +
      (err?.message || "") +
      (err?.stack || "")
    )
    .digest("hex");
}

function shouldAlert(fp) {
  const now = Date.now();
  const last = recentCrashes.get(fp);

  if (last && now - last < DEDUPE_WINDOW_MS) {
    return false;
  }

  recentCrashes.set(fp, now);
  return true;
}

function logCrash({ type, error }) {
  const fp = fingerprint(error);

  const payload = {
    time: new Date().toISOString(),
    type,
    pid: process.pid,
    workerId: process.env.NODE_APP_INSTANCE,
    fingerprint: fp,
    message: error?.message,
    stack: error?.stack,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  };

  console.error(JSON.stringify(payload));

  if (shouldAlert(fp)) {
    // sendSlack(payload)
    // sendEmail(payload)
    // sendAzureMonitor(payload)
  }
}

/**
 * Fatal logger wrapper
 */
function fatal(type, error) {
  logCrash({
    type,
    error: error instanceof Error ? error : new Error(JSON.stringify(error)),
  });
}

module.exports = {
  logCrash,
  fatal,
};
