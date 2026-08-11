// mechanicalRiskEngine.js — pure, deterministic risk management for the
// mechanical_prime / mechanical_session accounts. Every function here is a
// plain function of its inputs: no I/O, no randomness, no AI judgment call.
// This is a hard safety floor — no Claude/AI component may bypass it.
//
// mechanical_prime and mechanical_session consume the exact same shared
// Mechanical signal (server.js calls mechanicalDecide() once per cycle);
// this module never generates or modifies a trade idea, only decides
// whether/how much to act on one it's handed.

import { MIN_LOT, MAX_LOT, LOT_STEP, VALUE_PER_LOT } from './contractSpec.js';

export const RISK_STATES = ['NORMAL', 'CAUTION', 'DEFENSIVE', 'PAUSED'];

// The only place these percentages are defined. Not exposed in the
// live-editable bot_config dashboard — deliberately: letting someone drag a
// slider here would reintroduce the subjective-override risk this entire
// module exists to remove.
export const RISK_STATE_PCT = { NORMAL: 1.00, CAUTION: 0.50, DEFENSIVE: 0.25, PAUSED: 0 };

export const REASON_CODES = [
  'OUTSIDE_PRIME_WINDOW', 'OUTSIDE_SESSION_WINDOW', 'LOSS_CLUSTER_PAUSE',
  'DAILY_MAX_LOSS', 'DAILY_GIVEBACK_LOCK', 'MAX_POSITIONS', 'MAX_OPEN_RISK',
  'POSITION_TOO_SMALL', 'INVALID_STOP',
];

// ── Entry time window ───────────────────────────────────────────────────
// [startHour:00, endHour:00) in UAE minutes-of-day. mechanical_prime:
// {15,18} → 15:00-17:59:59. mechanical_session: {9,21} → 09:00-20:59:59.
export function isWithinEntryWindow(uaeMinutesOfDay, startHour, endHour) {
  return uaeMinutesOfDay >= startHour * 60 && uaeMinutesOfDay < endHour * 60;
}

// ── Position sizing ──────────────────────────────────────────────────────
// Risk-based, derived from stop distance — never a fixed lot size. Rounds
// DOWN to the lot step so the realized risk can never exceed what was
// requested. Returns null lots (position too small) rather than ever
// rounding up past the risk cap.
export function calculateLotsForRisk({ equity, riskPct, entry, stop }) {
  const stopDistance = Math.abs(Number(entry) - Number(stop));
  if (!(stopDistance > 0) || !(equity > 0) || !(riskPct > 0)) {
    return { lots: 0, riskUsd: 0, riskPct: 0, stopDistance };
  }
  const riskUsd = equity * (riskPct / 100);
  const rawLots = riskUsd / (stopDistance * VALUE_PER_LOT);
  const flooredLots = Math.floor(rawLots / LOT_STEP) * LOT_STEP;
  const lots = Math.min(MAX_LOT, flooredLots);
  if (lots < MIN_LOT) {
    return { lots: 0, riskUsd: 0, riskPct: 0, stopDistance };
  }
  const actualRiskUsd = lots * stopDistance * VALUE_PER_LOT;
  return {
    lots: Math.round(lots * 100) / 100,
    riskUsd: actualRiskUsd,
    riskPct: (actualRiskUsd / equity) * 100,
    stopDistance,
  };
}

// ── Position count cap ───────────────────────────────────────────────────
export function isMaxPositionsReached(openPositionCount, maxOpenPositions) {
  return openPositionCount >= maxOpenPositions;
}

// ── Open-risk headroom ───────────────────────────────────────────────────
// Reduces (never rejects outright here — the caller rejects only if the
// reduced size floors below MIN_LOT) the requested risk to whatever
// headroom remains under the combined-open-risk cap.
export function clampToOpenRiskHeadroom({ requestedRiskUsd, existingOpenRiskUsd, equity, maxTotalRiskPct }) {
  const maxTotalRiskUsd = equity * (maxTotalRiskPct / 100);
  const headroomUsd = Math.max(0, maxTotalRiskUsd - existingOpenRiskUsd);
  const allowedRiskUsd = Math.min(requestedRiskUsd, headroomUsd);
  return { allowedRiskUsd, headroomUsd, reduced: allowedRiskUsd < requestedRiskUsd };
}

// ── Stop-distance ATR safety clamp ───────────────────────────────────────
// Mechanical's own stop is NOT ATR-derived (it comes from H4 MACD-histogram
// magnitude) — this is an absolute safety boundary layered on top, not a
// replacement for Mechanical's methodology. Target is never touched here.
export function clampStopToAtrBand({ direction, entry, rawStop, h1Atr, atrMultMin, atrMultMax }) {
  if (!(h1Atr > 0)) return null; // no ATR reference available -> caller must treat as INVALID_STOP
  const rawDistance = Math.abs(Number(entry) - Number(rawStop));
  if (!(rawDistance > 0)) return null;
  const minDist = atrMultMin * h1Atr;
  const maxDist = atrMultMax * h1Atr;
  const clampedDistance = Math.min(maxDist, Math.max(minDist, rawDistance));
  const stop = direction === 'LONG' ? entry - clampedDistance : entry + clampedDistance;
  return { stop, distance: clampedDistance, atrMultApplied: clampedDistance / h1Atr };
}

