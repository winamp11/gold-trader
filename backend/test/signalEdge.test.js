// The analysis helpers behind signalEdge.js.
//
// These decide what a result LOOKS like, which is how an analysis tool misleads
// you: not by crashing, but by reporting a confident number computed slightly
// wrong. The two pinned below are the specific errors this project has already
// made once — counting overlapping rows as independent samples, and reading a
// conditional mean without subtracting the base rate.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  uniqueDays,
  summarizeGroup,
  rollingBand,
  computeLift,
  CONDITIONS,
} from '../analysis/signalEdge.js';

describe('uniqueDays', () => {
  test('REGRESSION: rows within one day count as one sample', () => {
    // The regime indicator and the ADX finding both looked strong because
    // hundreds of 5-minute rows inside a handful of days were treated as
    // independent observations. 1,857 rows across 12 days is 12 samples.
    const rows = Array.from({ length: 288 }, (_, i) =>
      ({ timestamp: `2026-08-19T${String(i % 24).padStart(2, '0')}:00:00Z` }));
    assert.equal(rows.length, 288);
    assert.equal(uniqueDays(rows), 1);
  });

  test('counts distinct dates across a span', () => {
    assert.equal(uniqueDays([
      { timestamp: '2026-08-17T02:00:00Z' },
      { timestamp: '2026-08-17T16:00:00Z' },
      { timestamp: '2026-08-18T02:00:00Z' },
    ]), 2);
  });
});

describe('summarizeGroup', () => {
  const rows = [
    { timestamp: '2026-08-17T02:00:00Z', fwd_return_1h: 2, fwd_return_4h: 10, fwd_return_eod: 5 },
    { timestamp: '2026-08-18T02:00:00Z', fwd_return_1h: 4, fwd_return_4h: 20, fwd_return_eod: 15 },
  ];

  test('reports observation count and day count separately', () => {
    const s = summarizeGroup(rows);
    assert.equal(s.n, 2);
    assert.equal(s.days, 2);
    assert.equal(s.fwd1h, 3);
    assert.equal(s.fwd4h, 15);
  });

  test('an unlabeled horizon is null, never 0', () => {
    // A horizon with no matured rows is unknown. Reporting 0 would read as
    // "no forward move", which is a claim the data does not make.
    const s = summarizeGroup([{ timestamp: '2026-08-17T02:00:00Z', fwd_return_1h: 3 }]);
    assert.equal(s.fwd1h, 3);
    assert.equal(s.fwd4h, null);
    assert.equal(s.fwdEod, null);
  });

  test('an empty group is all nulls, not zeros', () => {
    const s = summarizeGroup([]);
    assert.equal(s.n, 0);
    assert.equal(s.days, 0);
    assert.equal(s.fwd4h, null);
  });
});

