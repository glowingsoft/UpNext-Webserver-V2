const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

/**
 * Firebase Admin credentials come from the environment, not from a key file on
 * disk — a real service account key must never be committed, and the repo's
 * backend/secretAssets/serviceAccountKey.json was only ever a placeholder.
 *
 * Two ways to supply it, checked in this order:
 *
 *   1. FIREBASE_SERVICE_ACCOUNT — the whole service-account JSON. Base64 is
 *      the easy form in a .env file (one line, no quoting, no escaped
 *      newlines); raw JSON works too and is detected by its leading "{".
 *
 *   2. FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY —
 *      the only three fields the SDK actually needs, set individually.
 *
 * Missing or unparseable config is not fatal: the SDK is left uninitialized
 * and the app boots without push, exactly as it did with the placeholder file.
 *
 * Note the imports: firebase-admin v14 removed the old `admin.credential.cert`
 * / `admin.messaging()` namespace in favour of these per-feature entry points.
 */

// A private key pasted into .env carries literal backslash-n rather than real
// line breaks; the PEM parser needs them turned back into newlines.
const restoreNewlines = (key) => (typeof key === "string" ? key.replace(/\\n/g, "\n") : key);

const parseServiceAccountJson = (raw) => {
  const trimmed = raw.trim();
  // Raw JSON starts with "{"; anything else is treated as base64.
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
};

// Accepts either the snake_case shape of a downloaded key file or the
// camelCase shape cert() documents.
const toCredential = (account) => ({
  projectId: account.project_id || account.projectId,
  clientEmail: account.client_email || account.clientEmail,
  privateKey: restoreNewlines(account.private_key || account.privateKey),
});

const loadCredential = () => {
  const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountEnv && serviceAccountEnv.trim()) {
    return toCredential(parseServiceAccountJson(serviceAccountEnv));
  }

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID || FIREBASE_CLIENT_EMAIL || FIREBASE_PRIVATE_KEY) {
    return toCredential({
      project_id: FIREBASE_PROJECT_ID,
      client_email: FIREBASE_CLIENT_EMAIL,
      private_key: FIREBASE_PRIVATE_KEY,
    });
  }

  return null;
};

try {
  const credential = loadCredential();

  if (!credential) {
    console.warn(
      "Firebase Admin skipped — set FIREBASE_SERVICE_ACCOUNT (service-account JSON, raw or base64) or " +
        "FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY in .env. Push notifications are disabled.",
    );
  } else if (!credential.projectId || !credential.clientEmail || !credential.privateKey) {
    // A half-filled key (the empty-string fields of a template) would only
    // fail later inside messaging() — say so now, at boot, where it's visible.
    const missing = ["projectId", "clientEmail", "privateKey"].filter((field) => !credential[field]);
    console.warn(
      `Firebase Admin skipped — service account is missing: ${missing.join(", ")}. Push notifications are disabled.`,
    );
  } else {
    initializeApp({ credential: cert(credential) });
    console.log(`Firebase Admin initialized (project: ${credential.projectId})`);
  }
} catch (error) {
  // Never let bad credentials take the server down — push degrades, the API
  // keeps serving. The messaging() calls are already inside try blocks.
  console.error("Firebase Admin initialization failed — push notifications are disabled:", error.message);
}

const isInitialized = () => getApps().length > 0;

module.exports = {
  // Same call shape the senders already use: adminFireBConfig.messaging().
  // Throws if the SDK never initialized, which the callers already handle.
  messaging: () => getMessaging(),
  isInitialized,
};
