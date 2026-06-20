/**
 * Pure cycle math — mirrors MucCycleHelper.cs to the millisecond.
 *
 * Both this file AND the C# helper read the SAME config doc shape, so client
 * and server agree on cycle boundaries forever.
 *
 * Two cycle models (selected by config):
 *   - FIXED   (default): uniform 'cycleDurationDays' from the epoch.
 *   - MONTHLY (useMonthlyCycle=true, production only): one cycle per calendar
 *     month. The active window runs from the 1st to (lastDay - claimWindowDays);
 *     the last 'claimWindowDays' days of the month are the claim window, which
 *     expires exactly at the next month's 1st. Month length is handled with
 *     DaysInMonth math so 28/29/30/31 all work automatically.
 *
 * Pure JS — no Firebase / Firestore deps. Unit-test friendly.
 */

const DAY_MS = 86400 * 1000;

function cycleDurationMs(cfg) {
  if (!cfg) return 0;
  if (cfg.useTestingMode) {
    return Math.max(60, cfg.cycleDurationSecondsTesting || 60) * 1000;
  }
  return Math.max(1, cfg.cycleDurationDays || 1) * DAY_MS;
}

function claimWindowMs(cfg) {
  if (!cfg) return 0;
  if (cfg.useTestingClaimWindow) {
    return Math.max(60, cfg.claimWindowSecondsTesting || 60) * 1000;
  }
  return Math.max(1, cfg.claimWindowDays || 1) * DAY_MS;
}

// In testing mode each slot = active duration + claim window, so the next cycle
// starts only AFTER the claim window ends (mirrors monthly-mode behaviour).
// In fixed production mode slot == cycleDuration (back-to-back, no gap).
function slotMs(cfg) {
  const dur = cycleDurationMs(cfg);
  if (cfg && cfg.useTestingMode) return dur + claimWindowMs(cfg);
  return dur;
}

function epochMs(cfg) {
  if (!cfg || !cfg.cycleEpochUtc) return Date.UTC(2026, 0, 1, 0, 0, 0);
  const t = Date.parse(cfg.cycleEpochUtc);
  if (isNaN(t)) return Date.UTC(2026, 0, 1, 0, 0, 0);
  return t;
}

// ── Monthly-mode helpers ────────────────────────────────────────────────────

// Calendar-month cycles apply only in production — testing mode always wins.
function useMonthly(cfg) {
  return !!(cfg && cfg.useMonthlyCycle) && !(cfg && cfg.useTestingMode);
}

function epochMonthParts(cfg) {
  const d = new Date(epochMs(cfg));
  return { y: d.getUTCFullYear(), m0: d.getUTCMonth() };
}

function epochMonthStartMs(cfg) {
  const ep = epochMonthParts(cfg);
  return Date.UTC(ep.y, ep.m0, 1, 0, 0, 0);
}

// Days in a UTC month. month0 is 0-based; day 0 of the next month = last day.
function daysInUtcMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

// Claim-window length (days) clamped so the cycle keeps >=1 active day every month.
function monthlyClaimDays(cfg, daysInMonth) {
  let d = Math.max(1, (cfg && cfg.claimWindowDays) || 1);
  if (d > daysInMonth - 1) d = daysInMonth - 1;
  if (d < 1) d = 1;
  return d;
}

// ── Index-addressable bounds (work in BOTH models) ──────────────────────────

function cycleStartMsAt(cfg, idx) {
  if (idx < 0) idx = 0;
  if (useMonthly(cfg)) {
    const ep = epochMonthParts(cfg);
    const total = ep.m0 + idx;
    const year = ep.y + Math.floor(total / 12);
    const month0 = ((total % 12) + 12) % 12;
    return Date.UTC(year, month0, 1, 0, 0, 0);
  }
  return epochMs(cfg) + idx * slotMs(cfg);
}

function cycleEndMsAt(cfg, idx) {
  if (useMonthly(cfg)) {
    const startMs = cycleStartMsAt(cfg, idx);
    const d = new Date(startMs);
    const dim = daysInUtcMonth(d.getUTCFullYear(), d.getUTCMonth());
    const claimDays = monthlyClaimDays(cfg, dim);
    return startMs + (dim - claimDays) * DAY_MS;
  }
  return cycleStartMsAt(cfg, idx) + cycleDurationMs(cfg);
}

function cycleIndex(cfg, nowMs) {
  if (useMonthly(cfg)) {
    if (nowMs < epochMonthStartMs(cfg)) return 0;
    const ep = epochMonthParts(cfg);
    const d = new Date(nowMs);
    return (d.getUTCFullYear() - ep.y) * 12 + (d.getUTCMonth() - ep.m0);
  }
  const s = slotMs(cfg);
  if (s <= 0) return 0;
  const ep = epochMs(cfg);
  if (nowMs < ep) return 0;
  return Math.floor((nowMs - ep) / s);
}

function cycleStartMs(cfg, nowMs) {
  return cycleStartMsAt(cfg, cycleIndex(cfg, nowMs));
}

function cycleEndMs(cfg, nowMs) {
  return cycleEndMsAt(cfg, cycleIndex(cfg, nowMs));
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
  const start = cycleStartMsAt(cfg, idx);
  return `${prefix}_C${pad4(idx)}-${formatYmdUtc(start)}`;
}

function previousCycleId(cfg, nowMs) {
  const prefix = (cfg && cfg.cycleIdPrefix) || 'muc';
  const idx = cycleIndex(cfg, nowMs);
  if (idx <= 0) return '';
  const prevStart = cycleStartMsAt(cfg, idx - 1);
  return `${prefix}_C${pad4(idx - 1)}-${formatYmdUtc(prevStart)}`;
}

module.exports = {
  cycleDurationMs,
  claimWindowMs,
  slotMs,
  epochMs,
  useMonthly,
  cycleIndex,
  cycleStartMs,
  cycleEndMs,
  cycleStartMsAt,
  cycleEndMsAt,
  cycleId,
  previousCycleId
};
