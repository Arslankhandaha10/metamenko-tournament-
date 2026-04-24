/**
 * Coordinator entry point. Runs once per scheduled invocation.
 * Idempotent: safe to invoke many times within the same window.
 *
 * Legacy workflow (multiRoomEnabled=false):
 *   1. Read tournament_config/active.
 *   2. Compute current cycleId + expected phase.
 *   3. Process that single cycle with processCycle().
 *
 * Multi-room workflow (multiRoomEnabled=true):
 *   1. Read tournament_config/active.
 *   2. Compute cycleBase = "{type}_C{NNNN}-{yyyy-MM-dd}".
 *   3. Load tournament_registry/{cycleBase}. If absent -> nobody registered yet -> exit.
 *   4. For each room in registry.rooms, compose cycleId = cycleBase + "_" + roomId
 *      and call processCycle() independently so each league advances in parallel.
 *   5. On finalize, mark registry.rooms[i].completed so future ticks skip it.
 *
 * processCycle() is the SAME per-cycle logic from the legacy flow — it just
 * receives a fully composed cycleId plus the meta-enrichment fields for
 * multi-room (cycleBase, roomId, eloBandKey). Single-room callers pass
 * cycleBase == cycleId and roomId == "" which leaves the meta fields empty.
 */
const { db } = require('./lib/firebase');
const {
  PHASE,
  currentCycleId,
  currentCycleBase,
  composeCycleId,
  expectedPhase,
  currentCycleStart
} = require('./lib/cycle');
const { nextSwissRound } = require('./lib/swiss');
const { buildRoundZero, nextRoundFromWinners } = require('./lib/elimination');
const { loadRegistry, markRoomCompleted } = require('./lib/registry');

const CONFIG_PATH = process.env.WT_CONFIG_PATH || 'tournament_config/active';

async function main() {
  const cfg = await loadConfig();
  if (!cfg) { console.log('No config doc — exiting.'); return; }

  const root = cfg.rootCollection || 'tournament_cycles';
  const sessionPrefix = cfg.sessionNamePrefix || 'WT';
  const now = new Date();

  if (cfg.multiRoomEnabled === true) {
    await tickMultiRoom(cfg, root, sessionPrefix, now);
  } else {
    await tickSingleRoom(cfg, root, sessionPrefix, now);
  }
}

async function tickSingleRoom(cfg, root, sessionPrefix, now) {
  const cycleId = currentCycleId(cfg, now);
  const expected = expectedPhase(cfg, now);
  console.log(`[tick][single] cycleId=${cycleId} expected=${expected}`);
  await processCycle(cfg, root, sessionPrefix, now, {
    cycleId,
    cycleBase: cycleId,
    roomId: '',
    eloBandKey: ''
  });
}

async function tickMultiRoom(cfg, root, sessionPrefix, now) {
  const cycleBase = currentCycleBase(cfg, now);
  const expected = expectedPhase(cfg, now);
  console.log(`[tick][multi] cycleBase=${cycleBase} expected=${expected}`);

  const registry = await loadRegistry(cfg, cycleBase);
  if (!registry || !Array.isArray(registry.rooms) || registry.rooms.length === 0) {
    console.log('[tick][multi] No rooms yet — nothing to tick.');
    return;
  }

  for (const room of registry.rooms) {
    if (!room || !room.roomId) continue;
    if (room.completed === true) {
      console.log(`[tick][multi] Skip completed room ${room.roomId}`);
      continue;
    }
    const cycleId = composeCycleId(cycleBase, room.roomId);
    console.log(`[tick][multi] → room ${room.roomId} (${cycleId}) band=${room.eloBandKey || 'All'}`);
    try {
      const finalized = await processCycle(cfg, root, sessionPrefix, now, {
        cycleId,
        cycleBase,
        roomId: room.roomId,
        eloBandKey: room.eloBandKey || ''
      });
      if (finalized) {
        await markRoomCompleted(cfg, cycleBase, room.roomId);
        console.log(`[tick][multi] Marked ${room.roomId} completed in registry.`);
      }
    } catch (e) {
      // Keep iterating other rooms even if one fails so a single bad room
      // does not block the entire cycle.
      console.error(`[tick][multi] Room ${room.roomId} failed:`, e);
    }
  }
}

