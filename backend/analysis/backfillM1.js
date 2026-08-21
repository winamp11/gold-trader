// backfillM1.js — one-off bulk fill of the M1 candle cache.
//
// Writes ONLY to market_candles_m1, which is a cache. Inserts go through
// database.upsertM1Candles, whose ON CONFLICT (symbol, ts) DO NOTHING makes
// every run idempotent. No trading behaviour changes: the cache is read only
// by forwardLabeler and the two maturation jobs, and filling it means they
// fetch less, never that they decide differently.
//
// WHY THIS EXISTS
//
// The live cache fills only where a maturation job happened to look. Because
// forwardLabeler requests spans ending at 21:10 UAE (17:10 UTC), coverage past
// 17:10 exists only where a 3-day chunk fetch swept over it by accident. A
// real coverage check on 2026-08-21 found 11 days covering 09:00-16:00 UTC but
// only 7 days covering 18:00 UTC -- not enough to evaluate whether the NY
// afternoon (21:00-23:00 UAE) is worth trading.
//
// It is also the same hole behind the weekend labeler stall: Friday's rows
// need forward data past 17:00 UTC that nothing ever fetches.
//
// THE RETENTION TRAP -- READ THIS BEFORE PICKING A RANGE
//
// cleanupOldM1Candles() runs once per UAE day and deletes anything older than
// BASE_RETENTION_DAYS (30), extended only far enough to protect the oldest
// UNMATURED maturation row. A backfill reaching further back than that is
// deleted on the next daily pass -- possibly within hours, with no warning.
//
// So the default here is 28 days, safely inside retention. Going further is
// allowed and sometimes right (a one-shot study), but then the ANALYSIS MUST
// RUN BEFORE THE NEXT RETENTION PASS, and the script says so loudly.
//
// USAGE
//   node analysis/backfillM1.js --days 28              # default, retention-safe
//   node analysis/backfillM1.js --days 28 --dry-run    # plan only, no calls
//   node analysis/backfillM1.js --from 2026-06-01 --to 2026-08-21
//
// Needs DATABASE_URL and TWELVE_DATA_API_KEY.

import pg from 'pg';

const { Pool } = pg;

const BASE_URL   = 'https://api.twelvedata.com';
const MIN_MS     = 60000;
const DAY_MS     = 24 * 60 * 60 * 1000;
const CHUNK_MS   = 3 * DAY_MS;   // 3 days of M1 ~= 4,300 bars, under the 5,000 cap
const RETENTION_DAYS = 30;       // must track m1CandleCache.BASE_RETENTION_DAYS

// ── Pure helpers (exported for tests) ────────────────────────────────────

/** Twelve Data wants 'YYYY-MM-DD HH:mm:ss' in UTC. Same format m1CandleCache uses. */
export function fmtUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Split [fromMs, toMs) into chunks no larger than CHUNK_MS.
 *
 * Half-open on purpose: consecutive chunks must not overlap on the boundary
 * minute. Overlap would not corrupt anything (the upsert is idempotent) but it
 * wastes an API call's worth of rows on every chunk edge.
 */
export function planChunks(fromMs, toMs, chunkMs = CHUNK_MS) {
  if (!(toMs > fromMs)) return [];
  const out = [];
  for (let cur = fromMs; cur < toMs; cur += chunkMs) {
    out.push([cur, Math.min(cur + chunkMs, toMs)]);
  }
  return out;
}

/**
 * How far back is safe given daily retention, and whether the requested range
 * crosses that line.
 *
 * Returns { safeFromMs, atRisk, atRiskDays } -- atRisk means part of what you
 * are about to fetch will be deleted by the next cleanup pass.
 */
export function retentionCheck(fromMs, nowMs = Date.now(), retentionDays = RETENTION_DAYS) {
  const safeFromMs = nowMs - retentionDays * DAY_MS;
  const atRisk = fromMs < safeFromMs;
  return {
    safeFromMs,
    atRisk,
    atRiskDays: atRisk ? Math.ceil((safeFromMs - fromMs) / DAY_MS) : 0,
  };
}

/** Canonical UTC-minute key — mirrors m1CandleCache.normalizeCandle exactly. */
export function normalize(raw) {
  const minuteMs = Math.floor(raw.t / MIN_MS) * MIN_MS;
  return { ts: new Date(minuteMs).toISOString(), open: raw.open ?? null, high: raw.high, low: raw.low, close: raw.close };
}

// ── Fetch ────────────────────────────────────────────────────────────────
// Deliberately its own implementation rather than reusing m1CandleCache's
// fetchAndUpsertRange: that path is gated by a shared 6-calls-per-hour budget
// sized for live drip-feed, which would throttle a bulk backfill to a crawl.
// This is a one-off run by hand, not a background job competing for the budget.

