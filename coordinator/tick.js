/**
 * Coordinator entry point. Runs once per scheduled invocation.
 * Idempotent: safe to invoke many times within the same window.
 *
 * Workflow per tick:
 *   1. Read tournament_config/active.
 *   2. Compute current cycleId + expected phase.
 *   3. Read meta/info for current cycle.
 *   4. If meta missing → openRegistration().
 *   5. Compare meta.phase → expectedPhase, advance if behind:
 *        Registration → SwissInProgress / Top8: closeRegistrationAndPair()
 *        SwissInProgress: advanceRoundIfReady()
 *        Top8 / Finals: progress single-elim
 *        Complete: finalize()
 */
const { db } = require('./lib/firebase');
const { PHASE, currentCycleId, expectedPhase, currentCycleStart } = require('./lib/cycle');
const { nextSwissRound } = require('./lib/swiss');
const { buildRoundZero, nextRoundFromWinners } = require('./lib/elimination');

const CONFIG_PATH = 'tournament_config/active';

async function main() {
  const cfg = await loadConfig();
  if (!cfg) { console.log('No config doc — exiting.'); return; }

  const root = cfg.rootCollection || 'tournament_cycles';
  const sessionPrefix = cfg.sessionNamePrefix || 'WT';
  const now = new Date();
  const cycleId = currentCycleId(cfg, now);
  const expected = expectedPhase(cfg, now);

  console.log(`[tick] cycleId=${cycleId} expected=${expected}`);

  const cycleRef = db().collection(root).doc(cycleId);
  const metaRef = cycleRef.collection('meta').doc('info');
  let meta = (await metaRef.get()).data();

  if (!meta) {
    // First time we see this cycle — initialize meta in Idle/Registration based on time.
    meta = {
      cycleId,
      phase: expected === PHASE.Idle ? PHASE.Idle : PHASE.Registration,
      currentRound: 0,
      cycleStartUtc: currentCycleStart(cfg, now).toISOString(),
      cycleDurationDays: cfg.cycleDurationDays,
      openedAtUtc: now.toISOString(),
      registrationClosedAtUtc: '',
      refundIssued: false
    };
    await metaRef.set(meta);
    console.log(`[tick] Initialized meta for ${cycleId} → ${meta.phase}`);
    return;
  }

  switch (meta.phase) {
    case PHASE.Idle:
      if (expected !== PHASE.Idle) await transitionTo(metaRef, meta, PHASE.Registration);
      break;

    case PHASE.Registration:
      if (expected === PHASE.SwissInProgress || expected === PHASE.Top8 || expected === PHASE.Complete) {
        await closeRegistrationAndStart(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      }
      break;

    case PHASE.SwissInProgress:
      await advanceSwissIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      if (expected === PHASE.Top8 || expected === PHASE.Complete) {
        await startTopCut(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      }
      break;

    case PHASE.Top8:
    case PHASE.Finals:
      await advanceEliminationIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      break;

    case PHASE.Complete:
      // nothing to do
      break;
  }
}

async function loadConfig() {
  const snap = await db().doc(CONFIG_PATH).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (typeof data.cycleDurationDays === 'string') data.cycleDurationDays = Number(data.cycleDurationDays);
  return data;
}

async function transitionTo(metaRef, meta, phase) {
  await metaRef.update({ phase, transitionedAtUtc: new Date().toISOString() });
  console.log(`[tick] meta.phase ${meta.phase} → ${phase}`);
}

async function closeRegistrationAndStart(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const participants = await loadParticipants(root, cycleId);
  if (participants.length < 2) {
    console.log('[tick] Not enough participants — skipping to Complete.');
    await metaRef.update({
      phase: PHASE.Complete,
      registrationClosedAtUtc: new Date().toISOString(),
      transitionedAtUtc: new Date().toISOString()
    });
    return;
  }

  if ((cfg.swissRounds || 0) > 0) {
    // Start swiss round 0
    const pairs = nextSwissRound(participants);
    await writeRoundMatches(root, cycleId, 0, pairs, sessionPrefix, 'bo1');
    await metaRef.update({
      phase: PHASE.SwissInProgress,
      currentRound: 0,
      registrationClosedAtUtc: new Date().toISOString()
    });
    console.log(`[tick] Swiss R0 paired: ${pairs.length} matches.`);
  } else {
    // Skip swiss — go straight to single elim seeded by elo
    participants.sort((a, b) => (b.elo || 0) - (a.elo || 0));
    const seeds = participants.slice(0, cfg.topCutSize || participants.length).map(p => p.userId);
    const pairs = buildRoundZero(seeds);
    await writeRoundMatches(root, cycleId, 0, pairs, sessionPrefix, 'bo1');
    await metaRef.update({
      phase: PHASE.Top8,
      currentRound: 0,
      registrationClosedAtUtc: new Date().toISOString()
    });
    console.log(`[tick] Top cut R0 paired: ${pairs.length} matches.`);
  }
}

async function advanceSwissIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const round = meta.currentRound || 0;
  const matches = await loadRoundMatches(root, cycleId, round);
  if (matches.length === 0) return;
  const allDone = matches.every(m => m.status === 'completed' && m.winnerUserId);
  if (!allDone) return;

  // Update participant stats
  const participants = await loadParticipants(root, cycleId);
  const map = new Map(participants.map(p => [p.userId, p]));
  for (const m of matches) {
    const w = map.get(m.winnerUserId);
    const lid = m.winnerUserId === m.slotAUserId ? m.slotBUserId : m.slotAUserId;
    const l = lid ? map.get(lid) : null;
    if (w) {
      w.swissPoints = (w.swissPoints || 0) + 1;
      w.wins = (w.wins || 0) + 1;
      w.opponents = w.opponents || [];
      if (lid) w.opponents.push(lid);
    }
    if (l) {
      l.losses = (l.losses || 0) + 1;
      l.opponents = l.opponents || [];
      l.opponents.push(m.winnerUserId);
    }
  }
  await Promise.all(participants.map(p =>
    db().collection(`${root}/${cycleId}/participants`).doc(p.userId).set(p, { merge: true })
  ));

  // Next swiss round?
  if (round + 1 < (cfg.swissRounds || 0)) {
    const pairs = nextSwissRound(participants);
    await writeRoundMatches(root, cycleId, round + 1, pairs, sessionPrefix, 'bo1');
    await metaRef.update({ currentRound: round + 1 });
    console.log(`[tick] Swiss R${round + 1} paired: ${pairs.length} matches.`);
  } else {
    await metaRef.update({ phase: PHASE.SwissComplete });
    console.log('[tick] Swiss complete.');
  }
}

async function startTopCut(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const participants = await loadParticipants(root, cycleId);
  participants.sort((a, b) => {
    const cmp = (b.swissPoints || 0) - (a.swissPoints || 0);
    if (cmp !== 0) return cmp;
    return (b.elo || 0) - (a.elo || 0);
  });
  const seeds = participants.slice(0, cfg.topCutSize || participants.length).map(p => p.userId);
  const pairs = buildRoundZero(seeds);
  // Top-cut rounds are written under a fresh round index range (0, 1, 2 ...) — they live in the same active_matches collection but with id prefix TC.
  await writeRoundMatches(root, cycleId, 100, pairs, sessionPrefix, 'bo1');
  await metaRef.update({ phase: PHASE.Top8, currentRound: 100 });
  console.log(`[tick] Top cut R100 paired with ${pairs.length} matches.`);
}

async function advanceEliminationIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const round = meta.currentRound || 100;
  const matches = await loadRoundMatches(root, cycleId, round);
  if (matches.length === 0) return;
  const allDone = matches.every(m => m.status === 'completed' && m.winnerUserId);
  if (!allDone) return;

  const winners = matches.map(m => m.winnerUserId).filter(Boolean);
  if (winners.length <= 1) {
    // Champion decided
    await finalize(cfg, root, cycleId, metaRef, winners[0]);
    return;
  }

  const finalsThisRound = winners.length === 2;
  const pairs = nextRoundFromWinners(winners);
  await writeRoundMatches(root, cycleId, round + 1, pairs, sessionPrefix,
    finalsThisRound && cfg.finalsBestOf3 ? 'bo3' : 'bo1');
  await metaRef.update({
    phase: finalsThisRound ? PHASE.Finals : PHASE.Top8,
    currentRound: round + 1
  });
  console.log(`[tick] Elim R${round + 1} paired: ${pairs.length}.`);
}

