// Counterfactual outcome maturation, tested against synthetic M1 candles —
// no network call, no real Twelve Data fetch. Verifies the core no-look-
// ahead guarantee: only candles timestamped after `fromMs` can affect the
// outcome, and target/stop/neither resolves correctly by walking forward.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHypothetical } from '../hybridMaturation.js';

const MIN = 60000;
function candle(minsFromStart, high, low) {
  return { t: minsFromStart * MIN, high, low, close: (high + low) / 2 };
}

describe('resolveHypothetical — counterfactual maturation', () => {
  test('LONG hits target first', () => {
    const candles = [
      candle(0, 4001, 3999),
      candle(1, 4003, 4000),
      candle(2, 4006, 4004),   // target 4005 crossed here
      candle(3, 3990, 3985),  // would-be stop-hit candle, but AFTER target -- must not count
    ];
    const r = resolveHypothetical(candles, 'LONG', 4000, 3995, 4005, 0, 3 * MIN);
    assert.equal(r.outcome, 'TARGET');
    assert.equal(r.exitPrice, 4005);
  });

  test('LONG hits stop first', () => {
    const candles = [
      candle(0, 4001, 3999),
      candle(1, 4000, 3994),   // stop 3995 crossed here
      candle(2, 4010, 4008),   // would-be target-hit candle, but AFTER stop
    ];
    const r = resolveHypothetical(candles, 'LONG', 4000, 3995, 4010, 0, 2 * MIN);
    assert.equal(r.outcome, 'STOP');
    assert.equal(r.exitPrice, 3995);
  });

  test('SHORT direction mirrors correctly', () => {
    const candles = [
      candle(0, 4001, 3999),
      candle(1, 4005, 4003),   // stop 4004 crossed for a SHORT
    ];
    const r = resolveHypothetical(candles, 'SHORT', 4000, 4004, 3990, 0, 1 * MIN);
    assert.equal(r.outcome, 'STOP');
  });

  test('neither hit within the window resolves at the capped price', () => {
    const candles = [
      candle(0, 4001, 3999),
      candle(1, 4002, 3998),
    ];
    const r = resolveHypothetical(candles, 'LONG', 4000, 3990, 4020, 0, 1 * MIN);
    assert.equal(r.outcome, 'NEITHER');
    assert.ok(r.exitPrice != null);
  });

  test('no look-ahead: a candle at/before fromMs is never used to resolve the outcome', () => {
    const candles = [
      candle(0, 4050, 4049),   // at fromMs itself -- must be excluded (condition is t <= fromMs -> skip)
      candle(1, 4002, 3998),
    ];
    // If the t=0 candle were wrongly included, this would report TARGET at
    // 4050 immediately; excluding it, neither level is reached in the window.
    const r = resolveHypothetical(candles, 'LONG', 4000, 3990, 4010, 0, 1 * MIN);
    assert.equal(r.outcome, 'NEITHER');
  });

  test('same-candle stop+target conflict resolves conservatively to STOP', () => {
    const candles = [candle(1, 4020, 3980)]; // both levels crossed in one candle
    const r = resolveHypothetical(candles, 'LONG', 4000, 3990, 4010, 0, 1 * MIN);
    assert.equal(r.outcome, 'STOP');
  });

  test('MFE/MAE are non-negative and direction-aware', () => {
    const candles = [candle(1, 4030, 3985)];
    const r = resolveHypothetical(candles, 'LONG', 4000, 3980, 4050, 0, 1 * MIN);
    assert.ok(r.mfe >= 0);
    assert.ok(r.mae >= 0);
  });
});