async function fetchRange(apiKey, symbol, startMs, endMs) {
  const url = `${BASE_URL}/time_series?apikey=${apiKey}&symbol=${encodeURIComponent(symbol)}` +
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
  })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
}

async function coverageByHour(pool, symbol, fromMs) {
  const { rows } = await pool.query(`
    SELECT substring(ts,12,2)::int AS hh,
           COUNT(*) AS bars,
           COUNT(DISTINCT substring(ts,1,10)) AS days
    FROM market_candles_m1
    WHERE symbol = $1 AND ts >= $2
    GROUP BY 1 ORDER BY 1
  `, [symbol, new Date(fromMs).toISOString()]);
  return rows;
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg  = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dry  = argv.includes('--dry-run');

  const url    = process.env.DATABASE_URL;
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  if (!apiKey && !dry) { console.error('TWELVE_DATA_API_KEY is not set'); process.exit(1); }

  const symbol = arg('--symbol') ?? 'XAU/USD';
  const now    = Date.now();
  const toMs   = arg('--to')   ? Date.parse(`${arg('--to')}T23:59:59Z`) : now;
  const fromMs = arg('--from') ? Date.parse(`${arg('--from')}T00:00:00Z`)
                               : now - (Number(arg('--days')) || 28) * DAY_MS;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) { console.error('bad --from/--to'); process.exit(1); }

  const chunks = planChunks(fromMs, toMs);
  const ret    = retentionCheck(fromMs, now);

  console.log(`symbol   : ${symbol}`);
  console.log(`range    : ${fmtUtc(fromMs)} .. ${fmtUtc(toMs)}  (${((toMs - fromMs) / DAY_MS).toFixed(1)} days)`);
  console.log(`chunks   : ${chunks.length} API call(s)`);
  if (ret.atRisk) {
    console.log('');
    console.log(`⚠️  RETENTION: ${ret.atRiskDays} day(s) of this range are older than the ${RETENTION_DAYS}-day`);
    console.log(`    floor and WILL BE DELETED by the next daily cleanup pass.`);
    console.log(`    Safe floor is ${fmtUtc(ret.safeFromMs)}. Run your analysis before then,`);
    console.log(`    or re-run this backfill afterwards.`);
  }
  if (dry) { console.log('\n--dry-run: no API calls made, nothing written.'); return; }

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('sslmode=disable') || url.includes('railway.internal') ? false : { rejectUnauthorized: false },
  });

  try {
    const before = await coverageByHour(pool, symbol, fromMs);
    const beforeDays = new Map(before.map(r => [r.hh, Number(r.days)]));

    let calls = 0, inserted = 0;
    for (const [a, b] of chunks) {
      let raw;
      try {
        raw = await fetchRange(apiKey, symbol, a, b);
        calls++;
      } catch (err) {
        console.error(`  ✗ ${fmtUtc(a)}..${fmtUtc(b)} — ${err.message}`);
        continue;   // a hole is better than aborting a long run
      }
      if (raw.length === 0) { console.log(`  · ${fmtUtc(a)}..${fmtUtc(b)} — no bars (market closed)`); continue; }
      const n = await database_upsert(pool, symbol, raw.map(normalize));
      inserted += n;
      console.log(`  ✓ ${fmtUtc(a)}..${fmtUtc(b)} — ${raw.length} bars, ${n} new`);
    }

    console.log(`\n${calls} API call(s), ${inserted} new rows.\n`);
    const after = await coverageByHour(pool, symbol, fromMs);
    console.log(`${'UTC hour'.padEnd(10)}${'days before'.padStart(13)}${'days after'.padStart(12)}${'bars/day'.padStart(10)}`);
    for (const r of after) {
      const d = Number(r.days), was = beforeDays.get(r.hh) ?? 0;
      const mark = d > was ? '  ←' : '';
      console.log(`${String(r.hh).padEnd(10)}${String(was).padStart(13)}${String(d).padStart(12)}${(Number(r.bars) / d).toFixed(0).padStart(10)}${mark}`);
    }
  } finally {
    await pool.end();
  }
}

// Inlined rather than importing database.js, which runs initialize() on import
// and would apply DDL as a side effect of a backfill. Same statement, same
// idempotent ON CONFLICT.
async function database_upsert(pool, symbol, candles) {
  if (candles.length === 0) return 0;
  const values = [];
  const params = [];
  let i = 1;
  for (const c of candles) {
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
    params.push(symbol, c.ts, c.open ?? null, c.high, c.low, c.close);
  }
  const r = await pool.query(`
    INSERT INTO market_candles_m1 (symbol, ts, open, high, low, close)
    VALUES ${values.join(',')}
    ON CONFLICT (symbol, ts) DO NOTHING
  `, params);
  return r.rowCount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
