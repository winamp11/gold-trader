// m1CandleCache.js — the ONE canonical pathway for historical XAU/USD
// 1-minute candles. Everything that needs M1 history for maturation
// (forwardLabeler, hybridMaturation, mechanicalVariantMaturation) calls
// getM1Candles() here instead of hitting Twelve Data directly — no module
// keeps its own private fetch implementation.
//
// Design:
//   1. Check local coverage in market_candles_m1 for the requested range.
//   2. If a gap exists, first rule out "the market was legitimately closed"
//      (tradingHours.hasTradingWindowInRange) before ever calling it a real
//      miss — a weekend/off-hours gap must never trigger a fetch attempt.
//   3. A real gap is filled from ONE shared, rolling API-call budget across
//      all consumers, chunked to Twelve Data's 5000-candle cap.
//   4. Every fetched candle is upserted with a canonical UTC-minute
//      timestamp (see normalizeCandle) into a (symbol, ts)-unique table, so
//      overlapping/repeated fetches can never create duplicate rows.
//   5. At most one real Twelve Data fetch is in flight per symbol at a
//      time; a second caller arriving mid-fetch awaits that one fetch, then
//      re-checks coverage itself rather than assuming it was covered.
//
// getM1Candles() NEVER silently returns a partial range as if it were
// complete — callers get { candles, complete, reason, apiCallsUsed } and
// must check `complete` before resolving a maturation outcome from it.
// Correctness over saving a call: an incomplete range means "try again
// later", never "guess from what we have."

import fetch from 'node-fetch';
import database from './database.js';
import { hasTradingWindowInRange } from './tradingHours.js';

const API_KEY  = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

const MIN_MS         = 60000;
const HOUR_MS        = 60 * MIN_MS;
const DAY_MS         = 24 * HOUR_MS;
const CHUNK_MS       = 3 * DAY_MS;      // 3 days of M1 ≈ 4300 candles, under Twelve Data's 5000 cap
const TOLERANCE_MS   = 2 * MIN_MS;      // the very latest minute may not be published yet

const BUDGET_WINDOW_MS      = HOUR_MS;
const MAX_CALLS_PER_WINDOW  = 6;        // shared across ALL consumers, not 6 each

const BASE_RETENTION_DAYS     = 30;
const RETENTION_BUFFER_DAYS   = 2;

export const CACHE_REASONS = ['BUDGET_EXHAUSTED', 'FETCH_FAILED', 'STILL_INCOMPLETE_AFTER_RETRY'];

// ── Shared API-call budget ────────────────────────────────────────────────
let budgetWindowStart = null;
let callsUsedInWindow = 0;

// Test-only: force the budget back to a clean window so tests don't depend
// on real elapsed time or interfere with each other.
export function resetM1CacheBudget() {
  budgetWindowStart = null;
  callsUsedInWindow = 0;
}

export function tryConsumeBudget() {
  const now = Date.now();
  if (budgetWindowStart == null || now - budgetWindowStart > BUDGET_WINDOW_MS) {
    budgetWindowStart = now;
    callsUsedInWindow = 0;
  }
  if (callsUsedInWindow >= MAX_CALLS_PER_WINDOW) return false;
  callsUsedInWindow++;
  return true;
}

// ── Metrics (in-memory, per-consumer) ─────────────────────────────────────
const metrics = {
  requests: {}, servedFromCache: {}, requiresFetch: {}, incomplete: {},
  apiCalls: 0, candlesInserted: 0,
};
function bump(bucket, consumer) {
  const key = consumer ?? 'unknown';
  bucket[key] = (bucket[key] ?? 0) + 1;
}
export function getM1CacheMetrics() {
  return JSON.parse(JSON.stringify(metrics)); // snapshot, not a live reference
}
export function resetM1CacheMetrics() {
  for (const k of ['requests', 'servedFromCache', 'requiresFetch', 'incomplete']) {
    for (const c of Object.keys(metrics[k])) delete metrics[k][c];
  }
  metrics.apiCalls = 0;
  metrics.candlesInserted = 0;
}

// ── Raw Twelve Data fetch — the ONLY place that calls the M1 endpoint ────
function fmtUtc(ms) { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); }

