// The Release 1 observability helpers.
//
// None of these change a trading decision — they decide what gets RECORDED.
// That makes them easy to get wrong quietly: a bad value here doesn't break
// anything today, it just produces a column that reads plausibly and means
// something other than what a future analysis will assume it means.
//
// The three failure modes pinned below are all of that shape: an unknown
// candle age recorded as 0 (reads as "fresh"), an unnormalised dollar distance
// mixed into an ATR-normalised column, and an entry count measured against UTC
// midnight instead of UAE midnight (four hours of NY session, every day).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  candleAgeSec,
  nearestSameDirDistanceAtr,
  uaeMidnightUtcIso,
} from '../hybridObservability.js';

describe('candleAgeSec', () => {
  const now = Date.parse('2026-08-16T14:05:00Z');

  test('a naive Twelve Data datetime is read as UTC', () => {
    // The API returns "2026-08-16 14:00:00" with no zone designator. Read as
    // local time on a non-UTC host this would be hours out.
    assert.equal(candleAgeSec('2026-08-16 14:00:00', now), 300);
  });

  test('an ISO datetime with an explicit zone is honoured, not re-stamped', () => {
    assert.equal(candleAgeSec('2026-08-16T14:00:00Z', now), 300);
    assert.equal(candleAgeSec('2026-08-16T18:00:00+04:00', now), 300);
  });

  test('REGRESSION: an unknown age is null, never 0', () => {
    // 0 would read as "perfectly fresh" — the exact inversion of "we don't
    // know" — and is precisely the value a later freshness guard would trust.
    for (const bad of [null, undefined, '', '   ', 'not-a-date', 42, {}]) {
      assert.equal(candleAgeSec(bad, now), null, JSON.stringify(bad));
    }
  });

  test('a 4h candle three hours old is simply three hours old', () => {
    // No judgement is applied here: staleness is per-timeframe and belongs to
    // the caller. This helper reports, it does not classify.
    assert.equal(candleAgeSec('2026-08-16T11:05:00Z', now), 3 * 3600);
  });

  test('a feed clock ahead of ours yields a negative age rather than a clamp', () => {
    // Worth being able to see in the data — clamping would hide it.
    assert.equal(candleAgeSec('2026-08-16T14:10:00Z', now), -300);
  });
});

describe('nearestSameDirDistanceAtr', () => {
  const book = [
    { direction: 'LONG',  entryPrice: 3300 },
    { direction: 'LONG',  entryPrice: 3320 },
    { direction: 'SHORT', entryPrice: 3305 },
  ];

  test('nearest same-direction entry wins, normalised by H1 ATR', () => {
    // Price 3310: LONGs are 10 and 10 away — but 3316 makes it unambiguous.
    assert.equal(nearestSameDirDistanceAtr('LONG', 3316, book, 4), 1);   // 3320 is 4 away
    assert.equal(nearestSameDirDistanceAtr('LONG', 3305, book, 5), 1);   // 3300 is 5 away
  });

  test('the opposite direction is not counted', () => {
    // A SHORT at 3305 is not a clustering risk for a LONG entry.
    assert.equal(nearestSameDirDistanceAtr('SHORT', 3306, book, 2), 0.5);
    assert.equal(nearestSameDirDistanceAtr('SHORT', 3306, [book[0], book[1]], 2), null);
  });

  test('null when flat, when nothing shares the direction, and on NO_TRADE', () => {
    assert.equal(nearestSameDirDistanceAtr('LONG', 3310, [], 4), null);
    assert.equal(nearestSameDirDistanceAtr('LONG', 3310, null, 4), null);
    // A NO_TRADE has no proposed direction, so "how near" has no meaning.
    assert.equal(nearestSameDirDistanceAtr(null, 3310, book, 4), null);
    assert.equal(nearestSameDirDistanceAtr('FLAT', 3310, book, 4), null);
  });

  test('REGRESSION: a missing ATR yields null, never a raw dollar distance', () => {
    // The column is ATR-normalised. A dollar value silently mixed into it
    // would be off by roughly an order of magnitude and indistinguishable
    // afterwards — poisoning the exact distribution this exists to measure.
    for (const atr of [null, undefined, 0, -3, NaN]) {
      assert.equal(nearestSameDirDistanceAtr('LONG', 3316, book, atr), null, String(atr));
    }
  });

  test('the same reading scales with volatility', () => {
    // $4 away is a tight cluster in a quiet market and a wide gap in a loud
    // one. That is the whole reason for normalising.
    assert.equal(nearestSameDirDistanceAtr('LONG', 3316, book, 2), 2);
    assert.equal(nearestSameDirDistanceAtr('LONG', 3316, book, 8), 0.5);
  });

  test('malformed book entries are skipped, not counted as distance 0', () => {
    const messy = [{ direction: 'LONG', entryPrice: null }, { direction: 'LONG' }, null];
    assert.equal(nearestSameDirDistanceAtr('LONG', 3316, messy, 4), null);
  });
});

describe('uaeMidnightUtcIso', () => {
  test('REGRESSION: UAE midnight is 20:00 UTC the previous day', () => {
    // Using UTC midnight instead would attribute the 20:00–24:00 UTC block —
    // four hours of the NY session, every single day — to the wrong trading
    // day, making entries_today wrong on exactly the busiest hours.
    assert.equal(uaeMidnightUtcIso('2026-08-16'), '2026-08-15T20:00:00.000Z');
  });

  test('crosses month and year boundaries correctly', () => {
    assert.equal(uaeMidnightUtcIso('2026-09-01'), '2026-08-31T20:00:00.000Z');
    assert.equal(uaeMidnightUtcIso('2027-01-01'), '2026-12-31T20:00:00.000Z');
  });

  test('no DST shift — UAE is UTC+4 year-round', () => {
    // Both sides of the northern-hemisphere DST changeover must be identical.
    assert.ok(uaeMidnightUtcIso('2026-01-15').endsWith('T20:00:00.000Z'));
    assert.ok(uaeMidnightUtcIso('2026-07-15').endsWith('T20:00:00.000Z'));
  });

  test('an invalid date throws rather than producing a silent wrong window', () => {
    assert.throws(() => uaeMidnightUtcIso('not-a-date'), /invalid UAE date/);
  });
});
