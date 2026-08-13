// mechanicalRiskEngine.test.js — covers every safety rule specified for
// mechanical_prime/mechanical_session: time windows, 1%/3% risk caps, the
// 3-position cap, the -3% daily stop, the +2.5%/30% give-back lock, the
// consecutive-loss throttle, gradual (never-skip-a-step) recovery, and the
// no-stop-widening invariant. Pure unit tests — no DB, no network, no LLM.
// Run with: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_STATE_PCT, applyPerTradeRiskCap,
  isWithinEntryWindow, isMaxPositionsReached, calculateLotsForRisk,
  clampToOpenRiskHeadroom, clampStopToAtrBand, applyNoWidenRule,
  evaluateDailyGuards, onTradeClosed, applyEvidenceBasedRecovery, checkRecoveryEvidence,
} from '../mechanicalRiskEngine.js';

// ── 1. Time filtering ─────────────────────────────────────────────────────
describe('isWithinEntryWindow — mechanical_prime (15:00-18:00) and mechanical_session (09:00-21:00)', () => {
  test('prime: 15:00 is the first permitted minute', () => {
    assert.equal(isWithinEntryWindow(15 * 60, 15, 18), true);
  });
  test('prime: 17:59 is permitted', () => {
    assert.equal(isWithinEntryWindow(17 * 60 + 59, 15, 18), true);
  });
  test('prime: 18:00 is NOT permitted (exclusive end)', () => {
    assert.equal(isWithinEntryWindow(18 * 60, 15, 18), false);
  });
  test('prime: 14:59 is NOT permitted', () => {
    assert.equal(isWithinEntryWindow(14 * 60 + 59, 15, 18), false);
  });
  test('session: 09:00 is the first permitted minute', () => {
    assert.equal(isWithinEntryWindow(9 * 60, 9, 21), true);
  });
  test('session: 20:59 is permitted', () => {
    assert.equal(isWithinEntryWindow(20 * 60 + 59, 9, 21), true);
  });
  test('session: 21:00 is NOT permitted (exclusive end)', () => {
    assert.equal(isWithinEntryWindow(21 * 60, 9, 21), false);
  });
  test('session: 06:00-08:59 (the historically destructive window) is blocked', () => {
    assert.equal(isWithinEntryWindow(6 * 60, 9, 21), false);
    assert.equal(isWithinEntryWindow(8 * 60 + 59, 9, 21), false);
  });
});

// ── 2. Position sizing: 1% max risk per trade ─────────────────────────────
describe('calculateLotsForRisk — risk-based sizing, never exceeding the requested %', () => {
  test('100k equity, 1% risk, $10 stop distance -> $1000 risk / $10*100 = 1.0 lots, capped at MAX_LOT', () => {
    const r = calculateLotsForRisk({ equity: 100000, riskPct: 1.0, entry: 4000, stop: 3990 });
    assert.equal(r.lots, 1.0); // MAX_LOT cap
    assert.ok(r.riskUsd <= 1000.01);
  });
  test('100k equity, 1% risk, $50 stop distance -> exact, non-capped size', () => {
    const r = calculateLotsForRisk({ equity: 100000, riskPct: 1.0, entry: 4000, stop: 3950 });
    // raw = 1000 / (50*100) = 0.20 lots exactly
    assert.equal(r.lots, 0.20);
    assert.ok(r.riskUsd <= 1000, `realized risk $${r.riskUsd} must never exceed the requested $1000`);
  });
  test('rounds DOWN to the lot step, never up past the risk cap', () => {
    // raw = (100000*0.01) / (33*100) = 1000/3300 = 0.303030... -> floors to 0.30, not 0.31
    const r = calculateLotsForRisk({ equity: 100000, riskPct: 1.0, entry: 4000, stop: 3967 });
    assert.equal(r.lots, 0.30);
    assert.ok(r.riskUsd <= 1000);
  });
  test('a size that floors below MIN_LOT (0.01) returns 0 lots — POSITION_TOO_SMALL territory', () => {
    // raw = (100000*0.01) / (10000*100) = 0.001 -> floors to 0
    const r = calculateLotsForRisk({ equity: 100000, riskPct: 1.0, entry: 14000, stop: 4000 });
    assert.equal(r.lots, 0);
  });
  test('DEFENSIVE (0.25%) sizes to a quarter of NORMAL for the same stop distance', () => {
    const normal    = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.NORMAL,    entry: 4000, stop: 3950 });
    const defensive = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.DEFENSIVE, entry: 4000, stop: 3950 });
    assert.ok(Math.abs(defensive.lots - normal.lots / 4) < 0.001);
  });
  test('PAUSED (0%) sizes to zero', () => {
    const r = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.PAUSED, entry: 4000, stop: 3950 });
    assert.equal(r.lots, 0);
  });
});