/**
 * Process a single per-room cycle. Returns true when the cycle was finalized
 * (so the caller may mark it completed in the registry), false otherwise.
 *
 * `ctx` carries the shared identifying fields written into meta the first time
 * we initialize this room: cycleBase, roomId, eloBandKey.
 */
async function processCycle(cfg, root, sessionPrefix, now, ctx) {
  const cycleId = ctx.cycleId;
  const expected = expectedPhase(cfg, now);

  const cycleRef = db().collection(root).doc(cycleId);
  const metaRef = cycleRef.collection('meta').doc('info');
  let meta = (await metaRef.get()).data();

  if (!meta) {
    // First time — stamp meta with all multi-room identifying fields.
    meta = {
      cycleId,
      phase: expected === PHASE.Idle ? PHASE.Idle : PHASE.Registration,
      currentRound: 0,
      cycleStartUtc: currentCycleStart(cfg, now).toISOString(),
      cycleDurationDays: cfg.cycleDurationDays,
      openedAtUtc: now.toISOString(),
      registrationClosedAtUtc: '',
      refundIssued: false,
      tournamentType: cfg.tournamentType || 'weekly',
      cycleBase: ctx.cycleBase || cycleId,
      roomId: ctx.roomId || '',
      eloBandKey: ctx.eloBandKey || ''
    };
    await metaRef.set(meta);
    console.log(`[tick] Initialized meta for ${cycleId} → ${meta.phase}`);
    return false;
  }

  switch (meta.phase) {
    case PHASE.Idle:
      if (expected !== PHASE.Idle) await transitionTo(metaRef, meta, PHASE.Registration);
      return false;

    case PHASE.Registration: {
      const timeUp = expected === PHASE.SwissInProgress
                  || expected === PHASE.Top8
                  || expected === PHASE.Complete;
      if (timeUp) {
        await closeRegistrationAndStart(cfg, root, cycleId, sessionPrefix, metaRef, meta);
        return false;
      }
      if (cfg.useTestingHourMode === true) {
        await maybeEarlyStartFromCapacity(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      }
      return false;
    }

    case PHASE.SwissInProgress: {
      await advanceSwissIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      const refreshed = (await metaRef.get()).data() || meta;
      const swissDone = refreshed.phase === PHASE.SwissComplete;
      const timeReachedCut = expected === PHASE.Top8 || expected === PHASE.Complete;
      if (swissDone && timeReachedCut) {
        await startTopCut(cfg, root, cycleId, sessionPrefix, metaRef, refreshed);
      }
      return false;
    }

    case PHASE.SwissComplete:
      if (expected === PHASE.Top8 || expected === PHASE.Complete) {
        await startTopCut(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      }
      return false;

    case PHASE.Top8:
    case PHASE.Finals: {
      const completed = await advanceEliminationIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta);
      return completed === true;
    }

    case PHASE.Complete:
      return true;
  }
  return false;
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

/**
 * Testing-only: if the participant cap is hit, stamp a grace timestamp and on
 * a later tick (after `earlyStartDelaySeconds`) close registration early.
 *
 * Same semantics as before — see commit history for full behavior docs.
 */
async function maybeEarlyStartFromCapacity(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const cap = Number(cfg.maxParticipants || 0);
  if (cap <= 0) return;

  const graceSec = Number(cfg.earlyStartDelaySeconds == null ? 60 : cfg.earlyStartDelaySeconds);
  const all = await loadParticipants(root, cycleId);
  const paid = all.filter(p => p.entryPaid === true).length;

  if (paid >= cap) {
    if (!meta.capReachedAtUtc) {
      await metaRef.update({ capReachedAtUtc: new Date().toISOString() });
      console.log(`[tick] (TEST) Cap reached ${paid}/${cap}. Auto-start in ${graceSec}s.`);
      return;
    }
    const elapsedMs = Date.now() - new Date(meta.capReachedAtUtc).getTime();
    if (elapsedMs >= graceSec * 1000) {
      console.log('[tick] (TEST) Grace elapsed — starting tournament early.');
      await closeRegistrationAndStart(cfg, root, cycleId, sessionPrefix, metaRef, meta);
    } else {
      const left = Math.ceil((graceSec * 1000 - elapsedMs) / 1000);
      console.log(`[tick] (TEST) Cap held — auto-start in ${left}s.`);
    }
    return;
  }

  if (meta.capReachedAtUtc) {
    await metaRef.update({ capReachedAtUtc: null });
    console.log(`[tick] (TEST) Cap dropped to ${paid}/${cap}. Grace stamp cleared.`);
  }
}

async function closeRegistrationAndStart(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const raw = await loadParticipants(root, cycleId);
  let participants = raw.filter(p => p.entryPaid === true);
  if (participants.length < raw.length) {
    console.log(`[tick] Dropped ${raw.length - participants.length} non-paid participants.`);
  }

  const cap = Number(cfg.maxParticipants || 0);
  if (cap > 0 && participants.length > cap) {
    participants.sort((a, b) => String(a.registeredAtUtc || '').localeCompare(String(b.registeredAtUtc || '')));
    participants = participants.slice(0, cap);
    console.log(`[tick] Trimmed to maxParticipants=${cap}.`);
  }

  if (participants.length < 2) {
    console.log('[tick] Not enough participants — skipping to Complete with no champion.');
    await metaRef.update({
      phase: PHASE.Complete,
      registrationClosedAtUtc: new Date().toISOString(),
      transitionedAtUtc: new Date().toISOString()
    });
    await db().collection(`${root}/${cycleId}/final_results`).doc('info').set({
      championUserId: '',
      championUsername: '',
      runnerUpUserId: '',
      top8UserIds: [],
      participantUserIds: participants.map(p => p.userId),
      finalizedAtUtc: new Date().toISOString()
    }, { merge: true });
    return;
  }

  if ((cfg.swissRounds || 0) > 0) {
    const pairs = nextSwissRound(participants);
    await writeRoundMatches(root, cycleId, 0, pairs, sessionPrefix, 'bo1');
    await metaRef.update({
      phase: PHASE.SwissInProgress,
      currentRound: 0,
      registrationClosedAtUtc: new Date().toISOString()
    });
    console.log(`[tick] Swiss R0 paired: ${pairs.length} matches.`);
  } else {
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

  const allDone = matches.every(m => {
    if (m.status !== 'completed') return false;
    if (!m.winnerUserId) return false;
    if (m.winnerUserId !== m.slotAUserId && m.winnerUserId !== m.slotBUserId) {
      console.warn(`[tick] Invalid winner on match ${m._id}: ${m.winnerUserId} not in slots.`);
      return false;
    }
    return true;
  });
  if (!allDone) return;

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
  await writeRoundMatches(root, cycleId, 100, pairs, sessionPrefix, 'bo1');
  await metaRef.update({ phase: PHASE.Top8, currentRound: 100 });
  console.log(`[tick] Top cut R100 paired with ${pairs.length} matches.`);
}

async function advanceEliminationIfReady(cfg, root, cycleId, sessionPrefix, metaRef, meta) {
  const round = (typeof meta.currentRound === 'number') ? meta.currentRound : 100;
  const matches = await loadRoundMatches(root, cycleId, round);

  if (matches.length === 0) {
    const all = await loadParticipants(root, cycleId);
    all.sort((a, b) => (b.swissPoints || 0) - (a.swissPoints || 0) || (b.elo || 0) - (a.elo || 0));
    const fallback = all[0] && all[0].userId ? all[0].userId : '';
    console.log(`[tick] Empty elim round ${round} — finalizing with fallback champion=${fallback}`);
    await finalize(cfg, root, cycleId, metaRef, fallback);
    return true;
  }

  const allDone = matches.every(m => {
    if (m.status !== 'completed') return false;
    if (!m.winnerUserId) return false;
    if (m.slotBUserId) {
      return m.winnerUserId === m.slotAUserId || m.winnerUserId === m.slotBUserId;
    }
    return m.winnerUserId === m.slotAUserId;
  });
  if (!allDone) return false;

  const winners = matches.map(m => m.winnerUserId).filter(Boolean);
  if (winners.length <= 1) {
    await finalize(cfg, root, cycleId, metaRef, winners[0] || '');
    return true;
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
  return false;
}

async function finalize(cfg, root, cycleId, metaRef, championUserId) {
  const participants = await loadParticipants(root, cycleId);
  const champion = participants.find(p => p.userId === championUserId);

  const allMatches = await loadAllMatches(root, cycleId);
  const contestedDesc = allMatches
    .filter(m => m.status === 'completed' && m.slotAUserId && m.slotBUserId && m.winnerUserId)
    .sort((a, b) => (b.roundIndex || 0) - (a.roundIndex || 0));

  let runnerUpId = null;
  for (const m of contestedDesc) {
    const loser = m.winnerUserId === m.slotAUserId ? m.slotBUserId : m.slotAUserId;
    if (loser && loser !== championUserId) { runnerUpId = loser; break; }
  }
  if (!runnerUpId) {
    const bracketMatches = allMatches.filter(m => m.slotAUserId && m.slotAUserId !== championUserId);
    if (bracketMatches.length > 0) runnerUpId = bracketMatches[0].slotAUserId;
  }

  // Top 8 = the eight players who progressed FURTHEST through the bracket.
  // Ranking precedence:
  //   1) higher max round-index reached
  //   2) ...with a win in that round (winners outrank losers of the same round)
  //   3) ...higher swissPoints (only meaningful if swiss rounds were played)
  //   4) ...higher ELO as a final tie-breaker
  // The previous implementation sorted purely on swissPoints which is ZERO
  // for everyone in pure single-elimination mode, so the Top-8 reward bucket
  // ended up containing an arbitrary 8 participants (sorted by userId by
  // Firestore) instead of the true quarter-finalists.
  const reachStats = new Map();
  for (const p of participants) {
    reachStats.set(p.userId, { reached: -1, wonReached: false });
  }
  for (const m of allMatches) {
    if (!m || typeof m.roundIndex !== 'number') continue;
    if (m.status !== 'completed') continue;
    const round = m.roundIndex;
    const slots = [m.slotAUserId, m.slotBUserId].filter(Boolean);
    for (const uid of slots) {
      const s = reachStats.get(uid);
      if (!s) continue;
      if (round > s.reached) {
        s.reached = round;
        s.wonReached = (uid === m.winnerUserId);
      } else if (round === s.reached && uid === m.winnerUserId) {
        s.wonReached = true;
      }
    }
  }
  const ranked = participants.slice().sort((a, b) => {
    const sa = reachStats.get(a.userId) || { reached: -1, wonReached: false };
    const sb = reachStats.get(b.userId) || { reached: -1, wonReached: false };
    if (sb.reached !== sa.reached) return sb.reached - sa.reached;
    if (sb.wonReached !== sa.wonReached) return sb.wonReached ? 1 : -1;
    const sp = (b.swissPoints || 0) - (a.swissPoints || 0);
    if (sp !== 0) return sp;
    return (b.elo || 0) - (a.elo || 0);
  });
  const top8 = ranked.slice(0, Math.min(8, ranked.length)).map(p => p.userId);

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
  console.log(`[tick] Finalized ${cycleId}. Champion=${championUserId} top8=${top8.join(',')}`);
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
  // Fusion session names must be globally unique across concurrently-running
  // rooms. The old `cycleId.slice(0, 8)` collapsed every multi-room cycle to
  // "weekly_C", so R001's Round 100 match 0 and R002's Round 100 match 0 would
  // share a session — dropping players from different leagues into the same
  // Fusion room. Use a compact short-hash of the full cycleId instead.
  const cycleToken = shortCycleToken(cycleId);
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const docId = `R${roundIndex}_M${i}`;
    const sessionName = p.slotBUserId
      ? `${sessionPrefix}_${cycleToken}_R${roundIndex}_M${i}`
      : '';
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

/**
 * Deterministic 8-char base36 token derived from the full cycleId. Guarantees
 * distinct rooms of the same cycle get distinct Fusion session names while
 * keeping the human-readable name short. Not cryptographic — a weak hash is
 * fine here because the coordinator is the sole writer.
 */
function shortCycleToken(cycleId) {
  if (!cycleId) return 'cyc00000';
  let h1 = 0x12345678;
  let h2 = 0x87654321;
  for (let i = 0; i < cycleId.length; i++) {
    const c = cycleId.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c * 1099511) ^ (h1 >>> 3)) >>> 0;
  }
  const raw = (h1.toString(36) + h2.toString(36)).replace(/[^a-z0-9]/gi, '');
  return (raw + '00000000').slice(0, 8);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