describe('rollingBand', () => {
  // mean 50, population sd 2 — so the band at the next index is 48..52.
  const hist = [48, 52, 48, 52, 48, 52, 48, 52, 48, 52, 48, 52, 48, 52];

  test('classifies index i from the PRECEDING window only', () => {
    assert.equal(rollingBand([...hist, 53], 14, 1)[14], 'overbought');
    assert.equal(rollingBand([...hist, 47], 14, 1)[14], 'oversold');
    assert.equal(rollingBand([...hist, 50], 14, 1)[14], 'neutral');
  });

  test('REGRESSION: the bar being judged is excluded from its own band', () => {
    // Deliberately a 3-wide window. With a 14-wide one, adding a single value
    // shifts the mean by ~1/15th and the two verdicts agree for almost every
    // input — a test written that way passes even when the window is wrong.
    //
    // Preceding window [48, 52, 50]: mean 50, sd 1.633, so the upper band is
    // 51.63 and a value of 52 reads overbought.
    // Include 52 in its own window and it becomes [48, 52, 50, 52]: mean 50.5,
    // sd 1.658, upper band 52.16 — the same bar now reads neutral, having
    // widened the band it is measured against. That is the lookahead.
    assert.equal(rollingBand([48, 52, 50, 52], 3, 1)[3], 'overbought');
  });

  test('no lookahead — later values cannot change an earlier verdict', () => {
    // The failure this guards against is a band computed over a window that
    // includes index i, or extends past it. Either makes a trigger look sharp
    // by peeking at what it is trying to predict. Two series identical up to
    // index 14 and wildly different after it must classify index 14 the same.
    const up   = rollingBand([...hist, 53, 200, 200, 200], 14, 1);
    const down = rollingBand([...hist, 53,  -5,  -5,  -5], 14, 1);
    assert.equal(up[14], down[14]);
    assert.equal(up[14], 'overbought');
  });

  test('insufficient history yields null, not neutral', () => {
    // "Not enough data to say" must not be silently recorded as "in range".
    const b = rollingBand([50, 51, 49, 52], 14, 1);
    assert.deepEqual(b, [null, null, null, null]);
  });

  test('zero variance yields null rather than a division blow-up', () => {
    const b = rollingBand(Array(20).fill(50), 14, 1);
    assert.equal(b[19], null);
  });

  test('classifies below / within / above the band', () => {
    const base = [45, 55, 45, 55, 45, 55, 45, 55, 45, 55, 45, 55, 45, 55]; // mean 50, sd 5
    assert.equal(rollingBand([...base, 40], 14, 1)[14], 'oversold');
    assert.equal(rollingBand([...base, 50], 14, 1)[14], 'neutral');
    assert.equal(rollingBand([...base, 60], 14, 1)[14], 'overbought');
  });
});

describe('computeLift', () => {
  test('REGRESSION: evidence is the lift, not the conditional mean', () => {
    // In the 4-19 Aug window every condition showed a positive forward return
    // because the base rate was +8.22 pts — the market only went up. A tool
    // that reported the conditional mean alone would have called every one of
    // them an edge.
    const base  = { fwd1h: 1.77, fwd4h: 8.22, fwdEod: 12.0 };
    const group = { fwd1h: 1.40, fwd4h: 6.72, fwdEod: 11.0 };
    const lift  = computeLift(group, base);
    assert.ok(group.fwd4h > 0, 'conditional mean is positive');
    assert.ok(lift.fwd4h < 0, 'but the lift is negative — it underperforms doing nothing');
    assert.equal(Number(lift.fwd4h.toFixed(2)), -1.50);
  });

  test('a missing horizon propagates as null, not as a lift of 0', () => {
    const lift = computeLift({ fwd1h: 2, fwd4h: null, fwdEod: null }, { fwd1h: 1, fwd4h: 5, fwdEod: 5 });
    assert.equal(lift.fwd1h, 1);
    assert.equal(lift.fwd4h, null);
  });
});

describe('named conditions', () => {
  test('adx thresholds match the buckets used in the live analysis', () => {
    assert.equal(CONDITIONS.adx_high({ h4_adx_at_signal: 35 }), true);
    assert.equal(CONDITIONS.adx_high({ h4_adx_at_signal: 34.9 }), false);
    assert.equal(CONDITIONS.adx_chop({ h4_adx_at_signal: 19.9 }), true);
    assert.equal(CONDITIONS.adx_chop({ h4_adx_at_signal: 20 }), false);
  });

  test('a missing indicator does not silently pass a threshold', () => {
    // Number(null) is 0, which would make adx_chop true for every row that
    // never recorded an ADX — quietly inflating the sample with unknowns.
    assert.equal(CONDITIONS.adx_high({ h4_adx_at_signal: null }), false);
    assert.equal(CONDITIONS.adx_high({}), false);
  });

  test('dxy conditions treat unavailable as not-matching', () => {
    assert.equal(CONDITIONS.dxy_rising({ dxy_bias_at_signal: 'rising' }), true);
    assert.equal(CONDITIONS.dxy_rising({ dxy_bias_at_signal: null }), false);
  });
});