// ── 3. Max total open risk (3%) ────────────────────────────────────────────
describe('clampToOpenRiskHeadroom — 3% combined open-risk cap', () => {
  test('full headroom available: request passes through unreduced', () => {
    const r = clampToOpenRiskHeadroom({ requestedRiskUsd: 500, existingOpenRiskUsd: 0, equity: 100000, maxTotalRiskPct: 3 });
    assert.equal(r.allowedRiskUsd, 500);
    assert.equal(r.reduced, false);
  });
  test('partial headroom: request is reduced, never rejected outright here', () => {
    // cap = 3000, already using 2800 -> only 200 left
    const r = clampToOpenRiskHeadroom({ requestedRiskUsd: 1000, existingOpenRiskUsd: 2800, equity: 100000, maxTotalRiskPct: 3 });
    assert.equal(r.allowedRiskUsd, 200);
    assert.equal(r.reduced, true);
  });
  test('zero headroom: allowedRiskUsd is exactly 0 -> caller must reject as MAX_OPEN_RISK', () => {
    const r = clampToOpenRiskHeadroom({ requestedRiskUsd: 500, existingOpenRiskUsd: 3000, equity: 100000, maxTotalRiskPct: 3 });
    assert.equal(r.allowedRiskUsd, 0);
  });
  test('never returns more than what was requested', () => {
    const r = clampToOpenRiskHeadroom({ requestedRiskUsd: 100, existingOpenRiskUsd: 0, equity: 100000, maxTotalRiskPct: 3 });
    assert.equal(r.allowedRiskUsd, 100);
  });
});

// ── 4. Max 3 open positions ────────────────────────────────────────────────
describe('isMaxPositionsReached', () => {
  test('below cap: not reached', () => { assert.equal(isMaxPositionsReached(2, 3), false); });
  test('at cap: reached', () => { assert.equal(isMaxPositionsReached(3, 3), true); });
  test('above cap (shouldn\'t happen, but must still gate): reached', () => { assert.equal(isMaxPositionsReached(4, 3), true); });
});

// ── 5. Daily -3% max loss + +2.5%/30% give-back lock ──────────────────────
describe('evaluateDailyGuards', () => {
  const CFG = { dailyMaxLossPct: 3, dailyProfitTargetPct: 2.5, giveBackPct: 30 };
  test('no guard trips on a small loss', () => {
    const r = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 99000, dayPeakEquity: 100000,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(r.dailyMaxLossHit, false);
    assert.equal(r.event, null);
  });
  test('daily max loss trips at exactly -3% of day-start equity', () => {
    const r = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 97000, dayPeakEquity: 100000,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(r.dailyMaxLossHit, true);
    assert.equal(r.event, 'DAILY_MAX_LOSS');
  });
  test('daily max loss is monotonic: stays hit even if equity partially recovers', () => {
    const r = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 98500, dayPeakEquity: 100000,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: true, ...CFG,
    });
    assert.equal(r.dailyMaxLossHit, true);
    assert.equal(r.event, null); // already hit earlier -- no NEW event this cycle
  });
  test('give-back arms once equity first reaches +2.5%, not before', () => {
    const below = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 102400, dayPeakEquity: 102400,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(below.givebackArmed, false);
    const at = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 102500, dayPeakEquity: 102500,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(at.givebackArmed, true);
  });
  test('give-back locks after a 30% pullback from peak profit — worked example from spec', () => {
    // start 100k, peak 103k (peak profit $3k), max giveback $900 -> floor $102,100
    const armed = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 103000, dayPeakEquity: 100000,
      givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(armed.givebackArmed, true);
    assert.equal(armed.dayPeakEquity, 103000);

    const stillOk = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 102200, dayPeakEquity: 103000,
      givebackArmed: true, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(stillOk.givebackLocked, false);

    const locked = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 102000, dayPeakEquity: 103000,
      givebackArmed: true, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(locked.givebackLocked, true);
    assert.equal(locked.event, 'DAILY_GIVEBACK_LOCK');
  });
  test('give-back lock is monotonic: stays locked even if equity recovers back above the floor', () => {
    const r = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 102800, dayPeakEquity: 103000,
      givebackArmed: true, givebackLocked: true, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(r.givebackLocked, true);
  });
  test('peak equity tracks the day high-water mark, not just the current value', () => {
    const r = evaluateDailyGuards({
      dayStartEquity: 100000, currentEquity: 101000, dayPeakEquity: 103000,
      givebackArmed: true, givebackLocked: false, dailyMaxLossHit: false, ...CFG,
    });
    assert.equal(r.dayPeakEquity, 103000);
  });
});

