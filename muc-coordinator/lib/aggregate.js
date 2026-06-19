/**
 * Pure aggregation — SINGLE-DOC MODEL.
 *
 * Each MucUsageEvent doc is ONE MATCH and carries a `cards` array
 * (the unique cards the player played that match). Returns a
 * Map<nftKey, { nftName, cardName, count }> keyed by NFT name (stable
 * on-chain identity), falling back to cardName when NFT name is empty.
 *
 * The coordinator runs this at cycle-end to produce the AUTHORITATIVE counter
 * set, overwriting any drift from optimistic client-side increments.
 *
 * Pure — no Firebase / Firestore deps. Unit-test friendly.
 */

/**
 * @param {Array<{cycleId, userId, matchId, cards: Array<{cardName, nftName}>}>} events
 * @returns {Map<string, {nftName: string, cardName: string, count: number}>}
 */
function aggregate(events) {
  const counters = new Map();
  if (!Array.isArray(events)) return counters;

  // Dedup per (matchId, userId, nftKey) as defence-in-depth against malformed
  // clients writing the same card twice or duplicate match events.
  const seen = new Set();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || !Array.isArray(e.cards)) continue;

    for (let j = 0; j < e.cards.length; j++) {
      const card = e.cards[j];
      if (!card) continue;
      const nftKey = (card.nftName && String(card.nftName)) || (card.cardName && String(card.cardName));
      if (!nftKey) continue;

      const tupleKey = `${e.matchId || ''}|${e.userId || ''}|${nftKey}`;
      if (seen.has(tupleKey)) continue;
      seen.add(tupleKey);

      if (!counters.has(nftKey)) {
        counters.set(nftKey, {
          nftName: card.nftName || '',
          cardName: card.cardName || '',
          count: 0
        });
      }
      const c = counters.get(nftKey);
      c.count += 1;
      if (!c.nftName && card.nftName) c.nftName = card.nftName;
      if (!c.cardName && card.cardName) c.cardName = card.cardName;
    }
  }

  return counters;
}

module.exports = { aggregate };
