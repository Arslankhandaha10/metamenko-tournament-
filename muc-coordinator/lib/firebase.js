/**
 * Initializes firebase-admin from the FIREBASE_SERVICE_ACCOUNT environment variable.
 * The variable must contain the entire service-account JSON document.
 *
 * Identical pattern to the Weekly Tournament coordinator so one repo-wide
 * GitHub Secret (FIREBASE_SERVICE_ACCOUNT) drives both modules.
 */
const admin = require('firebase-admin');

let app = null;

function init() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + e.message); }

  // Reuse default app when present (avoids "default app already exists" when the
  // Weekly Tournament coordinator and the MUC coordinator run in the same Action job).
  try {
    app = admin.app();
  } catch (_) {
    app = admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  return app;
}

function db() {
  init();
  return admin.firestore();
}

module.exports = { init, db, admin };