async function finalize(cfg, root, cycleId, metaRef, championUserId) {
  const participants = await loadParticipants(root, cycleId);
  const champion = participants.find(p => p.userId === championUserId);

  // Runner-up: loser of the FINAL match (the real Bo1/Bo3 final), which is the
  // completed contested match with the highest roundIndex. We deliberately skip:
  //   - matches with no slotB (bye advancement, has no real loser)
  //   - matches whose loser equals the champion (shouldn't happen, defensive)
  const allMatches = await loadAllMatches(root, cycleId);
  const contestedDesc = allMatches
    .filter(m => m.status === 'completed' && m.slotAUserId && m.slotBUserId && m.winnerUserId)
    .sort((a, b) => (b.roundIndex || 0) - (a.roundIndex || 0));

  let runnerUpId = null;
  for (const m of contestedDesc) {
    const loser = m.winnerUserId === m.slotAUserId ? m.slotBUserId : m.slotAUserId;
    if (loser && loser !== championUserId) { runnerUpId = loser; break; }
  }

  // Final safety net: if every final-round match was a bye, fall back to the
  // highest-seeded non-champion in the elimination bracket.
  if (!runnerUpId) {
    const bracketMatches = allMatches.filter(m => m.slotAUserId && m.slotAUserId !== championUserId);
    if (bracketMatches.length > 0) runnerUpId = bracketMatches[0].slotAUserId;
  }

  // Top 8 = top by swiss points after sort
  const sorted = participants.slice().sort((a, b) => (b.swissPoints || 0) - (a.swissPoints || 0));
  const top8 = sorted.slice(0, Math.min(8, sorted.length)).map(p => p.userId);

  const finalDoc = {
    championUserId,
    championUsername: champion ? champion.username : '',
    runnerUpUserId: runnerUpId || '',
    top8UserIds: top8,
    participantUserIds: participants.map(p => p.userId),
    finalizedAtUtc: new Date().toISOString()
  };
  await db().collection(`${root}/${cycleId}/final_results`).doc('info').set(finalDoc);
  await metaRef.update({ phase: PHASE.Complete });
  console.log(`[tick] Finalized. Champion=${championUserId}`);
}