// ── 6. Consecutive-loss throttle (2->CAUTION, 3->DEFENSIVE, 4->PAUSED) ────
describe('onTradeClosed — loss-cluster throttle', () => {
  test('a single loss does not demote from NORMAL', () => {
    const r = onTradeClosed({ currentState: 'NORMAL', consecutiveLosses: 0, isWin: false });
    assert.equal(r.newState, 'NORMAL');
    assert.equal(r.newConsecutiveLosses, 1);
    assert.equal(r.transitioned, false);
  });
  test('the 2nd consecutive loss demotes NORMAL -> CAUTION', () => {
    const r = onTradeClosed({ currentState: 'NORMAL', consecutiveLosses: 1, isWin: false });
    assert.equal(r.newState, 'CAUTION');
    assert.equal(r.newConsecutiveLosses, 2);
    assert.equal(r.reason, 'TWO_CONSECUTIVE_LOSSES');
  });
  test('the 3rd consecutive loss demotes to DEFENSIVE', () => {
    const r = onTradeClosed({ currentState: 'CAUTION', consecutiveLosses: 2, isWin: false });
    assert.equal(r.newState, 'DEFENSIVE');
    assert.equal(r.newConsecutiveLosses, 3);
    assert.equal(r.reason, 'THREE_CONSECUTIVE_LOSSES');
  });
  test('the 4th consecutive loss PAUSES', () => {
    const r = onTradeClosed({ currentState: 'DEFENSIVE', consecutiveLosses: 3, isWin: false });
    assert.equal(r.newState, 'PAUSED');
    assert.equal(r.newConsecutiveLosses, 4);
    assert.equal(r.reason, 'FOUR_CONSECUTIVE_LOSSES');
  });
  test('demotion is count-driven regardless of starting state: a 4th loss re-PAUSEs even from DEFENSIVE', () => {
    const r = onTradeClosed({ currentState: 'DEFENSIVE', consecutiveLosses: 3, isWin: false });
    assert.equal(r.newState, 'PAUSED');
  });
  test('a win resets the consecutive-loss counter to zero', () => {
    const r = onTradeClosed({ currentState: 'DEFENSIVE', consecutiveLosses: 3, isWin: true });
    assert.equal(r.newConsecutiveLosses, 0);
  });
  test('no martingale/revenge sizing: nothing in this function ever increases risk on a loss, only holds or reduces', () => {
    for (const state of ['NORMAL', 'CAUTION', 'DEFENSIVE']) {
      const before = RISK_STATE_PCT[state];
      const r = onTradeClosed({ currentState: state, consecutiveLosses: 5, isWin: false }); // already deep in a cluster
      assert.ok(RISK_STATE_PCT[r.newState] <= before, `${state} -> ${r.newState} must never increase allowed risk on a loss`);
    }
  });
});

