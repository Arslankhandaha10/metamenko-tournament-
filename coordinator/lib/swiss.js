/**
 * Simple Swiss pairing — greedy by points, avoids re-pairing same opponents when possible.
 * Returns array of { slotAUserId, slotBUserId } for the next round.
 * `participants` items: { userId, swissPoints, opponents:[userId,...], eliminated:false }
 */
function nextSwissRound(participants) {
  const active = participants
    .filter(p => !p.eliminated)
    .slice()
    .sort((a, b) => (b.swissPoints || 0) - (a.swissPoints || 0));

  const pairs = [];
  const used = new Set();

  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (used.has(a.userId)) continue;

    let pickedJ = -1;
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (used.has(b.userId)) continue;
      const repeat = (a.opponents || []).includes(b.userId);
      if (!repeat) { pickedJ = j; break; }
    }
    if (pickedJ === -1) {
      // No fresh opponent — accept a repeat or give a bye
      for (let j = i + 1; j < active.length; j++) {
        if (!used.has(active[j].userId)) { pickedJ = j; break; }
      }
    }

    if (pickedJ === -1) {
      // bye
      pairs.push({ slotAUserId: a.userId, slotBUserId: null });
      used.add(a.userId);
    } else {
      const b = active[pickedJ];
      pairs.push({ slotAUserId: a.userId, slotBUserId: b.userId });
      used.add(a.userId); used.add(b.userId);
    }
  }
  return pairs;
}

module.exports = { nextSwissRound };
