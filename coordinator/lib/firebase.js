/**
 * Initializes firebase-admin from the FIREBASE_SERVICE_ACCOUNT environment variable.
 * The variable must contain the entire service-account JSON document.
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

  app = admin.initializeApp({ credential: admin.credential.cert(creds) });
  return app;
}

function db() {
  init();
  return admin.firestore();
}

module.exports = { init, db, admin };
