// regimeIndicator.js — 10-day momentum regime detection.
//
// The last suite replays the real XAU/USD daily closes from 2026-06-18 to
// 2026-08-13. It pins the ACTUAL behaviour, including the two false episodes
// the threshold produces in July — not a flattering subset. Three episodes
// is not a sample, so none of this is evidence the parameters generalise.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRegime,
  momentumPct,
  stateFor,
  isCounterRegime,
  formatRegimeForPrompt,
  REGIME_DEFAULTS,
} from '../regimeIndicator.js';

/** Build a close series from bare numbers, dated sequentially. */
function series(...closes) {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close,
  }));
}

/** A flat series of `n` bars at `price`. */
const flat = (n, price = 4000) => series(...Array(n).fill(price));

describe('momentumPct', () => {
  test('measures change across exactly the lookback window', () => {
    // 11 bars: index 0 is the reference for a 10-day lookback.
    const s = series(4000, 1, 2, 3, 4, 5, 6, 7, 8, 9, 4400);
    assert.equal(momentumPct(s, 10).toFixed(2), '10.00');
  });

  test('returns null when the series is shorter than lookback + 1', () => {
    assert.equal(momentumPct(flat(10), 10), null);
    assert.notEqual(momentumPct(flat(11), 10), null);
  });

  test('null on malformed or non-positive reference prices', () => {
    assert.equal(momentumPct(null, 10), null);
    assert.equal(momentumPct(series(0, ...Array(10).fill(4000)), 10), null);
  });
});

describe('stateFor', () => {
  test('threshold is inclusive at the boundary', () => {
    assert.equal(stateFor(3.0, 3.0), 'UP');
    assert.equal(stateFor(-3.0, 3.0), 'DOWN');
    assert.equal(stateFor(2.99, 3.0), 'FLAT');
    assert.equal(stateFor(-2.99, 3.0), 'FLAT');
  });

  test('missing momentum is UNKNOWN, never silently FLAT', () => {
    // The distinction matters: FLAT is a measured absence of trend, UNKNOWN
    // is no measurement at all. Only one of them is information.
    assert.equal(stateFor(null, 3.0), 'UNKNOWN');
    assert.equal(stateFor(NaN, 3.0), 'UNKNOWN');
  });
});

describe('computeRegime', () => {
  test('too little history reports UNKNOWN with no fabricated fields', () => {
    const r = computeRegime(flat(5));
    assert.equal(r.state, 'UNKNOWN');
    assert.equal(r.momentumPct, null);
    assert.equal(r.daysInState, null);
    assert.equal(r.closesAvailable, 5);
  });

  test('flat market reports FLAT with zero distance past threshold', () => {
    const r = computeRegime(flat(30));
    assert.equal(r.state, 'FLAT');
    assert.equal(r.distancePct, 0);
  });

  test('distancePct measures how far BEYOND the threshold, not raw momentum', () => {
    // +3.1% and +9.5% are both UP but are not the same situation.
    const s = series(4000, ...Array(9).fill(4000), 4400); // +10%
    const r = computeRegime(s, { lookbackDays: 10, thresholdPct: 3 });
    assert.equal(r.state, 'UP');
    assert.equal(r.momentumPct.toFixed(1), '10.0');
    assert.equal(r.distancePct.toFixed(1), '7.0');
  });

  test('daysInState is 1 on the day the regime flips', () => {
    // 11 flat bars, then one bar that jumps the 10-day window past +3%.
    const s = series(...Array(11).fill(4000), 4200);
    const r = computeRegime(s, { lookbackDays: 10, thresholdPct: 3 });
    assert.equal(r.state, 'UP');
    assert.equal(r.daysInState, 1, 'a same-day flip must not look established');
    assert.equal(r.previousState, 'FLAT');
  });

  test('daysInState accumulates while the state persists', () => {
    const s = series(...Array(11).fill(4000), 4200, 4210, 4220);
    const r = computeRegime(s, { lookbackDays: 10, thresholdPct: 3 });
    assert.equal(r.state, 'UP');
    assert.equal(r.daysInState, 3);
  });

  test('a truncated series flags daysInState as a floor, not a fact', () => {
    // Every bar available is UP, so the true run length is unknowable.
    const s = series(...Array(11).fill(4000).map((_, i) => 4000 + i * 200));
    const r = computeRegime(s, { lookbackDays: 10, thresholdPct: 3 });
    assert.equal(r.state, 'UP');
    assert.equal(r.truncatedHistory, true);
    assert.equal(r.previousState, null);
  });

  test('DOWN is detected symmetrically', () => {
    const s = series(...Array(11).fill(4000), 3800);
    const r = computeRegime(s, { lookbackDays: 10, thresholdPct: 3 });
    assert.equal(r.state, 'DOWN');
    assert.ok(r.momentumPct < -3);
  });
});