async function loadParticipants(root, cycleId) {
  const snap = await db().collection(`${root}/${cycleId}/participants`).get();
  return snap.docs.map(d => Object.assign({}, d.data(), { userId: d.id }));
}

async function loadRoundMatches(root, cycleId, roundIndex) {
  const snap = await db().collection(`${root}/${cycleId}/active_matches`)
    .where('roundIndex', '==', roundIndex).get();
  return snap.docs.map(d => Object.assign({}, d.data(), { _id: d.id }));
}

async function loadAllMatches(root, cycleId) {
  const snap = await db().collection(`${root}/${cycleId}/active_matches`).get();
  return snap.docs.map(d => Object.assign({}, d.data(), { _id: d.id }));
}

async function writeRoundMatches(root, cycleId, roundIndex, pairs, sessionPrefix, format) {
  const batch = db().batch();
  const cycleShort = cycleId.slice(0, 8);
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const docId = `R${roundIndex}_M${i}`;
    const sessionName = p.slotBUserId
      ? `${sessionPrefix}_${cycleShort}_R${roundIndex}_M${i}`
      : ''; // bye — no session needed
    const ref = db().collection(`${root}/${cycleId}/active_matches`).doc(docId);
    batch.set(ref, {
      cycleId,
      roundIndex,
      matchIndex: i,
      slotAUserId: p.slotAUserId || '',
      slotBUserId: p.slotBUserId || '',
      sessionName,
      status: p.slotBUserId ? 'pending' : 'completed',
      winnerUserId: p.slotBUserId ? '' : (p.slotAUserId || ''),
      reportedAtUtc: '',
      reporterUserId: '',
      format,
      gameNumber: 1
    });
  }
  await batch.commit();
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
