#!/usr/bin/env node
/**
 * push-config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot uploader for the Weekly Tournament configuration document.
 *
 * Pairs with the Unity editor menu:
 *   Tools → Weekly Tournament → Save Selected Config JSON to Coordinator
 *
 * Editor writes:
 *   ./config.json     ← the WtConfig payload (numbers, bands, flags…)
 *   ./config.docpath  ← single line, e.g. "tournament_config/active"
 *
 * This script reads those, validates the payload shape, and writes the doc
 * with `set()` (full overwrite) so the coordinator (tick.js) and Firestore
 * security rules see the same source of truth as the Unity client.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" npm run push-config
 *   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node push-config.js
 *   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node push-config.js --path tournament_config/active
 *   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node push-config.js --file ./other-config.json
 *   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node push-config.js --dry-run
 *
 * Service account env-var is the SAME one tick.js uses, so any setup that
 * already runs the coordinator locally also runs this script.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
// firebase-admin is lazy-loaded inside main() so --help / --dry-run still work
// before `npm install` has been run.

const DEFAULT_DOC_PATH = 'tournament_config/active';
const DEFAULT_JSON_FILE = 'config.json';
const DOCPATH_FILE = 'config.docpath';

// ─── arg parsing (tiny — avoid pulling in a CLI dep) ────────────────────────
function parseArgs(argv) {
  const out = { jsonFile: null, docPath: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--file' || a === '-f') out.jsonFile = argv[++i];
    else if (a === '--path' || a === '-p') out.docPath = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('-') && !out.jsonFile) out.jsonFile = a;
    else if (!a.startsWith('-') && !out.docPath) out.docPath = a;
    else { console.error(`✗ Unknown argument: ${a}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: npm run push-config [-- options]
   or: node push-config.js [options]

Options:
  -f, --file <path>      JSON file to push (default: ./${DEFAULT_JSON_FILE})
  -p, --path <coll/doc>  Firestore document path (default: from ./${DOCPATH_FILE} or "${DEFAULT_DOC_PATH}")
      --dry-run          Validate + print what would be written; do not push
  -h, --help             Show this help

Environment:
  FIREBASE_SERVICE_ACCOUNT   JSON string of the service-account key (same one tick.js uses)
`);
}

// ─── validation ─────────────────────────────────────────────────────────────
const REQUIRED_FIELDS = [
  'tournamentType',
  'cycleDurationDays',
  'maxParticipants',
  'rootCollection'
];

function validatePayload(json) {
  const missing = REQUIRED_FIELDS.filter(k => !(k in json));
  if (missing.length) {
    return `Missing expected WtConfig fields: ${missing.join(', ')}.\n` +
           '  Did you generate config.json via the Unity editor menu?';
  }
  if (json.maxParticipants <= 0) {
    return `maxParticipants must be > 0 (got ${json.maxParticipants}).`;
  }
  // ELO bands sanity (only if multi-room is on).
  if (json.multiRoomEnabled && Array.isArray(json.eloBands)) {
    for (const b of json.eloBands) {
      if (!b || !b.key) return 'eloBands contains an entry with no `key`.';
      if (typeof b.minElo !== 'number' || typeof b.maxElo !== 'number')
        return `eloBands["${b.key}"] missing numeric minElo/maxElo.`;
      if (b.minElo > b.maxElo)
        return `eloBands["${b.key}"]: minElo (${b.minElo}) > maxElo (${b.maxElo}).`;
    }
  }
  return null; // ok
}

// ─── main ───────────────────────────────────────────────────────────────────
function resolveDocPath(args) {
  if (args.docPath) return { path: args.docPath, source: 'CLI --path' };

  const sidecar = path.resolve(__dirname, DOCPATH_FILE);
  if (fs.existsSync(sidecar)) {
    const raw = fs.readFileSync(sidecar, 'utf8').trim();
    if (raw) return { path: raw, source: `${DOCPATH_FILE} sidecar` };
  }
  return { path: DEFAULT_DOC_PATH, source: 'default' };
}

function loadJson(args) {
  const file = path.resolve(__dirname, args.jsonFile || DEFAULT_JSON_FILE);
  if (!fs.existsSync(file)) {
    console.error(`✗ Config JSON not found: ${file}`);
    console.error('  Generate it from Unity:');
    console.error('  Tools → Weekly Tournament → Save Selected Config JSON to Coordinator');
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`✗ Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  // Strip UTF-8 BOM if present — Windows tools (PowerShell Out-File, Unity
  // File.WriteAllText with default encoding) sometimes prepend it.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error(`✗ Invalid JSON in ${file}: ${e.message}`);
    process.exit(1);
  }
  return { file, json };
}

async function main() {
  const args = parseArgs(process.argv);
  const { file, json } = loadJson(args);
  const { path: docPath, source: docSrc } = resolveDocPath(args);

  const segments = docPath.split('/').filter(Boolean);
  if (segments.length !== 2) {
    console.error(`✗ Document path must be "collection/docId" (got "${docPath}", source: ${docSrc}).`);
    process.exit(1);
  }
  const [colName, docId] = segments;

  const validationError = validatePayload(json);
  if (validationError) {
    console.error(`✗ Payload validation failed:\n  ${validationError}`);
    process.exit(1);
  }

  console.log('────────────────────────────────────────────────────────────────');
  console.log(' Weekly Tournament — Config Push');
  console.log('────────────────────────────────────────────────────────────────');
  console.log(` Source file       : ${file}`);
  console.log(` Target document   : ${colName}/${docId}   (from ${docSrc})`);
  console.log(` Field count       : ${Object.keys(json).length}`);
  console.log(` Multi-room        : ${json.multiRoomEnabled ? 'ON' : 'off'}`);
  console.log(` Test hour mode    : ${json.useTestingHourMode ? 'ON' : 'off'}`);
  console.log(` Max participants  : ${json.maxParticipants}`);
  console.log(` Award tournament ELO: ${json.awardEloInTournament ? `ON (±${json.tournamentEloChange})` : 'off'}`);
  console.log('────────────────────────────────────────────────────────────────');

  if (args.dryRun) {
    console.log(' DRY RUN — no write performed.');
    return;
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('✗ FIREBASE_SERVICE_ACCOUNT env var is not set.');
    console.error('  PowerShell: $env:FIREBASE_SERVICE_ACCOUNT = Get-Content path\\to\\sa.json -Raw');
    console.error('  bash:       export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/sa.json)"');
    process.exit(1);
  }

  // Lazy require — only loads firebase-admin when we actually need to write.
  let db;
  try {
    db = require('./lib/firebase').db;
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      console.error('✗ firebase-admin not installed. Run `npm install` first.');
    } else {
      console.error('✗ Failed to initialize firebase-admin:', e.message || e);
    }
    process.exit(1);
  }

  await db().collection(colName).doc(docId).set(json);

  console.log(` ✓ Pushed. Firestore '${colName}/${docId}' now reflects WtConfig.`);
  console.log('   Coordinator (GitHub Actions) picks up new values within ~5 min.');
}

main().catch(e => {
  console.error('✗ Push failed:', e && e.message ? e.message : e);
  if (e && e.code === 7 /* PERMISSION_DENIED in firestore */) {
    console.error('  → Service account lacks Firestore write permission.');
    console.error('    Grant role "Cloud Datastore User" or "Firebase Admin" in IAM.');
  } else if (e && /service.account/i.test(String(e.message || ''))) {
    console.error('  → Verify FIREBASE_SERVICE_ACCOUNT contains the full JSON of the key file.');
  }
  process.exit(1);
});
