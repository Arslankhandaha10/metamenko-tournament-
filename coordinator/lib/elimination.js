/**
 * Single-elimination bracket helpers.
 * Pairs winners of round R into round R+1 matches.
 */

/** Build round 0 from a sorted seed list (highest seed first). */
function buildRoundZero(seeds) {
  const pairs = [];
  const half = Math.floor(seeds.length / 2);
  for (let i = 0; i < half; i++) {
    pairs.push({ slotAUserId: seeds[i], slotBUserId: seeds[seeds.length - 1 - i] });
  }
  if (seeds.length % 2 === 1) {
    pairs.push({ slotAUserId: seeds[half], slotBUserId: null });
  }
  return pairs;
}

/** Pair winners (in match order) for the next round. */
function nextRoundFromWinners(winners) {
  const pairs = [];
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i];
    const b = i + 1 < winners.length ? winners[i + 1] : null;
    pairs.push({ slotAUserId: a, slotBUserId: b });
  }
  return pairs;
}

module.exports = { buildRoundZero, nextRoundFromWinners };
