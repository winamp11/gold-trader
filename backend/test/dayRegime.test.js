// The path-based day regime.
//
// This models a specific intuition: a trend does not reverse cleanly, it
// stalls first. UP UP UP, FLAT, FLAT, slight DOWN, then DOWN DOWN. The whole
// value is in representing that decay, so the tests centre on it — a plain
// consecutive-day counter would pass a naive test suite while losing exactly
// the behaviour the model exists for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDay,
  computeDayRegime,
  regimeEpisodes,
  DAY_REGIME_DEFAULTS,
} from '../dayRegime.js';

// Build a close series from a list of daily percentage moves.
const from = (moves, start = 1000) => {
  const out = [{ date: '2026-01-01', close: start }];
  moves.forEach((m, i) => {
    const prev = out[out.length - 1].close;
    out.push({ date: `2026-01-${String(i + 2).padStart(2, '0')}`, close: prev * (1 + m / 100) });
  });
  return out;
};

describe('classifyDay', () => {
  test('splits on the threshold, both signs', () => {
    assert.equal(classifyDay(0.6, 0.5), 'UP');
    assert.equal(classifyDay(-0.6, 0.5), 'DOWN');
    assert.equal(classifyDay(0.4, 0.5), 'FLAT');
    assert.equal(classifyDay(-0.4, 0.5), 'FLAT');
  });

  test('exactly at the threshold is FLAT, not directional', () => {
    assert.equal(classifyDay(0.5, 0.5), 'FLAT');
  });

  test('missing input is null, never FLAT', () => {
    // FLAT is a claim about the market; null is "no reading". Collapsing the
    // two would let absent data pad the flat bucket.
    assert.equal(classifyDay(null, 0.5), null);
    assert.equal(classifyDay(0.6, 0), null);
  });
});

describe('run building', () => {
  test('three directional days confirm the regime', () => {
    const r = computeDayRegime(from([1, 1, 1]), { thresholdPct: 0.5, confirmDays: 3 });
    assert.equal(r[2].direction, 'UP');
    assert.equal(r[2].score, 3);
    assert.equal(r[2].confirmed, true);
    assert.equal(r[1].confirmed, false, 'two days must not confirm');
  });

  test('REGRESSION: a flat day erodes the run, it does not reset it', () => {
    // The core of the model. A consecutive-day counter would treat the flat
    // day as a break and call the next up day a fresh 1-day run, discarding
    // three days of context. Here the run survives at reduced strength.
    const r = computeDayRegime(from([1, 1, 1, 0.1, 1]), { thresholdPct: 0.5, confirmDays: 3 });
    assert.equal(r[3].day, 'FLAT');
    assert.equal(r[3].direction, 'UP', 'run must survive one flat day');
    assert.equal(r[3].score, 2.5);
    assert.equal(r[3].eroding, true);
    assert.equal(r[4].score, 3.5, 'a further up day rebuilds from 2.5, not from 0');
    assert.equal(r[4].runDays, 4);
  });

  test('the stall-then-reverse sequence is represented end to end', () => {
    // Exactly the pattern this module exists for: three up, two flat, then
    // three down. Confirmed UP, then unconfirmed while stalling, then
    // confirmed DOWN.
    const r = computeDayRegime(from([1, 1, 1, 0.1, 0.1, -1, -1, -1]), { thresholdPct: 0.5, confirmDays: 3 });
    assert.equal(r[2].regime, 'UP');
    assert.equal(r[4].confirmed, false, 'two flat days must drain past confirmation');
    assert.equal(r[4].direction, 'UP', 'but the run has not flipped yet');
    assert.equal(r[7].regime, 'DOWN');
    assert.equal(r[7].confirmed, true);
  });

  test('enough flat days dissolve the run to no direction', () => {
    const r = computeDayRegime(from([1, 1, 0.1, 0.1, 0.1, 0.1]), { thresholdPct: 0.5 });
    assert.equal(r[r.length - 1].direction, null);
    assert.equal(r[r.length - 1].score, 0);
  });

  test('counter days erode harder than flat days', () => {
    const flat    = computeDayRegime(from([1, 1, 1, 0.1]), { thresholdPct: 0.5 });
    const counter = computeDayRegime(from([1, 1, 1, -1]),  { thresholdPct: 0.5 });
    assert.equal(flat[3].score, 2.5);
    assert.equal(counter[3].score, 2);
    assert.ok(counter[3].score < flat[3].score, 'a contradiction must cost more than a pause');
  });

  test('an unconfirmed run flips on the first counter day', () => {
    const r = computeDayRegime(from([1, -1, -1]), { thresholdPct: 0.5 });
    assert.equal(r[0].direction, 'UP');
    assert.equal(r[1].direction, 'DOWN', 'a one-day run is not established — it flips');
    assert.equal(r[1].score, 1);
  });

  test('REGRESSION: a CONFIRMED run absorbs a counter day instead of flipping', () => {
    // The asymmetry that makes the model usable. Without it a single red day
    // inverts an established trend and the reading whipsaws; with it, three up
    // days survive one down day and reconfirm on the next.
    const r = computeDayRegime(from([1, 1, 1, -1, 1]), { thresholdPct: 0.5, confirmDays: 3 });
    assert.equal(r[2].confirmed, true);
    assert.equal(r[3].direction, 'UP', 'confirmed run must not invert on one counter day');
    assert.equal(r[3].score, 2);
    assert.equal(r[4].confirmed, true, 'and reconfirms on the next up day');
  });

  test('REGRESSION: a reversal confirms in confirmDays, not confirmDays + erosion', () => {
    // The first model always eroded and only flipped when the score crossed
    // zero. After a confirmed 3-day rally that took FIVE counter days to
    // confirm a reversal — the late-flip problem this module exists to avoid.
    const r = computeDayRegime(from([1, 1, 1, 0.1, 0.1, -1, -1, -1]), { thresholdPct: 0.5, confirmDays: 3 });
    assert.equal(r[7].regime, 'DOWN');
    assert.equal(r[7].runDays, 3, 'three down days after the stall, not five');
  });

  test('flat and counter days absorbed by a confirmed run are counted', () => {
    // Four up days give the run enough score to stay confirmed through both a
    // flat day and a counter day, so both are absorbed rather than starting a
    // new run — and the tallies show how much the run has taken on.
    const r = computeDayRegime(from([1, 1, 1, 1, 0.1, -1]), { thresholdPct: 0.5, confirmDays: 3 });
    const last = r[r.length - 1];
    assert.equal(last.direction, 'UP');
    assert.equal(last.flatDays, 1);
    assert.equal(last.counterDays, 1);
    assert.equal(last.score, 2.5);
  });

  test('tallies reset when a stalling run flips, since they belong to the old run', () => {
    const r = computeDayRegime(from([1, 1, 1, 0.1, -1]), { thresholdPct: 0.5, confirmDays: 3 });
    const last = r[r.length - 1];
    assert.equal(last.direction, 'DOWN');
    assert.equal(last.flatDays, 0);
    assert.equal(last.counterDays, 0);
  });
});

