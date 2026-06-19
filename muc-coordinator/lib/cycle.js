/**
 * Pure cycle math — mirrors MucCycleHelper.cs to the millisecond.
 *
 * Both this file AND the C# helper read the SAME config doc shape, so client
 * and server agree on cycle boundaries forever.
 *
 * Pure JS — no Firebase / Firestore deps. Unit-test friendly.
 */

function cycleDurationMs(cfg) {
  if (!cfg) return 0;
  if (cfg.useTestingMode) {
    return Math.max(60, cfg.cycleDurationSecondsTesting || 60) * 1000;
  }
  return Math.max(1, cfg.cycleDurationDays || 1) * 86400 * 1000;
}

function claimWindowMs(cfg) {
  if (!cfg) return 0;
  if (cfg.useTestingClaimWindow) {
    return Math.max(60, cfg.claimWindowSecondsTesting || 60) * 1000;
  }
  return Math.max(1, cfg.claimWindowDays || 1) * 86400 * 1000;
}

function epochMs(cfg) {
  if (!cfg || !cfg.cycleEpochUtc) return Date.UTC(2026, 0, 1, 0, 0, 0);
  const t = Date.parse(cfg.cycleEpochUtc);
  if (isNaN(t)) return Date.UTC(2026, 0, 1, 0, 0, 0);
  return t;
}

function cycleIndex(cfg, nowMs) {
  const dur = cycleDurationMs(cfg);
  if (dur <= 0) return 0;
  const ep = epochMs(cfg);
  if (nowMs < ep) return 0;
  return Math.floor((nowMs - ep) / dur);
}

function cycleStartMs(cfg, nowMs) {
  const idx = cycleIndex(cfg, nowMs);
  return epochMs(cfg) + idx * cycleDurationMs(cfg);
}

function cycleEndMs(cfg, nowMs) {
  return cycleStartMs(cfg, nowMs) + cycleDurationMs(cfg);
}

function pad4(n) { return String(n).padStart(4, '0'); }

function formatYmdUtc(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function cycleId(cfg, nowMs) {
  const prefix = (cfg && cfg.cycleIdPrefix) || 'muc';
  const idx = cycleIndex(cfg, nowMs);
  const start = cycleStartMs(cfg, nowMs);
  return `${prefix}_C${pad4(idx)}-${formatYmdUtc(start)}`;
}

function previousCycleId(cfg, nowMs) {
  const prefix = (cfg && cfg.cycleIdPrefix) || 'muc';
  const idx = cycleIndex(cfg, nowMs);
  if (idx <= 0) return '';
  const ep = epochMs(cfg);
  const dur = cycleDurationMs(cfg);
  const prevStart = ep + (idx - 1) * dur;
  return `${prefix}_C${pad4(idx - 1)}-${formatYmdUtc(prevStart)}`;
}

module.exports = {
  cycleDurationMs,
  claimWindowMs,
  epochMs,
  cycleIndex,
  cycleStartMs,
  cycleEndMs,
  cycleId,
  previousCycleId
};
