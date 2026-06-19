/**
 * Claim processor for the Most Used Card module.
 *
 * Runs every N minutes via .github/workflows/muc-claims.yml. Pulls the
 * pending_verify backlog and runs server-side ownership verification +
 * atomic grant. See lib/claims.js for the per-claim logic.
 *
 * Designed to be portable: the same processPendingClaims() function can be
 * triggered from a Cloud Function (Firestore trigger or scheduled) without
 * code changes.
 */
const { db, admin, init } = require('./lib/firebase');
const { processPendingClaims } = require('./lib/claims');

const DEFAULTS = {
  configDoc: 'most_used_card_config/active',
  rewardClaims: 'muc_reward_claims',
  userRewards: 'muc_user_rewards',
  topWinners: 'muc_top_winners',
  cardCounters: 'muc_card_counters'
};

async function loadConfig() {
  const ref = db().doc(DEFAULTS.configDoc);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn('[muc][claims-tick] No config doc — using defaults.');
    return defaults();
  }
  return Object.assign(defaults(), snap.data() || {});
}
function defaults() {
  return {
    rewardClaimsCollection: DEFAULTS.rewardClaims,
    userRewardsCollection: DEFAULTS.userRewards,
    topWinnersCollection: DEFAULTS.topWinners,
    cardCountersCollection: DEFAULTS.cardCounters,
    cycleEpochUtc: '2026-01-01T00:00:00Z',
    cycleDurationDays: 30,
    useTestingMode: false,
    cycleDurationSecondsTesting: 600,
    claimWindowDays: 7,
    useTestingClaimWindow: false,
    claimWindowSecondsTesting: 600,
    gemReward: 500,
    cosmeticIdPlaceholder: '',
    indexerGraphqlUrl: 'https://indexer.mainnet.movementnetwork.xyz/v1/graphql',
    nftCollectionId: ''
  };
}

async function main() {
  init();
  const cfg = await loadConfig();
  const collections = {
    rewardClaims: cfg.rewardClaimsCollection || DEFAULTS.rewardClaims,
    userRewards: cfg.userRewardsCollection || DEFAULTS.userRewards,
    topWinners: cfg.topWinnersCollection || DEFAULTS.topWinners,
    cardCounters: cfg.cardCountersCollection || DEFAULTS.cardCounters
  };

  const result = await processPendingClaims({
    db: db(),
    admin,
    cfg,
    collections
  });
  console.log(`[muc][claims-tick] Done. processed=${result.processed} granted=${result.granted} rejected=${result.rejected}`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('[muc][claims-tick] FATAL:', e && (e.stack || e.message || e));
    process.exit(1);
  });
