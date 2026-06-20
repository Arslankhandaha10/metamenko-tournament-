/**
 * Cycle-end coordinator for the Most Used Card module — PULL-MODEL.
 *
 * Runs every N minutes via .github/workflows/muc-tick.yml. On each tick:
 *   1. Read the live MucConfig doc (so testing-mode flags stay in lockstep with Unity).
 *   2. Compute the current cycle index and walk BACKWARD through every prior
 *      cycle whose top_winners doc does not yet exist. For each such cycle:
 *        a. Pull all muc_usage_events for that cycleId.
 *        b. Aggregate → counter map.
 *        c. Rewrite canonical card_counters doc (corrects any optimistic-bump drift).
 *        d. pickWinners → list with ties.
 *        e. WRITE: muc_top_winners/{cycleId} with phase="Finalized"
 *           AND stamp the cycle meta doc.
 *
 * INTENTIONALLY DOES NOT touch user_rewards. Inbox entries are created by
 * claims-tick.js ONLY when an on-chain ownership check succeeds, so the
 * inbox is never pre-populated with ghost entries.
 *
 * Designed to be portable to a Cloud Function trigger (HTTP / scheduler) by
 * wrapping main() in a handler. Until then, GitHub Actions invokes node tick.js.
 *
 * Cap on backfill: at most MAX_BACKFILL cycles per tick to keep the runtime
 * predictable when the runner has been offline for a long stretch.
 */
const { db, init } = require('./lib/firebase');
const cycleLib = require('./lib/cycle');
const { aggregate } = require('./lib/aggregate');
const { pickWinners } = require('./lib/pickWinners');

// Default collection names — overridden by config doc.
const DEFAULTS = {
  configDoc: 'most_used_card_config/active',
  usageEvents: 'muc_usage_events',
  cardCounters: 'muc_card_counters',
  topWinners: 'muc_top_winners',
  userRewards: 'muc_user_rewards',
  rewardClaims: 'muc_reward_claims'
};

const MAX_BACKFILL = 12; // never finalize more than this many orphan cycles in a single tick

async function loadConfig() {
  const ref = db().doc(DEFAULTS.configDoc);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn('[muc][tick] No config doc at', DEFAULTS.configDoc, '— using defaults.');
    return defaultConfig();
  }
  return Object.assign(defaultConfig(), snap.data() || {});
}

function defaultConfig() {
  return {
    cycleIdPrefix: 'muc',
    cycleEpochUtc: '2026-01-01T00:00:00Z',
    cycleDurationDays: 30,
    useMonthlyCycle: false,
    useTestingMode: false,
    cycleDurationSecondsTesting: 600,
    claimWindowDays: 7,
    useTestingClaimWindow: false,
    claimWindowSecondsTesting: 600,
    gemReward: 500,
    topNRewarded: 1,
    cosmeticIdPlaceholder: '',
    boosterPackCountPlaceholder: 0,
    indexerGraphqlUrl: 'https://indexer.mainnet.movementnetwork.xyz/v1/graphql',
    nftCollectionId: '',
    usageEventsCollection: DEFAULTS.usageEvents,
    cardCountersCollection: DEFAULTS.cardCounters,
    topWinnersCollection: DEFAULTS.topWinners,
    userRewardsCollection: DEFAULTS.userRewards,
    rewardClaimsCollection: DEFAULTS.rewardClaims
  };
}

function pad4(n) { return String(n).padStart(4, '0'); }

