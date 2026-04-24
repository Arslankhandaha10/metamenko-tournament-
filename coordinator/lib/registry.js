/**
 * Coordinator-side helpers for the per-cycleBase registry document.
 *
 * Mirror of WtRoomRegistryDto (C#) — keep field names identical.
 * Registry path: {registryCollection}/{cycleBase}
 * Typical registryCollection: "tournament_registry".
 *
 * A registry doc tracks every league room that was spawned for a given
 * cycleBase (e.g. "weekly_C0003-2026-04-13"): their participant count,
 * full/completed status, and the ELO band each one represents. The Unity
 * client writes it inside a Firestore transaction on registration; the
 * coordinator reads it here to know which rooms it should iterate.
 */
const { db } = require('./firebase');

function registryCollectionName(cfg) {
  return (cfg && cfg.registryCollection) ? cfg.registryCollection : 'tournament_registry';
}

async function loadRegistry(cfg, cycleBase) {
  const col = registryCollectionName(cfg);
  const snap = await db().collection(col).doc(cycleBase).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  // Normalize — older docs may miss newer arrays.
  if (!Array.isArray(data.rooms)) data.rooms = [];
  if (!Array.isArray(data.openBandKeys)) data.openBandKeys = [];
  if (!Array.isArray(data.openBandRoomIds)) data.openBandRoomIds = [];
  if (typeof data.nextRoomIndex !== 'number') data.nextRoomIndex = (data.rooms.length + 1) || 1;
  if (typeof data.totalParticipants !== 'number') data.totalParticipants = 0;
  return data;
}

async function listRooms(cfg, cycleBase) {
  const reg = await loadRegistry(cfg, cycleBase);
  if (!reg) return [];
  return reg.rooms || [];
}

async function markRoomCompleted(cfg, cycleBase, roomId) {
  const col = registryCollectionName(cfg);
  const ref = db().collection(col).doc(cycleBase);
  await db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    const reg = snap.data() || {};
    if (!Array.isArray(reg.rooms)) reg.rooms = [];
    const r = reg.rooms.find(x => x && x.roomId === roomId);
    if (r) r.completed = true;
    // Drop open-band pointer if it was pointing here.
    if (Array.isArray(reg.openBandKeys) && Array.isArray(reg.openBandRoomIds)) {
      const i = reg.openBandRoomIds.indexOf(roomId);
      if (i >= 0) {
        reg.openBandKeys.splice(i, 1);
        reg.openBandRoomIds.splice(i, 1);
      }
    }
    txn.set(ref, reg);
  });
}

module.exports = { registryCollectionName, loadRegistry, listRooms, markRoomCompleted };