// Post-entry stop management: a stop may move to reduce risk, never to
// widen it. Returns the stop actually in force after considering a
// candidate new value — never further from entry, in the risk-reducing
// direction, than the current stop.
export function applyNoWidenRule({ direction, currentStop, candidateStop }) {
  if (candidateStop == null) return currentStop;
  if (direction === 'LONG') {
    // Reducing risk on a long means raising the stop, never lowering it.
    return Math.max(currentStop, candidateStop);
  }
  // Reducing risk on a short means lowering the stop, never raising it.
  return Math.min(currentStop, candidateStop);
}

// ── Daily guards: max loss + profit-protection give-back ────────────────
// Pure state transition: given yesterday's/this-morning's persisted day
// state and today's live numbers, returns the new day state plus which
// event (if any) fired THIS evaluation. Both dailyMaxLossHit and
// givebackLocked are monotonic for the day — once true, stay true
// regardless of equity recovering, exactly like a circuit breaker.
export function evaluateDailyGuards({
  dayStartEquity, currentEquity, dayPeakEquity,
  givebackArmed, givebackLocked, dailyMaxLossHit,
  dailyMaxLossPct, dailyProfitTargetPct, giveBackPct,
}) {
  const dayPnl = currentEquity - dayStartEquity;
  const newPeak = Math.max(dayPeakEquity ?? dayStartEquity, currentEquity);

  let newDailyMaxLossHit = dailyMaxLossHit;
  let event = null;
  if (!newDailyMaxLossHit && dayPnl <= -(dayStartEquity * (dailyMaxLossPct / 100))) {
    newDailyMaxLossHit = true;
    event = 'DAILY_MAX_LOSS';
  }

  let newGivebackArmed = givebackArmed;
  if (!newGivebackArmed && currentEquity >= dayStartEquity * (1 + dailyProfitTargetPct / 100)) {
    newGivebackArmed = true;
  }

  const peakProfit  = newPeak - dayStartEquity;
  const floorEquity = dayStartEquity + peakProfit * (1 - giveBackPct / 100);

  let newGivebackLocked = givebackLocked;
  if (newGivebackArmed && !newGivebackLocked && currentEquity < floorEquity) {
    newGivebackLocked = true;
    event = event ?? 'DAILY_GIVEBACK_LOCK';
  }

  return {
    dayPnl,
    dayPeakEquity: newPeak,
    givebackArmed: newGivebackArmed,
    givebackLocked: newGivebackLocked,
    dailyMaxLossHit: newDailyMaxLossHit,
    givebackRemainingUsd: newGivebackArmed ? Math.max(0, currentEquity - floorEquity) : null,
    event, // null | 'DAILY_MAX_LOSS' | 'DAILY_GIVEBACK_LOCK' — this cycle's transition, for logging
  };
}

// ── Loss-cluster throttle + gradual recovery state machine ──────────────
// consecutiveLosses is a single monotonic counter that only zeroes on a
// win — a state transition is not itself a trade outcome, so it never
// resets the counter directly. This keeps the loss-cluster count and the
// risk-state machine from falling out of sync (e.g. a 4th consecutive loss
// while already in DEFENSIVE must still re-PAUSE).
export function onTradeClosed({ currentState, consecutiveLosses, isWin }) {
  if (isWin) {
    const newConsecutiveLosses = 0;
    let newState = currentState;
    let reason = null;
    if (currentState === 'DEFENSIVE') { newState = 'CAUTION'; reason = 'QUALIFYING_WIN_DEFENSIVE_TO_CAUTION'; }
    else if (currentState === 'CAUTION') { newState = 'NORMAL'; reason = 'QUALIFYING_WIN_CAUTION_TO_NORMAL'; }
    // NORMAL stays NORMAL; PAUSED cannot advance on a win (evidence-gated only, see checkRecoveryEvidence).
    return { newState, newConsecutiveLosses, transitioned: newState !== currentState, reason };
  }

  // Demotion is driven purely by the count, independent of the state we
  // started this trade in — a 4th consecutive loss re-PAUSEs even if the
  // 3rd already put us in DEFENSIVE; a 1st loss alone never demotes.
  const newConsecutiveLosses = consecutiveLosses + 1;
  let newState = currentState;
  let reason = null;
  if (newConsecutiveLosses >= 4) {
    newState = 'PAUSED'; reason = 'FOUR_CONSECUTIVE_LOSSES';
  } else if (newConsecutiveLosses === 3) {
    newState = 'DEFENSIVE'; reason = 'THREE_CONSECUTIVE_LOSSES';
  } else if (newConsecutiveLosses === 2) {
    newState = 'CAUTION'; reason = 'TWO_CONSECUTIVE_LOSSES';
  }
  return { newState, newConsecutiveLosses, transitioned: newState !== currentState, reason };
}

