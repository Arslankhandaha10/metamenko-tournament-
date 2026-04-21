/**
 * Mirror of Unity's WtCycleHelper.cs — keep these formulas identical.
 */

const PHASE = Object.freeze({
  Idle: 'Idle',
  Registration: 'Registration',
  SwissInProgress: 'SwissInProgress',
  SwissComplete: 'SwissComplete',
  Top8: 'Top8',
  Finals: 'Finals',
  Complete: 'Complete'
});

function epochUtc(config) {
  const dt = new Date(config.cycleEpochUtc);
  if (Number.isNaN(dt.getTime())) {
    return new Date(Date.UTC(2026, 0, 5)); // 2026-01-05
  }
  return dt;
}

function cycleDurationMs(config) {
  // Testing mode: HOURS instead of DAYS so a full tournament fits in <1h.
  // Mirrors WtConfig.CycleDuration in C#. KEEP IN SYNC.
  if (config && config.useTestingHourMode === true) {
    return Math.max(1, Number(config.cycleDurationHours || 1)) * 60 * 60 * 1000;
  }
  return Math.max(1, Number(config.cycleDurationDays || 7)) * 24 * 60 * 60 * 1000;
}

function currentCycleIndex(config, nowUtc = new Date()) {
  const epoch = epochUtc(config);
  if (nowUtc < epoch) return -1;
  return Math.floor((nowUtc - epoch) / cycleDurationMs(config));
}

function currentCycleStart(config, nowUtc = new Date()) {
  const idx = Math.max(0, currentCycleIndex(config, nowUtc));
  return new Date(epochUtc(config).getTime() + idx * cycleDurationMs(config));
}

function currentCycleEnd(config, nowUtc = new Date()) {
  return new Date(currentCycleStart(config, nowUtc).getTime() + cycleDurationMs(config));
}

function currentCycleId(config, nowUtc = new Date()) {
  const idx = currentCycleIndex(config, nowUtc);
  const start = currentCycleStart(config, nowUtc);
  const yyyy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(start.getUTCDate()).padStart(2, '0');
  return `C${String(idx).padStart(4, '0')}-${yyyy}-${mm}-${dd}`;
}

function progressFraction(config, nowUtc = new Date()) {
  const start = currentCycleStart(config, nowUtc);
  const total = cycleDurationMs(config);
  const elapsed = nowUtc - start;
  if (elapsed <= 0) return 0;
  if (elapsed >= total) return 1;
  return elapsed / total;
}

function expectedPhase(config, nowUtc = new Date()) {
  const p = progressFraction(config, nowUtc);
  if (p < (config.registrationOpenFraction ?? 0.0)) return PHASE.Idle;
  if (p < (config.registrationCloseFraction ?? 0.7)) return PHASE.Registration;
  if (p < (config.topCutStartFraction ?? 0.92)) return PHASE.SwissInProgress;
  if (p < (config.finalizeFraction ?? 0.99)) return PHASE.Top8;
  return PHASE.Complete;
}

module.exports = {
  PHASE, currentCycleIndex, currentCycleStart, currentCycleEnd,
  currentCycleId, progressFraction, expectedPhase
};