async function fetchM1RangeFromApi(symbol, startMs, endMs) {
  const url = `${BASE_URL}/time_series?apikey=${API_KEY}&symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min&outputsize=5000&timezone=UTC` +
    `&start_date=${encodeURIComponent(fmtUtc(startMs))}&end_date=${encodeURIComponent(fmtUtc(endMs))}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'time_series error');
  return (data.values ?? []).map(v => ({
    t:     new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  })).filter(c => isFinite(c.t) && isFinite(c.close));
}

// Canonical UTC-minute timestamp — this is what makes the (symbol, ts)
// unique constraint reliably identify "the same market minute" regardless
// of how Twelve Data formats/rounds a given datetime string.
export function normalizeCandle(raw) {
  const minuteMs = Math.floor(raw.t / MIN_MS) * MIN_MS;
  return { ts: new Date(minuteMs).toISOString(), open: raw.open ?? null, high: raw.high, low: raw.low, close: raw.close };
}

// ── Coverage assessment ───────────────────────────────────────────────────
// Checks BOTH ends of the requested range (not just "is the tail recent
// enough") so a genuine head gap -- e.g. a first-ever request for a wide
// historical span -- is caught too, not just the common forward-extension
// case. A gap that's entirely non-trading time is not a gap at all.
export async function assessCoverage(symbol, startMs, endMs) {
  const { minTs, maxTs } = await database.getM1CoverageBounds(symbol, startMs, endMs);
  return evaluateCoverageDecision(minTs, maxTs, startMs, endMs);
}

// Pure decision core of assessCoverage, split out so it's directly
// unit-testable with synthetic minTs/maxTs — no DB required. Same
// tolerance/trading-window logic, just without the query.
export function evaluateCoverageDecision(minTs, maxTs, startMs, endMs) {
  const headMissing = minTs == null || minTs > startMs + TOLERANCE_MS;
  if (headMissing && hasTradingWindowInRange(startMs, minTs ?? endMs)) {
    return { complete: false, missingFromMs: startMs };
  }

  const tailMissing = maxTs == null || maxTs < endMs - TOLERANCE_MS;
  if (tailMissing) {
    const tailFrom = maxTs != null ? maxTs + MIN_MS : startMs;
    if (hasTradingWindowInRange(tailFrom, endMs)) {
      return { complete: false, missingFromMs: tailFrom };
    }
  }

  return { complete: true, missingFromMs: null };
}

async function fetchAndUpsertRange(symbol, fromMs, toMs, consumer) {
  let cursor = fromMs;
  let apiCallsUsed = 0;
  while (cursor < toMs) {
    if (!tryConsumeBudget()) {
      return { ok: false, reason: 'BUDGET_EXHAUSTED', apiCallsUsed };
    }
    const chunkEnd = Math.min(cursor + CHUNK_MS, toMs);
    let raw;
    try {
      raw = await fetchM1RangeFromApi(symbol, cursor, chunkEnd);
      apiCallsUsed++;
      metrics.apiCalls++;
    } catch (err) {
      console.error(`❌ [M1 CACHE] fetch failed [${consumer ?? '?'}] ${new Date(cursor).toISOString()}..${new Date(chunkEnd).toISOString()}: ${err.message}`);
      return { ok: false, reason: 'FETCH_FAILED', apiCallsUsed };
    }
    const inserted = await database.upsertM1Candles(symbol, raw.map(normalizeCandle));
    metrics.candlesInserted += inserted;
    cursor = chunkEnd;
  }
  return { ok: true, apiCallsUsed };
}

// ── In-flight dedup: at most one active historical fetch per symbol ──────
// A second concurrent caller for the same symbol awaits the active fetch,
// then re-checks DB coverage itself -- it does not assume the in-flight
// fetch happened to cover exactly what it needed.
const inFlightBySymbol = new Map();
const MAX_ATTEMPTS = 3; // initial check + up to 2 re-checks after joining/starting a fetch

export async function getM1Candles(symbol, startMs, endMs, { consumer } = {}) {
  bump(metrics.requests, consumer);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const coverage = await assessCoverage(symbol, startMs, endMs);
    if (coverage.complete) {
      bump(metrics.servedFromCache, consumer);
      const candles = await database.getM1Candles(symbol, startMs, endMs);
      return { candles, complete: true, reason: null, apiCallsUsed: 0 };
    }
    bump(metrics.requiresFetch, consumer);

    if (inFlightBySymbol.has(symbol)) {
      await inFlightBySymbol.get(symbol).catch(() => {});
      continue; // someone else's fetch just landed -- re-check before fetching ourselves
    }

    const fetchPromise = fetchAndUpsertRange(symbol, coverage.missingFromMs, endMs, consumer);
    inFlightBySymbol.set(symbol, fetchPromise);
    let result;
    try {
      result = await fetchPromise;
    } finally {
      if (inFlightBySymbol.get(symbol) === fetchPromise) inFlightBySymbol.delete(symbol);
    }

    if (!result.ok) {
      bump(metrics.incomplete, consumer);
      console.warn(`⚠️  [M1 CACHE] incomplete range for ${consumer ?? '?'}: ${result.reason}`);
      const candles = await database.getM1Candles(symbol, startMs, endMs);
      return { candles, complete: false, reason: result.reason, apiCallsUsed: result.apiCallsUsed };
    }
    // fetched successfully -- loop back and re-verify coverage with fresh data
  }

  bump(metrics.incomplete, consumer);
  const candles = await database.getM1Candles(symbol, startMs, endMs);
  return { candles, complete: false, reason: 'STILL_INCOMPLETE_AFTER_RETRY', apiCallsUsed: 0 };
}

// ── Retention ──────────────────────────────────────────────────────────────
// Base 30 days is generous relative to what maturation actually needs (no
// horizon here spans more than one trading day) -- the extra margin is for
// debugging/auditing recently matured outcomes, per the stated intent. The
// dynamic floor then protects anything still pending: if some decision has
// sat unmatured for longer than the base window (a stuck job, a bug), its
// required candles are kept until it's resolved rather than deleted out
// from under it. Retryable-failed and simply-not-yet-matured are the same
// set in this system (there's no separate "failed" flag — an incomplete
// maturation attempt just leaves the row pending for the next run), so the
// oldest-unmatured query already covers both.
export async function cleanupOldM1Candles(symbol = 'XAU/USD') {
  const now = Date.now();
  let floorMs = now - BASE_RETENTION_DAYS * DAY_MS;
  try {
    const oldestUnmatured = await database.getOldestUnmaturedMaturationTimestamp();
    if (oldestUnmatured) {
      const protectedFloorMs = new Date(oldestUnmatured).getTime() - RETENTION_BUFFER_DAYS * DAY_MS;
      floorMs = Math.min(floorMs, protectedFloorMs); // whichever is EARLIER wins -- keep more, not less
    }
  } catch (err) {
    console.error(`⚠️  [M1 CACHE] retention floor check failed, using base ${BASE_RETENTION_DAYS}-day retention: ${err.message}`);
  }
  const deleted = await database.deleteM1CandlesBefore(symbol, floorMs);
  if (deleted > 0) {
    console.log(`🧹 [M1 CACHE] retention cleanup: removed ${deleted} candles older than ${new Date(floorMs).toISOString()}`);
  }
  return { deleted, floorMs };
}
