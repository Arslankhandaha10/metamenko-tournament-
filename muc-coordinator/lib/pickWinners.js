/**
 * Pure winner picking — given an aggregated counter map (or array), returns
 * the top-N cards with stable tie handling.
 *
 * Tie semantics: all tied cards receive rewards (even if that takes past topN).
 * Rank uses standard competition ranking: 1, 1, 3 (gaps after ties).
 *
 * Pure — no Firebase / Firestore deps. Unit-test friendly.
 */

/**
 * @param {Map<string, {cardName, nftName, count}> | Array<{cardName, nftName, count}>} counters
 * @param {number} topN  — minimum number of distinct count tiers to include
 * @returns {Array<{rank, cardName, nftName, count}>}
 */
function pickWinners(counters, topN) {
  if (!counters) return [];
  const list = Array.isArray(counters) ? counters.slice() : Array.from(counters.values());
  if (list.length === 0) return [];

  // Sort: count desc; nftName asc for stable ordering across runs.
  list.sort((a, b) => {
    const dc = (b.count || 0) - (a.count || 0);
    if (dc !== 0) return dc;
    return String(a.nftName || '').localeCompare(String(b.nftName || ''));
  });

  const targetN = Math.max(1, parseInt(topN, 10) || 1);
  const winners = [];
  let lastCount = -1;
  let rank = 0;
  let distinctTiersIncluded = 0;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !c.cardName) continue;
    const count = c.count || 0;
    if (count <= 0) break; // never reward a card with zero usage

    if (count !== lastCount) {
      rank = i + 1;
      lastCount = count;
      distinctTiersIncluded += 1;
      if (distinctTiersIncluded > targetN) break;
    }

    winners.push({
      rank,
      cardName: c.cardName,
      nftName: c.nftName || '',
      count
    });
  }

  return winners;
}

module.exports = { pickWinners };