// Evidence-gated PAUSED -> DEFENSIVE transition. Deliberately separate from
// onTradeClosed: this transition is driven by checkRecoveryEvidence, not by
// a trade outcome, and must never touch consecutiveLosses (per spec, a
// state transition is not itself a trade result — the loss-cluster count
// only ever changes on an actual closed trade).
export function applyEvidenceBasedRecovery({ currentState, eligible }) {
  if (currentState === 'PAUSED' && eligible) {
    return { newState: 'DEFENSIVE', transitioned: true, reason: 'PAUSED_TO_DEFENSIVE_EVIDENCE' };
  }
  return { newState: currentState, transitioned: false, reason: null };
}

// ── Deterministic PAUSED -> DEFENSIVE recovery evidence ──────────────────
// Only relevant while riskState === 'PAUSED'. `recentSignals` is the last
// up-to-12 Mechanical evaluation cycles, NEWEST FIRST, each
// {h1Rsi, h1MacdHist, h1Adx, h1Atr, isGreen, direction}. Deliberately
// simple, self-relative thresholds using only indicators already computed
// elsewhere — no new magic absolute constants beyond what's named here.
// ALL SIX must hold: a false-early-resume is worse than a delayed one.
const RECOVERY_WINDOW = 12;
const ADX_RISE_MIN = 2.0;
const RSI_MAX_FLIPS = 2;
const MACD_MAX_FLIPS = 1;
const ATR_MIN_RATIO = 0.8;
const MIN_PERSISTENT_SIGNALS = 3;
const MIN_RECENT_DIRECTIONAL = 3;

export function checkRecoveryEvidence(recentSignals) {
  const reasons = [];
  if (!Array.isArray(recentSignals) || recentSignals.length < RECOVERY_WINDOW) {
    return { eligible: false, reasons: [], insufficientData: true };
  }
  const window = recentSignals.slice(0, RECOVERY_WINDOW); // newest first

  // 1. ADX rising
  const adxNow = window[0]?.h1Adx, adxThen = window[RECOVERY_WINDOW - 1]?.h1Adx;
  const adxRising = adxNow != null && adxThen != null && adxNow >= adxThen + ADX_RISE_MIN;
  if (adxRising) reasons.push('ADX_RECOVERED');

  // 2. Mechanical signal persistence — same-direction GREEN signals in window
  let longCount = 0, shortCount = 0;
  for (const s of window) {
    if (!s.isGreen) continue;
    if (s.direction === 'LONG') longCount++;
    else if (s.direction === 'SHORT') shortCount++;
  }
  const signalPersistence = Math.max(longCount, shortCount) >= MIN_PERSISTENT_SIGNALS;
  if (signalPersistence) reasons.push('SIGNAL_PERSISTENCE');

  // 3. RSI no longer oscillating through neutral (sign of RSI-50 flips)
  const rsiFlips = countSignFlips(window.map(s => s.h1Rsi != null ? s.h1Rsi - 50 : null));
  const rsiDirectional = rsiFlips != null && rsiFlips <= RSI_MAX_FLIPS;
  if (rsiDirectional) reasons.push('RSI_DIRECTIONAL');

  // 4. MACD not repeatedly flipping (sign of H1 MACD histogram)
  const macdFlips = countSignFlips(window.map(s => s.h1MacdHist ?? null));
  const macdPersistence = macdFlips != null && macdFlips <= MACD_MAX_FLIPS;
  if (macdPersistence) reasons.push('MACD_PERSISTENCE');

  // 5. Sufficient ATR / market activity (current vs. window average)
  const atrValues = window.map(s => s.h1Atr).filter(v => v != null);
  const atrMean = atrValues.length ? atrValues.reduce((a, b) => a + b, 0) / atrValues.length : null;
  const atrActive = atrMean != null && window[0]?.h1Atr != null && window[0].h1Atr >= ATR_MIN_RATIO * atrMean;
  if (atrActive) reasons.push('ATR_ACTIVE');

  // 6. Directional consistency — most recent qualifying GREEN signals agree
  const recentGreens = window.filter(s => s.isGreen).slice(0, MIN_RECENT_DIRECTIONAL);
  const directionalConsistency = recentGreens.length >= MIN_RECENT_DIRECTIONAL &&
    recentGreens.every(s => s.direction === recentGreens[0].direction);
  if (directionalConsistency) reasons.push('DIRECTIONAL_CONSISTENCY');

  const eligible = adxRising && signalPersistence && rsiDirectional && macdPersistence && atrActive && directionalConsistency;
  return { eligible, reasons, insufficientData: false };
}

function countSignFlips(values) {
  const clean = values.filter(v => v != null && v !== 0);
  if (clean.length < 2) return null;
  let flips = 0;
  for (let i = 1; i < clean.length; i++) {
    if (Math.sign(clean[i]) !== Math.sign(clean[i - 1])) flips++;
  }
  return flips;
}
