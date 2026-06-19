/**
 * Pushes the Unity-side MucConfig to Firestore at most_used_card_config/active.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT='{"...":"..."}' node push-config.js path/to/MucConfig.json
 *
 * The JSON file must mirror MucConfig.cs field names (lowercase keys). The
 * Unity-side Tools menu can dump a MucConfig asset to JSON via Newtonsoft.
 */
const fs = require('fs');
const path = require('path');
const { db, init } = require('./lib/firebase');

async function main() {
  init();
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file) {
    console.error('Usage: node push-config.js path/to/MucConfig.json');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }

  await db().doc('most_used_card_config/active').set(cfg, { merge: true });
  console.log('[muc][push-config] Wrote most_used_card_config/active.');
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('[muc][push-config] FATAL:', e && (e.stack || e.message || e)); process.exit(1); });