describe('isCounterRegime', () => {
  test('blocks only the direction that fights a CONFIRMED trend', () => {
    const up = { state: 'UP', confirmed: true }, down = { state: 'DOWN', confirmed: true };
    assert.equal(isCounterRegime('SHORT', up), true);
    assert.equal(isCounterRegime('LONG', up), false);
    assert.equal(isCounterRegime('LONG', down), true);
    assert.equal(isCounterRegime('SHORT', down), false);
  });

  test('an unconfirmed regime blocks nothing, however extreme', () => {
    // Both observed false positives were unconfirmed readings, and one of
    // them (-4.35%) was larger in magnitude than the day the real regime
    // began (+4.21%). Magnitude is not evidence; persistence is.
    assert.equal(isCounterRegime('SHORT', { state: 'UP', confirmed: false, momentumPct: 12 }), false);
    assert.equal(isCounterRegime('LONG', { state: 'DOWN', confirmed: false, momentumPct: -12 }), false);
  });

  test('FLAT and UNKNOWN block nothing', () => {
    // Absence of a regime is not evidence for one. A silent indicator must
    // never quietly become a directional filter.
    for (const state of ['FLAT', 'UNKNOWN']) {
      assert.equal(isCounterRegime('LONG', { state }), false, state);
      assert.equal(isCounterRegime('SHORT', { state }), false, state);
    }
    assert.equal(isCounterRegime('LONG', null), false);
    assert.equal(isCounterRegime(null, { state: 'UP' }), false);
  });
});

describe('formatRegimeForPrompt', () => {
  test('sends the number, its age and its distance — not a bare label', () => {
    const r = computeRegime(series(...Array(11).fill(4000), 4200, 4210),
      { lookbackDays: 10, thresholdPct: 3 });
    const text = formatRegimeForPrompt(r);
    assert.match(text, /10-day momentum/);
    assert.match(text, /days in this state\s*:\s*2/);
    assert.match(text, /past threshold by/);
    assert.match(text, /state\s*:\s*UP/);
  });

  test('presents itself as context, and gives no instruction', () => {
    // The block used to tell the model to widen stops in a confirmed regime.
    // Two years of out-of-sample data showed a confirmed regime carries no
    // forward information (+0.08/-0.37/+0.52 pp vs base rate), so that advice
    // was unsupported. This pins the ABSENCE of it: prescriptive language
    // here is a claim about the future, and we do not have one to make.
    const text = formatRegimeForPrompt(computeRegime(flat(30)));
    assert.match(text, /CONTEXT, not an instruction/);
    assert.match(text, /does not predict/i);
    assert.ok(!/blocked in code/.test(text), 'suppression no longer exists');
    assert.ok(!/Favour the wider end/.test(text), 'stop-width advice was removed');
    assert.ok(!/Reduce\s+size/.test(text), 'sizing advice was removed');
  });

  test('states the measured result rather than asserting an edge', () => {
    const text = formatRegimeForPrompt(computeRegime(flat(30)));
    assert.match(text, /no measured edge/i);
  });

  test('UNKNOWN tells the model not to infer a regime itself', () => {
    const text = formatRegimeForPrompt(computeRegime(flat(3)));
    assert.match(text, /UNKNOWN/);
    assert.match(text, /Do not infer a regime/);
  });
});

