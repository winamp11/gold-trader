// Mechanical stop/target placement (24 Sep 2026).
//
// Before: 964 of 964 mechanical stops landed on an exact $5 level, targets
// mirrored stops (median planned R:R 0.99), and the stop sat a median 0.82x
// H1 ATR from entry. What must not regress:
//   1. stop distance scales with H1 ATR, not H4 MACD
//   2. stops never sit on (or within the buffer of) a $5 level
//   3. target is TARGET_R x the actual stop distance, on the right side
//   4. missing ATR falls back to a sane distance rather than NaN
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import engine, { STOP_ATR_MULT, TARGET_R, ROUND_STEP, ROUND_BUFFER } from '../signalEngine.js';

const offRound = (p) => {
  const r = Math.round(p / ROUND_STEP) * ROUND_STEP;
  return Math.abs(p - r);
};

describe('placeStopTarget', () => {
  test('stop is STOP_ATR_MULT x ATR when that lands clear of a round level', () => {
    const entry = 4302.5, atr = 10;                  // raw stop 4287.5, 2.5 off
    const { stop } = engine.placeStopTarget('LONG', entry, atr, 8);
    assert.equal(stop, 4287.5);
    const s = engine.placeStopTarget('SHORT', entry, atr, 8);
    assert.equal(s.stop, 4317.5);
  });

  test('distance scales with ATR', () => {
    const a = engine.placeStopTarget('LONG', 4302.5, 10, 8);
    const b = engine.placeStopTarget('LONG', 4302.5, 20, 8);
    assert.ok(4302.5 - b.stop > 4302.5 - a.stop + 10);
  });

  test('never within the buffer of a $5 level — across a sweep of prices and ATRs', () => {
    for (let entry = 4200; entry < 4220; entry += 0.37) {
      for (const atr of [6, 9.3, 12, 15.9, 21.5, 30]) {
        for (const dir of ['LONG', 'SHORT']) {
          const { stop } = engine.placeStopTarget(dir, entry, atr, 8);
          assert.ok(offRound(stop) >= ROUND_BUFFER - 1e-9,
            `${dir} entry ${entry} atr ${atr} -> stop ${stop} is ${offRound(stop).toFixed(2)} off a round level`);
        }
      }
    }
  });

  test('a stop near a round level is pushed AWAY from entry, never tighter', () => {
    // raw LONG stop 4300.4 (0.4 above 4300) -> goes to 4298.5, below the level
    const l = engine.placeStopTarget('LONG', 4315.4, 10, 8);
    assert.equal(l.stop, 4300 - ROUND_BUFFER);
    // raw SHORT stop 4299.6 (0.4 below 4300) -> goes to 4301.5, above the level
    const s = engine.placeStopTarget('SHORT', 4284.6, 10, 8);
    assert.equal(s.stop, 4300 + ROUND_BUFFER);
    for (let entry = 4200; entry < 4220; entry += 0.37) {
      assert.ok(entry - engine.placeStopTarget('LONG', entry, 10, 8).stop >= STOP_ATR_MULT * 10 - 1e-9);
      assert.ok(engine.placeStopTarget('SHORT', entry, 10, 8).stop - entry >= STOP_ATR_MULT * 10 - 1e-9);
    }
  });

  test('target is TARGET_R x the final stop distance, on the profit side', () => {
    for (let entry = 4200; entry < 4220; entry += 0.37) {
      for (const dir of ['LONG', 'SHORT']) {
        const { stop, target } = engine.placeStopTarget(dir, entry, 13.7, 8);
        const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
        assert.ok(Math.abs(reward / risk - TARGET_R) < 0.01, `R:R ${reward / risk}`);
        if (dir === 'LONG') assert.ok(stop < entry && target > entry);
        else                assert.ok(stop > entry && target < entry);
      }
    }
  });

  test('missing or bad ATR falls back to the given distance', () => {
    for (const atr of [undefined, null, NaN, 0, -3]) {
      const { stop, target, usedAtr } = engine.placeStopTarget('LONG', 4302.5, atr, 12);
      assert.equal(usedAtr, false);
      assert.ok(Number.isFinite(stop) && Number.isFinite(target));
      assert.ok(4302.5 - stop >= 12 - 1e-9);
    }
  });
});

describe('generateSignal uses it end to end', () => {
  // A reading that scores 6/6 short (see signalScore.test.js thresholds).
  const tf = (o) => ({ price: 4302.5, rsi: 50, macd: 0, macd_signal: 0, macd_hist: 0, ...o });
  const md = {
    h4:  tf({ macd_hist: -0.5, rsi: 45 }),
    h1:  tf({ macd_hist: -2, macd: -2, rsi: 40, atr: 10 }),
    m30: tf({ macd_hist: -1, macd: -1, rsi: 45 }),
    m15: tf({ rsi: 50 }),
  };

  test('GREEN signal carries ATR stop, 1.5R target, and a true R:R', () => {
    const origLog = console.log; console.log = () => {};
    let sig;
    try { sig = engine.generateSignal(md, 100000); } finally { console.log = origLog; }
    assert.equal(sig.signal, 'GREEN', 'fixture must fire or this test checks nothing');
    const r = sig.recommendation;
    assert.ok(offRound(r.stop) >= ROUND_BUFFER - 1e-9, `stop ${r.stop} on a round level`);
    const risk = Math.abs(r.entry - r.stop);
    assert.ok(risk >= STOP_ATR_MULT * 10 - 1e-9);
    assert.ok(Math.abs(r.riskReward - TARGET_R) < 0.05, `riskReward ${r.riskReward}`);
  });
});