function formatYmdUtc(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function cycleIdAt(cfg, idx) {
  const prefix = cfg.cycleIdPrefix || 'muc';
  const start = cycleLib.cycleStartMsAt(cfg, idx);
  return `${prefix}_C${pad4(idx)}-${formatYmdUtc(start)}`;
}

async function main() {
  init();
  const cfg = await loadConfig();
  const collections = {
    usageEvents: cfg.usageEventsCollection || DEFAULTS.usageEvents,
    cardCounters: cfg.cardCountersCollection || DEFAULTS.cardCounters,
    topWinners: cfg.topWinnersCollection || DEFAULTS.topWinners
  };

  const nowMs = Date.now();
  const currentIdx = cycleLib.cycleIndex(cfg, nowMs);

  // The newest finalizable cycle is the largest idx whose ACTIVE window has ended
  // (now >= cycleEndMsAt). In FIXED mode that is always currentIdx-1 (the current
  // cycle is still running). In MONTHLY mode the current month becomes finalizable
  // the moment we enter its claim window (the last claimWindowDays days), so its
  // winners exist in time for players to claim within the same month.
  let startIdx = currentIdx;
  if (nowMs < cycleLib.cycleEndMsAt(cfg, currentIdx)) startIdx = currentIdx - 1;
  if (startIdx < 0) {
    console.log('[muc][tick] No completed cycles yet — nothing to finalize.');
    return;
  }

  // Walk backward from startIdx and finalize anything missing a top_winners doc.
  // This converts a single-tick miss into a self-healing backfill.
  let backfilled = 0;
  for (let idx = startIdx; idx >= 0 && backfilled < MAX_BACKFILL; idx--) {
    const cycleId = cycleIdAt(cfg, idx);
    const winnersRef = db().collection(collections.topWinners).doc(cycleId);
    const winnersSnap = await winnersRef.get();
    if (winnersSnap.exists) {
      if (idx === startIdx) {
        console.log(`[muc][tick] Cycle ${cycleId} already finalized. Nothing to do.`);
      } else {
        console.log(`[muc][tick] Hit finalized cycle ${cycleId} at idx=${idx}; older cycles assumed already done.`);
      }
      break;
    }
    await finalizeCycle({
      cfg,
      collections,
      cycleId,
      cycleStartMs: cycleLib.cycleStartMsAt(cfg, idx),
      cycleEndMs: cycleLib.cycleEndMsAt(cfg, idx)
    });
    backfilled += 1;
  }

  if (backfilled === 0) {
    console.log('[muc][tick] All recent cycles already finalized — exiting clean.');
  } else {
    console.log(`[muc][tick] Finalized ${backfilled} cycle(s) this tick.`);
  }
}

async function finalizeCycle({ cfg, collections, cycleId, cycleStartMs, cycleEndMs }) {
  console.log(`[muc][tick] Finalizing ${cycleId} (start=${new Date(cycleStartMs).toISOString()} end=${new Date(cycleEndMs).toISOString()}) ...`);

  const eventsSnap = await db().collection(collections.usageEvents)
    .where('cycleId', '==', cycleId)
    .get();
  const events = [];
  eventsSnap.forEach(d => events.push(d.data()));
  console.log(`[muc][tick] ${cycleId}: ${events.length} usage events.`);

  const finalizedAtMs = Date.now();
  const winnersRef = db().collection(collections.topWinners).doc(cycleId);
  const metaRef = db().collection(collections.cardCounters).doc(cycleId);

  if (events.length === 0) {
    await winnersRef.set({
      cycleId,
      cycleStartMs,
      cycleEndMs,
      finalizedAtMs,
      winners: [],
      phase: 'Finalized'
    });
    await metaRef.set({
      cycleId,
      phase: 'Finalized',
      finalizedAtMs,
      cycleStartMs,
      cycleEndMs
    }, { merge: true });
    console.log(`[muc][tick] ${cycleId}: empty winners doc written.`);
    return;
  }

  const counterMap = aggregate(events);
  const winners = pickWinners(counterMap, cfg.topNRewarded || 1);
  console.log(`[muc][tick] ${cycleId}: top ${winners.length} winners:`,
    winners.map(w => `${w.cardName}(${w.count})`).join(', '));

  const enrichedWinners = winners.map(w => ({
    rank: w.rank,
    cardName: w.cardName,
    nftName: w.nftName || '',
    count: w.count,
    gemAmount: Math.max(0, cfg.gemReward || 0)
  }));
  await winnersRef.set({
    cycleId,
    cycleStartMs,
    cycleEndMs,
    finalizedAtMs,
    winners: enrichedWinners,
    phase: 'Finalized'
  });

  await writeCanonicalCounterDoc(metaRef, {
    cycleId, cycleStartMs, cycleEndMs, finalizedAtMs, phase: 'Finalized'
  }, counterMap);

  console.log(`[muc][tick] ${cycleId}: FINALIZED with ${enrichedWinners.length} winning card(s).`);
}

async function writeCanonicalCounterDoc(metaRef, meta, counterMap) {
  const now = Date.now();
  const cards = {};
  for (const c of counterMap.values()) {
    const key = (c.nftName && String(c.nftName)) || (c.cardName && String(c.cardName));
    if (!key) continue;
    cards[key] = {
      nftName: c.nftName || '',
      cardName: c.cardName || '',
      count: c.count,
      lastUpdatedMs: now
    };
  }
  await metaRef.set(Object.assign({}, meta, { cards }), { merge: true });
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('[muc][tick] FATAL:', e && (e.stack || e.message || e));
    process.exit(1);
  });
