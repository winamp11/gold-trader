// The pure planning helpers behind backfillM1.js.
//
// A backfill fails in two quiet ways: it fetches ranges that overlap or leave
// holes, and it fetches data that daily retention deletes before anyone reads
// it. Neither raises an error — you just get a smaller or emptier table than
// you thought, and an analysis run on top of it that looks fine.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planChunks, retentionCheck, normalize, fmtUtc } from '../analysis/backfillM1.js';

const DAY = 24 * 60 * 60 * 1000;

describe('planChunks', () => {
  const t0 = Date.parse('2026-08-01T00:00:00Z');

  test('covers the range with no gap and no overlap', () => {
    const c = planChunks(t0, t0 + 10 * DAY, 3 * DAY);
    assert.equal(c[0][0], t0);
    assert.equal(c[c.length - 1][1], t0 + 10 * DAY);
    for (let i = 1; i < c.length; i++) {
      assert.equal(c[i][0], c[i - 1][1], `chunk ${i} must start exactly where ${i - 1} ended`);
    }
  });

  test('no chunk exceeds the cap', () => {
    // 3 days of M1 is ~4,300 bars against Twelve Data's 5,000 limit. A chunk
    // over the cap silently returns a TRUNCATED page — the request succeeds,
    // the tail is just missing, and the hole looks like a market closure.
    for (const [a, b] of planChunks(t0, t0 + 31 * DAY, 3 * DAY)) {
      assert.ok(b - a <= 3 * DAY, `chunk ${(b - a) / DAY}d exceeds the 3d cap`);
    }
  });

  test('the final chunk is clipped to the end, never past it', () => {
    const c = planChunks(t0, t0 + 7 * DAY, 3 * DAY);
    assert.equal(c.length, 3);
    assert.equal(c[2][1] - c[2][0], 1 * DAY);
  });

  test('an empty or inverted range plans nothing', () => {
    assert.deepEqual(planChunks(t0, t0), []);
    assert.deepEqual(planChunks(t0, t0 - DAY), []);
  });
});

describe('retentionCheck', () => {
  const now = Date.parse('2026-08-21T12:00:00Z');

  test('28 days back is inside the 30-day floor', () => {
    const r = retentionCheck(now - 28 * DAY, now);
    assert.equal(r.atRisk, false);
    assert.equal(r.atRiskDays, 0);
  });

  test('REGRESSION: a 90-day backfill is flagged as mostly doomed', () => {
    // cleanupOldM1Candles deletes past 30 days on its next daily pass. Fetching
    // 90 days without knowing that burns API calls on rows that vanish within
    // hours — and worse, an analysis run afterwards silently sees only the
    // surviving third.
    const r = retentionCheck(now - 90 * DAY, now);
    assert.equal(r.atRisk, true);
    assert.equal(r.atRiskDays, 60);
  });

  test('the safe floor is exactly the retention boundary', () => {
    assert.equal(retentionCheck(now - 30 * DAY, now).safeFromMs, now - 30 * DAY);
    assert.equal(retentionCheck(now - 30 * DAY, now).atRisk, false);
  });
});

describe('normalize', () => {
  test('floors to the containing UTC minute', () => {
    // The (symbol, ts) unique index only dedupes if both fetches produce the
    // identical key, so seconds must be discarded rather than rounded.
    const c = normalize({ t: Date.parse('2026-08-21T14:37:59.999Z'), open: 1, high: 3, low: 0.5, close: 2 });
    assert.equal(c.ts, '2026-08-21T14:37:00.000Z');
  });

  test('two fetches of the same minute produce the same key', () => {
    const a = normalize({ t: Date.parse('2026-08-21T14:37:02Z'), high: 3, low: 1, close: 2 });
    const b = normalize({ t: Date.parse('2026-08-21T14:37:48Z'), high: 3, low: 1, close: 2 });
    assert.equal(a.ts, b.ts);
  });

  test('a missing open becomes null rather than undefined', () => {
    // undefined would be passed to pg as a bind parameter and rejected.
    assert.equal(normalize({ t: Date.parse('2026-08-21T14:00:00Z'), high: 3, low: 1, close: 2 }).open, null);
  });
});

describe('fmtUtc', () => {
  test('emits the space-separated UTC form Twelve Data expects', () => {
    assert.equal(fmtUtc(Date.parse('2026-08-21T14:37:00Z')), '2026-08-21 14:37:00');
  });
});