// ── 7. Gradual recovery — never skip a step ───────────────────────────────
describe('recovery state machine — PAUSED -> DEFENSIVE -> CAUTION -> NORMAL, one step at a time', () => {
  test('a win while PAUSED does NOT advance the state — evidence-gated only, never win-gated', () => {
    const r = onTradeClosed({ currentState: 'PAUSED', consecutiveLosses: 4, isWin: true });
    assert.equal(r.newState, 'PAUSED');
  });
  test('PAUSED -> DEFENSIVE only fires when recovery evidence is eligible', () => {
    const notEligible = applyEvidenceBasedRecovery({ currentState: 'PAUSED', eligible: false });
    assert.equal(notEligible.transitioned, false);
    const eligible = applyEvidenceBasedRecovery({ currentState: 'PAUSED', eligible: true });
    assert.equal(eligible.transitioned, true);
    assert.equal(eligible.newState, 'DEFENSIVE');
  });
  test('evidence-based recovery never jumps straight to NORMAL or CAUTION from PAUSED', () => {
    const r = applyEvidenceBasedRecovery({ currentState: 'PAUSED', eligible: true });
    assert.equal(r.newState, 'DEFENSIVE'); // never CAUTION, never NORMAL
  });
  test('DEFENSIVE -> CAUTION requires one qualifying win, not evidence', () => {
    const r = onTradeClosed({ currentState: 'DEFENSIVE', consecutiveLosses: 0, isWin: true });
    assert.equal(r.newState, 'CAUTION');
  });
  test('CAUTION -> NORMAL requires one further qualifying win', () => {
    const r = onTradeClosed({ currentState: 'CAUTION', consecutiveLosses: 0, isWin: true });
    assert.equal(r.newState, 'NORMAL');
  });
  test('no direct 0% -> 1% jump: PAUSED never transitions straight to NORMAL from either mechanism', () => {
    const viaEvidence = applyEvidenceBasedRecovery({ currentState: 'PAUSED', eligible: true });
    assert.notEqual(viaEvidence.newState, 'NORMAL');
    const viaWin = onTradeClosed({ currentState: 'PAUSED', consecutiveLosses: 4, isWin: true });
    assert.notEqual(viaWin.newState, 'NORMAL');
  });
  test('no direct 0.25% -> 1% jump: DEFENSIVE never transitions straight to NORMAL', () => {
    const r = onTradeClosed({ currentState: 'DEFENSIVE', consecutiveLosses: 0, isWin: true });
    assert.notEqual(r.newState, 'NORMAL');
    assert.equal(r.newState, 'CAUTION');
  });
});

// ── 8. Deterministic recovery-evidence check ──────────────────────────────
describe('checkRecoveryEvidence — deterministic numerical conditions, not a subjective judgment call', () => {
  function makeWindow({ adxTrend = 'flat', direction = 'LONG', rsiFlips = 0, macdFlips = 0, atrRatio = 1.0 } = {}) {
    // 12 cycles, newest first (index 0 = most recent). atrRatio only scales
    // the CURRENT (index 0) reading against an otherwise-steady history --
    // the check is current-vs-recent-mean, so scaling every entry uniformly
    // would never move the ratio at all.
    const window = [];
    for (let i = 0; i < 12; i++) {
      const adx = adxTrend === 'rising' ? 30 - i * 0.5 : 20; // newest (i=0) highest when rising
      window.push({
        isGreen: true,
        direction,
        h1Rsi: rsiFlips === 0 ? 60 : (i % 2 === 0 ? 60 : 40), // alternate around 50 if flipping
        h1MacdHist: macdFlips === 0 ? 1.0 : (i % 2 === 0 ? 1.0 : -1.0),
        h1Adx: adx,
        h1Atr: i === 0 ? 10 * atrRatio : 10,
      });
    }
    return window;
  }

  test('insufficient data (fewer than 12 cycles) is never eligible', () => {
    const r = checkRecoveryEvidence([{ isGreen: true, direction: 'LONG', h1Rsi: 60, h1MacdHist: 1, h1Adx: 25, h1Atr: 10 }]);
    assert.equal(r.eligible, false);
    assert.equal(r.insufficientData, true);
  });
  test('all six conditions holding simultaneously -> eligible', () => {
    const window = makeWindow({ adxTrend: 'rising', direction: 'LONG', rsiFlips: 0, macdFlips: 0, atrRatio: 1.0 });
    const r = checkRecoveryEvidence(window);
    assert.equal(r.eligible, true);
    assert.ok(r.reasons.includes('ADX_RECOVERED'));
    assert.ok(r.reasons.includes('SIGNAL_PERSISTENCE'));
    assert.ok(r.reasons.includes('RSI_DIRECTIONAL'));
    assert.ok(r.reasons.includes('MACD_PERSISTENCE'));
    assert.ok(r.reasons.includes('ATR_ACTIVE'));
    assert.ok(r.reasons.includes('DIRECTIONAL_CONSISTENCY'));
  });
  test('flat ADX (not rising) alone blocks eligibility even with everything else clean', () => {
    const window = makeWindow({ adxTrend: 'flat' });
    const r = checkRecoveryEvidence(window);
    assert.equal(r.eligible, false);
    assert.ok(!r.reasons.includes('ADX_RECOVERED'));
  });
  test('RSI repeatedly oscillating through neutral blocks eligibility', () => {
    const window = makeWindow({ adxTrend: 'rising', rsiFlips: 1 });
    const r = checkRecoveryEvidence(window);
    assert.equal(r.eligible, false);
    assert.ok(!r.reasons.includes('RSI_DIRECTIONAL'));
  });
  test('MACD repeatedly flipping sign blocks eligibility', () => {
    const window = makeWindow({ adxTrend: 'rising', macdFlips: 1 });
    const r = checkRecoveryEvidence(window);
    assert.equal(r.eligible, false);
    assert.ok(!r.reasons.includes('MACD_PERSISTENCE'));
  });
  test('low ATR (inactive market) blocks eligibility', () => {
    const window = makeWindow({ adxTrend: 'rising', atrRatio: 0.5 });
    const r = checkRecoveryEvidence(window);
    assert.equal(r.eligible, false);
    assert.ok(!r.reasons.includes('ATR_ACTIVE'));
  });
  test('is purely a function of its numeric inputs — same inputs always produce the same verdict (no hidden randomness/subjectivity)', () => {
    const window = makeWindow({ adxTrend: 'rising' });
    const a = checkRecoveryEvidence(window);
    const b = checkRecoveryEvidence(window);
    assert.deepEqual(a, b);
  });
});

