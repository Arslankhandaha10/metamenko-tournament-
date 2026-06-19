/**
 * Claim-processing pipeline (used by claims-tick.js).
 *
 * PULL-MODEL flow:
 *   For each pending_verify claim doc:
 *     1. Re-fetch top_winners/{cycleId} and confirm (cardName, nftName) is in
 *        the winners list.
 *     2. Confirm the claim window has not closed.
 *     3. Run on-chain ownership verification via verifyOwnership.js.
 *     4. If verified → atomic transaction:
 *          - APPEND a status="claimed" entry into muc_user_rewards/{uid}.rewards
 *            (idempotent on rewardId = "{cycleId}_{nftName}").
 *          - Flip claim doc → status="granted".
 *          - Stamp claimed=true + walletAddress on the winning NFT's entry
 *            inside muc_card_counters/{cycleId}.cards.
 *        If NOT verified → flip claim → "rejected_ownership".
 *     5. Fail safely on transient errors — the claim stays "pending_verify"
 *        for the next tick to retry.
 */
const { verifyOwnership } = require('./verifyOwnership');

/**
 * @param {{
 *   db: FirebaseFirestore.Firestore,
 *   admin: object,
 *   cfg: object,
 *   collections: { rewardClaims: string, userRewards: string, topWinners: string }
 * }} ctx
 */
async function processPendingClaims(ctx) {
  const { db, cfg, collections } = ctx;
  if (!db) throw new Error('processPendingClaims: db missing');

  const claimWindowMs = cfg.useTestingClaimWindow
    ? Math.max(60, cfg.claimWindowSecondsTesting || 60) * 1000
    : Math.max(1, cfg.claimWindowDays || 7) * 86400 * 1000;

  const pendingSnap = await db.collection(collections.rewardClaims)
    .where('status', '==', 'pending_verify')
    .limit(50)
    .get();

  if (pendingSnap.empty) {
    console.log('[muc][claims] No pending_verify claims.');
    return { processed: 0, granted: 0, rejected: 0 };
  }

  let processed = 0, granted = 0, rejected = 0;
  for (const docSnap of pendingSnap.docs) {
    const claim = docSnap.data() || {};
    const claimRef = docSnap.ref;
    const claimId = claim.claimId || docSnap.id;
    processed += 1;
    try {
      if (!claim.cycleId || !claim.cardName || !claim.nftName || !claim.uid) {
        await rejectClaim(claimRef, 'invalid_claim_fields');
        rejected += 1;
        continue;
      }
      const winnersRef = db.collection(collections.topWinners).doc(claim.cycleId);
      const winnersSnap = await winnersRef.get();
      if (!winnersSnap.exists) {
        await rejectClaim(claimRef, 'cycle_not_finalized');
        rejected += 1;
        continue;
      }
      const winnersDoc = winnersSnap.data() || {};
      const winners = Array.isArray(winnersDoc.winners) ? winnersDoc.winners : [];
      const matched = winners.find(w => w
        && String(w.cardName || '') === String(claim.cardName)
        && String(w.nftName || '') === String(claim.nftName));
      if (!matched) {
        await rejectClaim(claimRef, 'not_a_winner');
        rejected += 1;
        continue;
      }

      const cycleEnd = Number(winnersDoc.cycleEndMs) || 0;
      const nowMs = Date.now();
      if (cycleEnd > 0 && claimWindowMs > 0 && nowMs > cycleEnd + claimWindowMs) {
        await rejectClaim(claimRef, 'claim_window_closed');
        rejected += 1;
        continue;
      }

      const result = await verifyOwnership(
        { walletAddress: claim.walletAddress, claimedNftName: claim.nftName },
        cfg
      );
      if (!result.owned) {
        await rejectClaim(claimRef, 'ownership_' + (result.reason || 'unknown'));
        rejected += 1;
        continue;
      }

      await grantClaim({
        db,
        collections,
        claim,
        claimRef,
        matched,
        cycleEnd,
        claimWindowMs,
        gemAmount: Number(matched.gemAmount) || Math.max(0, cfg.gemReward || 0),
        cosmeticIdPlaceholder: cfg.cosmeticIdPlaceholder || ''
      });
      granted += 1;
      console.log(`[muc][claims] GRANTED claimId=${claimId} uid=${claim.uid} card=${claim.cardName} nft=${claim.nftName}`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.warn(`[muc][claims] Transient failure on claimId=${claimId}: ${msg} — leaving pending_verify for retry.`);
    }
  }
  return { processed, granted, rejected };
}

async function grantClaim({ db, collections, claim, claimRef, matched, cycleEnd, claimWindowMs, gemAmount, cosmeticIdPlaceholder }) {
  const userRef = db.collection(collections.userRewards).doc(claim.uid);
  const counterRef = (collections.cardCounters && claim.cycleId)
    ? db.collection(collections.cardCounters).doc(claim.cycleId)
    : null;
  const counterKey = (claim.nftName && String(claim.nftName)) || (matched && matched.cardName) || '';
  const rewardId = `${claim.cycleId}_${claim.nftName}`;
  const grantedAtMs = Date.now();
  const expiresAtMs = (cycleEnd > 0 && claimWindowMs > 0) ? cycleEnd + claimWindowMs : 0;

  await db.runTransaction(async (txn) => {
    const freshClaim = await txn.get(claimRef);
    if (!freshClaim.exists) throw new Error('claim_vanished');
    const fc = freshClaim.data() || {};
    if (fc.status && fc.status !== 'pending_verify') return;

    const userSnap = await txn.get(userRef);
    const existing = userSnap.exists ? (userSnap.data() || {}) : {};
    const existingRewards = Array.isArray(existing.rewards) ? existing.rewards.slice() : [];
    const existingIdx = existingRewards.findIndex(r => r && r.rewardId === rewardId);

    const entry = {
      rewardId,
      cycleId: claim.cycleId,
      cardName: matched.cardName,
      nftName: matched.nftName,
      kind: 'gems',
      amount: Math.max(0, gemAmount),
      cosmeticId: cosmeticIdPlaceholder,
      grantedAtMs,
      expiresAtMs,
      status: 'claimed',
      claimedAtMs: grantedAtMs,
      verificationFailReason: ''
    };

    if (existingIdx >= 0) {
      existingRewards[existingIdx] = entry;
    } else {
      existingRewards.push(entry);
    }

    txn.set(userRef, {
      uid: claim.uid,
      username: claim.username || existing.username || '',
      email: claim.email || existing.email || '',
      walletAddress: claim.walletAddress || existing.walletAddress || '',
      updatedAtMs: Date.now(),
      rewards: existingRewards
    }, { merge: true });

    txn.update(claimRef, {
      status: 'granted',
      processedAtMs: Date.now(),
      rejectedReason: ''
    });

    if (counterRef && counterKey) {
      txn.set(counterRef, {
        cards: {
          [counterKey]: {
            claimed: true,
            walletAddress: claim.walletAddress || ''
          }
        }
      }, { merge: true });
    }
  });
}

async function rejectClaim(claimRef, reason) {
  let status;
  if (reason && reason.startsWith('claim_window_')) status = 'rejected_window';
  else if (reason && reason.startsWith('ownership_')) status = 'rejected_ownership';
  else if (reason === 'not_a_winner') status = 'rejected_not_winner';
  else if (reason === 'cycle_not_finalized' || reason === 'invalid_claim_fields') status = 'rejected_invalid';
  else status = 'rejected_invalid';
  await claimRef.update({
    status,
    processedAtMs: Date.now(),
    rejectedReason: reason || 'unknown'
  });
}

module.exports = { processPendingClaims };
