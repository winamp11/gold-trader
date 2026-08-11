// m1CandleCache.test.js — pure-logic tests for the shared M1 candle cache:
// coverage decisions (including market-closed gap handling), timestamp
// normalization, the shared budget, and metrics. No DB, no network — the
// DB-touching parts of getM1Candles() itself aren't exercised here, same
// convention as the rest of this project's test suite (pure functions only).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCoverageDecision, normalizeCandle, tryConsumeBudget, resetM1CacheBudget,
  getM1CacheMetrics, resetM1CacheMetrics, CACHE_REASONS,
} from '../m1CandleCache.js';

const MIN = 60000;
const HOUR = 60 * MIN;

describe('normalizeCandle — canonical UTC-minute timestamp', () => {
  test('floors to the minute regardless of seconds/ms', () => {
    const c = normalizeCandle({ t: Date.UTC(2026, 7, 10, 6, 30, 47, 123), open: 4000, high: 4005, low: 3995, close: 4002 });
    assert.equal(c.ts, new Date(Date.UTC(2026, 7, 10, 6, 30, 0, 0)).toISOString());
  });
  test('preserves open/high/low/close', () => {
    const c = normalizeCandle({ t: Date.UTC(2026, 7, 10, 6, 30, 0), open: 4000, high: 4005, low: 3995, close: 4002 });
    assert.equal(c.open, 4000); assert.equal(c.high, 4005); assert.equal(c.low, 3995); assert.equal(c.close, 4002);
  });
  test('missing open (some historical sources) becomes null, not undefined/NaN', () => {
    const c = normalizeCandle({ t: Date.UTC(2026, 7, 10, 6, 30, 0), high: 4005, low: 3995, close: 4002 });
    assert.equal(c.open, null);
  });
});

describe('evaluateCoverageDecision — the core cache-vs-fetch decision', () => {
  // A weekday trading window: Mon 2026-08-10 is a Monday.
  const mon0600 = Date.UTC(2026, 7, 10, 2, 0, 0);  // 06:00 UAE
  const mon0700 = Date.UTC(2026, 7, 10, 3, 0, 0);  // 07:00 UAE
  const mon0800 = Date.UTC(2026, 7, 10, 4, 0, 0);  // 08:00 UAE

  test('fully covered range (min/max match start/end) -> complete', () => {
    const r = evaluateCoverageDecision(mon0600, mon0800, mon0600, mon0800);
    assert.equal(r.complete, true);
    assert.equal(r.missingFromMs, null);
  });

  test('nothing stored at all, but the whole range is a weekend (no trading) -> complete, nothing to fetch', () => {
    // Sat 2026-08-08 -> Sun 2026-08-09, entirely closed
    const sat = Date.UTC(2026, 7, 8, 0, 0, 0);
    const sun = Date.UTC(2026, 7, 9, 23, 0, 0);
    const r = evaluateCoverageDecision(null, null, sat, sun);
    assert.equal(r.complete, true);
  });

  test('nothing stored, range includes real trading time -> incomplete, fetch from startMs', () => {
    const r = evaluateCoverageDecision(null, null, mon0600, mon0800);
    assert.equal(r.complete, false);
    assert.equal(r.missingFromMs, mon0600);
  });

  test('tail gap during trading hours -> incomplete, fetch from just after maxTs', () => {
    const r = evaluateCoverageDecision(mon0600, mon0700, mon0600, mon0800);
    assert.equal(r.complete, false);
    assert.equal(r.missingFromMs, mon0700 + MIN);
  });

  test('tail gap that is purely non-trading time (e.g. we have data up to Friday close) -> complete', () => {
    const fri2100uae = Date.UTC(2026, 7, 7, 17, 0, 0); // Fri 21:00 UAE = market close
    const monMorning = Date.UTC(2026, 7, 10, 1, 0, 0); // Mon 05:00 UAE, still pre-open
    const r = evaluateCoverageDecision(Date.UTC(2026, 7, 7, 10, 0, 0), fri2100uae, Date.UTC(2026, 7, 7, 10, 0, 0), monMorning);
    assert.equal(r.complete, true);
  });

  test('head gap (min stored is later than requested start) during trading hours -> incomplete, fetch from startMs', () => {
    const r = evaluateCoverageDecision(mon0700, mon0800, mon0600, mon0800);
    assert.equal(r.complete, false);
    assert.equal(r.missingFromMs, mon0600);
  });

  test('within tolerance of the boundary counts as covered (still-forming latest candle)', () => {
    const r = evaluateCoverageDecision(mon0600, mon0800 - 30000, mon0600, mon0800); // 30s short of endMs
    assert.equal(r.complete, true);
  });
});

describe('shared API-call budget', () => {
  beforeEach(() => resetM1CacheBudget());

  test('allows exactly MAX_CALLS_PER_WINDOW (6) consumptions before refusing', () => {
    const results = Array.from({ length: 7 }, () => tryConsumeBudget());
    assert.deepEqual(results, [true, true, true, true, true, true, false]);
  });

  test('is shared state, not per-caller: two "different consumers" draw from the same pool', () => {
    for (let i = 0; i < 6; i++) assert.equal(tryConsumeBudget(), true, `call ${i} should succeed`);
    assert.equal(tryConsumeBudget(), false, 'the 7th call, regardless of who asks, must be refused');
  });
});

describe('metrics — per-consumer tracking', () => {
  beforeEach(() => resetM1CacheMetrics());

  test('starts empty', () => {
    const m = getM1CacheMetrics();
    assert.deepEqual(m.requests, {});
    assert.equal(m.apiCalls, 0);
  });

  test('reset actually clears accumulated state', () => {
    resetM1CacheMetrics();
    const m = getM1CacheMetrics();
    assert.equal(Object.keys(m.requests).length, 0);
    assert.equal(Object.keys(m.servedFromCache).length, 0);
  });
});

describe('CACHE_REASONS — the only reasons an incomplete range is ever returned for', () => {
  test('is a fixed, known set (used by callers to decide whether to retry)', () => {
    assert.deepEqual(CACHE_REASONS, ['BUDGET_EXHAUSTED', 'FETCH_FAILED', 'STILL_INCOMPLETE_AFTER_RETRY']);
  });
});