describe('replay of real XAU/USD closes (single observed flip)', () => {
  // Median price per UAE trading day, 2026-06-18 .. 2026-08-13.
  const REAL = [
    ['2026-06-18', 4244.1], ['2026-06-19', 4153.6], ['2026-06-23', 4127.1],
    ['2026-06-24', 4072.6], ['2026-06-25', 3985.3], ['2026-06-26', 4003.5],
    ['2026-06-29', 4050.7], ['2026-06-30', 3984.9], ['2026-07-01', 3980.6],
    ['2026-07-02', 4070.3], ['2026-07-03', 4176.1], ['2026-07-06', 4152.3],
    ['2026-07-07', 4136.0], ['2026-07-08', 4073.1], ['2026-07-09', 4106.4],
    ['2026-07-10', 4108.3], ['2026-07-13', 4060.1], ['2026-07-14', 4024.8],
    ['2026-07-15', 4032.6], ['2026-07-16', 4029.3], ['2026-07-17', 3994.4],
    ['2026-07-20', 4014.4], ['2026-07-21', 4063.1], ['2026-07-22', 4126.3],
    ['2026-07-23', 4091.4], ['2026-07-24', 4052.9], ['2026-07-27', 4091.2],
    ['2026-07-28', 4042.1], ['2026-07-29', 4028.7], ['2026-07-30', 4072.2],
    ['2026-07-31', 4059.7], ['2026-08-03', 4056.2], ['2026-08-04', 4063.1],
    ['2026-08-05', 4166.7], ['2026-08-06', 4263.8], ['2026-08-07', 4308.9],
    ['2026-08-10', 4340.2], ['2026-08-11', 4386.1], ['2026-08-12', 4409.9],
    ['2026-08-13', 4384.5],
  ].map(([date, close]) => ({ date, close }));

  const stateOn = date => {
    const end = REAL.findIndex(r => r.date === date) + 1;
    return computeRegime(REAL.slice(0, end), REGIME_DEFAULTS);
  };

  test('the raw threshold produces two FALSE episodes in July', () => {
    // Documented, not hidden: +/-3% alone is not clean through the chop.
    const jul9  = stateOn('2026-07-09');
    assert.equal(jul9.state, 'UP');
    assert.equal(jul9.daysInState, 1, 'Jul 9 is a one-day blip');

    const jul17 = stateOn('2026-07-17');
    const jul20 = stateOn('2026-07-20');
    assert.equal(jul17.state, 'DOWN');
    assert.equal(jul20.state, 'DOWN');
    assert.equal(jul20.daysInState, 2, 'the DOWN episode lasts two days');
    assert.equal(stateOn('2026-07-21').state, 'FLAT', 'and then dies');
  });

  test('confirmation suppresses both false episodes and keeps the real one', () => {
    // This is the whole justification for confirmDays. A LONG signal during
    // the false DOWN would have been blocked without it — right before the
    // bounce from 3994 to 4126.
    assert.equal(stateOn('2026-07-09').confirmed, false, 'Jul 9 UP must not gate');
    assert.equal(stateOn('2026-07-17').confirmed, false, 'Jul 17 DOWN must not gate');
    assert.equal(stateOn('2026-07-20').confirmed, false, 'Jul 20 DOWN must not gate');
    assert.equal(isCounterRegime('LONG', stateOn('2026-07-20')), false,
      'an unconfirmed DOWN must never suppress a LONG');

    assert.equal(stateOn('2026-08-10').confirmed, true, 'the real regime confirms on day 3');
    assert.equal(isCounterRegime('SHORT', stateOn('2026-08-10')), true);
  });

  test('genuinely quiet stretches read FLAT', () => {
    for (const date of ['2026-07-13', '2026-07-27', '2026-07-31', '2026-08-04']) {
      assert.equal(stateOn(date).state, 'FLAT', `${date} should be FLAT`);
    }
  });

  test('flips UP on 2026-08-06, the day mechanical went 100% long', () => {
    const before = stateOn('2026-08-05');
    const flip   = stateOn('2026-08-06');
    assert.notEqual(before.state, 'UP', 'must not fire a day early');
    assert.equal(flip.state, 'UP');
    assert.equal(flip.daysInState, 1, 'the flip day must read as fresh, not established');
  });

  test('stays UP through the rally and reads as established', () => {
    const late = stateOn('2026-08-12');
    assert.equal(late.state, 'UP');
    assert.ok(late.daysInState >= 3, `expected an established regime, got ${late.daysInState}`);
    assert.ok(late.momentumPct > 5);
  });

  test('exactly one regime is ever confirmed across the whole history', () => {
    const confirmedDays = REAL
      .map((_, i) => ({ date: REAL[i].date, r: computeRegime(REAL.slice(0, i + 1), REGIME_DEFAULTS) }))
      .filter(x => x.r.confirmed);
    assert.ok(confirmedDays.length > 0, 'expected the August regime to confirm');
    assert.ok(
      confirmedDays.every(x => x.r.state === 'UP' && x.date >= '2026-08-10'),
      'the only confirmed regime should be the August UP move'
    );
  });
});