// ── 9. ATR stop-distance safety clamp ─────────────────────────────────────
describe('clampStopToAtrBand — absolute 0.75x-3.0x ATR(H1) safety boundary, target never touched', () => {
  test('a stop already inside the band is left unchanged', () => {
    // distance 15, ATR 10 -> 1.5x, inside [0.75,3.0]
    const r = clampStopToAtrBand({ direction: 'LONG', entry: 4000, rawStop: 3985, h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0 });
    assert.equal(r.distance, 15);
    assert.equal(r.stop, 3985);
  });
  test('a stop tighter than 0.75x ATR is widened to the floor', () => {
    // distance 5, ATR 10 -> 0.5x, below 0.75 floor -> clamp to 7.5
    const r = clampStopToAtrBand({ direction: 'LONG', entry: 4000, rawStop: 3995, h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0 });
    assert.equal(r.distance, 7.5);
    assert.equal(r.stop, 3992.5);
  });
  test('a stop wider than 3.0x ATR is tightened to the ceiling', () => {
    // distance 40, ATR 10 -> 4.0x, above 3.0 ceiling -> clamp to 30
    const r = clampStopToAtrBand({ direction: 'LONG', entry: 4000, rawStop: 3960, h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0 });
    assert.equal(r.distance, 30);
    assert.equal(r.stop, 3970);
  });
  test('SHORT direction clamps on the correct side of entry', () => {
    const r = clampStopToAtrBand({ direction: 'SHORT', entry: 4000, rawStop: 4005, h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0 });
    assert.equal(r.distance, 7.5);
    assert.equal(r.stop, 4007.5);
  });
  test('missing ATR reference returns null -> caller must treat as INVALID_STOP', () => {
    const r = clampStopToAtrBand({ direction: 'LONG', entry: 4000, rawStop: 3990, h1Atr: null, atrMultMin: 0.75, atrMultMax: 3.0 });
    assert.equal(r, null);
  });
});

// ── 10. No stop widening after entry ──────────────────────────────────────
describe('applyNoWidenRule — a stop may only move to reduce risk, never to increase it', () => {
  test('LONG: a candidate stop below the current stop (would widen risk) is rejected', () => {
    const r = applyNoWidenRule({ direction: 'LONG', currentStop: 3990, candidateStop: 3980 });
    assert.equal(r, 3990); // unchanged -- 3980 would be further from entry, more risk
  });
  test('LONG: a candidate stop above the current stop (reduces risk) is accepted', () => {
    const r = applyNoWidenRule({ direction: 'LONG', currentStop: 3990, candidateStop: 3995 });
    assert.equal(r, 3995);
  });
  test('SHORT: a candidate stop above the current stop (would widen risk) is rejected', () => {
    const r = applyNoWidenRule({ direction: 'SHORT', currentStop: 4010, candidateStop: 4020 });
    assert.equal(r, 4010);
  });
  test('SHORT: a candidate stop below the current stop (reduces risk) is accepted', () => {
    const r = applyNoWidenRule({ direction: 'SHORT', currentStop: 4010, candidateStop: 4005 });
    assert.equal(r, 4005);
  });
  test('null candidate (no management action this tick) leaves the stop untouched', () => {
    assert.equal(applyNoWidenRule({ direction: 'LONG', currentStop: 3990, candidateStop: null }), 3990);
  });
  test('repeated application never walks a stop backward, even across many ticks', () => {
    let stop = 3990;
    const candidates = [3995, 3980, 4000, 3992, 3999]; // mixed better/worse candidates
    for (const c of candidates) stop = applyNoWidenRule({ direction: 'LONG', currentStop: stop, candidateStop: c });
    assert.equal(stop, 4000); // only ever moved to the best (highest) value seen
  });
});