describe('ATR-normalised threshold', () => {
  test('REGRESSION: the day being classified is excluded from its own threshold', () => {
    // Including it would let a violent day widen the very bar it must clear,
    // suppressing exactly the days the model should flag.
    const quiet = from([0.1, 0.1, 0.1, 0.1, 0.1, 2.0]);
    const r = computeDayRegime(quiet, { atrPeriod: 5, thresholdAtr: 0.5, thresholdPct: null });
    const last = r[r.length - 1];
    assert.equal(last.day, 'UP');
    assert.ok(last.thresholdUsed < 0.2, `threshold ${last.thresholdUsed} must reflect the quiet history only`);
  });

  test('the same move is directional in a calm stretch and flat in a violent one', () => {
    const calm    = computeDayRegime(from([0.1, 0.1, 0.1, 0.1, 0.1, 0.6]), { atrPeriod: 5, thresholdAtr: 0.5 });
    const violent = computeDayRegime(from([3, -3, 3, -3, 3, 0.6]),         { atrPeriod: 5, thresholdAtr: 0.5 });
    assert.equal(calm[calm.length - 1].day, 'UP');
    assert.equal(violent[violent.length - 1].day, 'FLAT');
  });
});

describe('regimeEpisodes', () => {
  test('collapses consecutive days into the real sample unit', () => {
    // 20 days in one regime is one observation, not twenty. Counting days as
    // independent is the error that made the 10-day indicator look strong.
    const rows = computeDayRegime(from([1, 1, 1, 1, 1, -1, -1, -1, -1, -1]), { thresholdPct: 0.5, confirmDays: 3 });
    const eps = regimeEpisodes(rows);
    assert.ok(eps.length < rows.length);
    assert.deepEqual(eps.map(e => e.state).filter((s, i, a) => s !== a[i - 1]), eps.map(e => e.state));
  });
});

describe('defaults', () => {
  test('the daily threshold is nowhere near the 10-day indicator’s 3%', () => {
    // Gold's median daily move 2024-2026 was 0.54%. A 3% daily threshold marks
    // 97% of days flat — 20 directional days in two years.
    assert.ok(DAY_REGIME_DEFAULTS.thresholdPct <= 1.0);
    assert.equal(DAY_REGIME_DEFAULTS.confirmDays, 3);
    assert.ok(DAY_REGIME_DEFAULTS.counterErosion > DAY_REGIME_DEFAULTS.flatErosion);
  });
});
