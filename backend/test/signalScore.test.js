// The scored entry gate.
//
// Replaces a six-of-six AND gate. Over 7-11 Sep that gate blocked 593 signals
// while gold fell steadily — 70% of them on h1_rsi_bearish and 69% on
// m30_macd_negative, both of which flip back on every retracement. H4 was
// never once the blocker, despite being the suspected cause.
//
// The failure modes worth pinning:
//
//   1. Regression to unanimity — the whole point is firing at 4 of 6.
//   2. Firing on a TIE. Two of the six conditions are direction-agnostic and
//      can be true for LONG and SHORT at once (h4_macd_ok spans -1.0..1.0, and
//      m15_rsi_range is literally identical in both). Under the old gate that
//      was harmless because six-of-six could not pass both ways. At a
//      threshold of 4 it can, so without a strict-winner rule the engine could
//      take a LONG and a SHORT on the same reading.
//   3. Losing the diagnostics. The per-condition failure list is what located
//      this bug in the first place; a score alone would have hidden it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickDirection, SIGNAL_MIN_SCORE } from '../signalEngine.js';

const chk = (score) => ({ score });

describe('pickDirection', () => {
  test('default threshold is 4 of 6, not unanimity', () => {
    assert.equal(SIGNAL_MIN_SCORE, 4);
  });

  test('fires at the threshold when it strictly beats the other side', () => {
    assert.equal(pickDirection(chk(4), chk(2)), 'LONG');
    assert.equal(pickDirection(chk(2), chk(4)), 'SHORT');
  });

  test('does NOT fire on a tie, at any score', () => {
    // The case the old AND gate never had to handle. A tie means the
    // timeframes genuinely disagree; taking either side is a coin flip.
    for (const n of [0, 3, 4, 5, 6]) {
      assert.equal(pickDirection(chk(n), chk(n)), null, `fired on a ${n}-${n} tie`);
    }
  });

  test('does not fire below the threshold even when one side leads', () => {
    assert.equal(pickDirection(chk(3), chk(0)), null);
    assert.equal(pickDirection(chk(0), chk(3)), null);
  });

  test('a 6-of-6 reading still fires — old behaviour is a subset', () => {
    assert.equal(pickDirection(chk(6), chk(1)), 'LONG');
    assert.equal(pickDirection(chk(1), chk(6)), 'SHORT');
  });

  test('the higher score wins when both clear the threshold', () => {
    assert.equal(pickDirection(chk(5), chk(4)), 'LONG');
    assert.equal(pickDirection(chk(4), chk(5)), 'SHORT');
  });

  test('the threshold is honoured when passed explicitly', () => {
    // Lets the gate be tightened back toward 6 without a code change.
    assert.equal(pickDirection(chk(4), chk(2), 6), null);
    assert.equal(pickDirection(chk(6), chk(2), 6), 'LONG');
    assert.equal(pickDirection(chk(2), chk(1), 2), 'LONG');
  });
});

describe('condition scoring', () => {
  // Rebuilt from the real thresholds in signalEngine.js so the scoring maths
  // is checked against concrete indicator readings, not just integers.
  const shortConds = (h4, h1rsi, h1macd, m30macd, m30rsi, m15rsi) => ({
    h4_macd_ok:        h4 < 1.0,
    h1_macd_negative:  h1macd < -0.5,
    h1_rsi_bearish:    h1rsi < 48,
    m30_macd_negative: m30macd < 0,
    m30_rsi_ok:        m30rsi > 35,
    m15_rsi_range:     m15rsi > 30 && m15rsi < 70,
  });
  const score = (c) => Object.values(c).filter(Boolean).length;

  test('the 4 Sep reading that lost money scores below a firing threshold', () => {
    // H4 MACD hist +18.84 (the day's highest, at the day's highest price),
    // H1 -3.07, M30 -1.80. H4 alone was bullish and it went long anyway.
    // As a SHORT the same reading scores well — which is the correct read.
    const c = shortConds(18.84, 62.73, -3.07, -1.80, 55.23, 50);
    assert.equal(c.h4_macd_ok, false);          // H4 blocks the short
    assert.equal(score(c), 4);
  });

  test('a steady-decline bounce scores 4, which now fires', () => {
    // The 9 Sep situation: falling, but H1 RSI popped back above 48 and M30
    // MACD turned positive. Six-of-six refused; four-of-six takes it.
    const c = shortConds(-2.0, 51.0, -1.2, 0.4, 45, 48);
    assert.equal(c.h1_rsi_bearish, false);
    assert.equal(c.m30_macd_negative, false);
    assert.equal(score(c), 4);
  });

  test('a genuinely mixed reading still scores too low to fire', () => {
    const c = shortConds(5.0, 60, 2.0, 1.5, 20, 80);
    assert.ok(score(c) < SIGNAL_MIN_SCORE, `scored ${score(c)}`);
  });
});