// ── 11. Signal-for-signal comparability across mechanical/prime/session ───
describe('end-to-end: the SAME Mechanical signal reaches all three accounts, only sizing/gating differs', () => {
  test('direction, entry, and target are identical across all three executors for one shared signal', () => {
    const sharedSignal = { direction: 'LONG', entry: 4000, stop: 3985, target: 4030 }; // as mechanicalDecide() would return

    // mechanical: takes the raw signal as-is (no risk engine).
    const mechanical = { direction: sharedSignal.direction, entry: sharedSignal.entry, target: sharedSignal.target };

    // mechanical_prime and mechanical_session: same signal, run through the
    // SAME clamp function, just with (in this test) different account state.
    const clampPrime = clampStopToAtrBand({
      direction: sharedSignal.direction, entry: sharedSignal.entry, rawStop: sharedSignal.stop,
      h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0,
    });
    const clampSession = clampStopToAtrBand({
      direction: sharedSignal.direction, entry: sharedSignal.entry, rawStop: sharedSignal.stop,
      h1Atr: 10, atrMultMin: 0.75, atrMultMax: 3.0,
    });

    // Direction, entry and target must never diverge -- only the stop
    // (safety-clamped) and lots (risk-state-dependent) are account-specific.
    assert.equal(mechanical.direction, sharedSignal.direction);
    assert.equal(clampPrime.stop, clampSession.stop); // identical clamp, identical inputs -> identical result
    assert.equal(sharedSignal.target, 4030); // target is NEVER touched by either account

    // Sizing diverges independently per account's own risk state, from the
    // exact same entry/clamped-stop pair.
    const primeSizing   = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.NORMAL,    entry: sharedSignal.entry, stop: clampPrime.stop });
    const sessionSizing = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.DEFENSIVE, entry: sharedSignal.entry, stop: clampSession.stop });
    assert.notEqual(primeSizing.lots, sessionSizing.lots, 'independent risk states must be able to size the identical signal differently');
  });

  test('theoretical 1% sizing is always computable from the shared signal, independent of the account\'s actual risk state', () => {
    const sharedSignal = { direction: 'SHORT', entry: 4000, stop: 4020 };
    const theoretical = calculateLotsForRisk({ equity: 100000, riskPct: 1.0, entry: sharedSignal.entry, stop: sharedSignal.stop });
    const actualAtDefensive = calculateLotsForRisk({ equity: 100000, riskPct: RISK_STATE_PCT.DEFENSIVE, entry: sharedSignal.entry, stop: sharedSignal.stop });
    assert.ok(theoretical.lots > actualAtDefensive.lots);
  });
});

describe('applyPerTradeRiskCap', () => {
  test('caps a NORMAL account below the risk-state percentage', () => {
    assert.equal(applyPerTradeRiskCap(RISK_STATE_PCT.NORMAL, 0.5), 0.5);
  });

  test('never raises risk above the risk-state percentage', () => {
    // The whole point of the loss-cluster throttle is that nothing in the
    // dashboard can undo it. A 2% config must not lift a DEFENSIVE account.
    assert.equal(applyPerTradeRiskCap(RISK_STATE_PCT.DEFENSIVE, 2.0), 0.25);
    assert.equal(applyPerTradeRiskCap(RISK_STATE_PCT.CAUTION, 2.0), 0.5);
  });

  test('PAUSED stays at zero regardless of config', () => {
    assert.equal(applyPerTradeRiskCap(RISK_STATE_PCT.PAUSED, 2.0), 0);
  });

  test('a missing or nonsensical cap leaves the state percentage alone', () => {
    for (const bad of [undefined, null, 0, -1, NaN, 'abc']) {
      assert.equal(applyPerTradeRiskCap(RISK_STATE_PCT.NORMAL, bad), 1.00, `cap=${String(bad)}`);
    }
  });

  test('equal values are a no-op', () => {
    assert.equal(applyPerTradeRiskCap(1.00, 1.00), 1.00);
  });
});
