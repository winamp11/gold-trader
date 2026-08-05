// forwardLabeler — fills the fwd_* label columns on signals.
//
// For EVERY signal row (traded or not) it records what price actually did
// afterwards: return at +1h, +4h and at the 21:00 UAE forced close, plus the
// best/worst excursion within 4h. Every value is in price points (USD).
// This turns the signals table into a supervised dataset: features frozen at
// decision time on the left, forward outcomes on the right — free of the
// selection bias of only labeling executed trades.
//
// A row is labeled once it is fully mature (now past both t+4h and that
// UAE day's 21:00 close), from Twelve Data 1-min candles fetched in date-range
// chunks. Base price = price_at_signal when captured (exact), otherwise the
// close of the last M1 candle at/before the signal (≤1 min stale backfill).
//
// runForwardLabeling() never throws — a failed run logs and returns counts.

import fetch from 'node-fetch';

const API_KEY  = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

const HOUR_MS       = 3600000;
const UAE_OFFSET_MS = 4 * HOUR_MS;
const CHUNK_MS      = 3 * 24 * HOUR_MS;   // 3 days of M1 ≈ 4300 candles < 5000 cap
const MAX_GAP_MS    = 3 * HOUR_MS;        // stale-candle tolerance for point lookups

// Epoch of 21:00 UAE (17:00 UTC) on the UAE day containing ts.
// Exported: hybridMaturation.js shares this exact candle-fetch/lookup
// machinery so hybrid's counterfactual maturation uses the same
// look-ahead-bias-free mechanism as the signals forward labeler, rather
// than a second, potentially inconsistent implementation.
export function uaeDayEndMs(tsMs) {
  const uae = new Date(tsMs + UAE_OFFSET_MS);
  const dayStartUtcMs = Date.UTC(uae.getUTCFullYear(), uae.getUTCMonth(), uae.getUTCDate()) - UAE_OFFSET_MS;
  return dayStartUtcMs + 21 * HOUR_MS;
}

function fmtUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// One date-range M1 fetch. Returns candles as {t, high, low, close} (any order).
export async function fetchM1Range(startMs, endMs) {
  const url = `${BASE_URL}/time_series?apikey=${API_KEY}&symbol=${encodeURIComponent('XAU/USD')}` +
    `&interval=1min&outputsize=5000&timezone=UTC` +
    `&start_date=${encodeURIComponent(fmtUtc(startMs))}&end_date=${encodeURIComponent(fmtUtc(endMs))}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'time_series error');
  return (data.values ?? []).map(v => ({
    t:     new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  })).filter(c => isFinite(c.t) && isFinite(c.close));
}

// Close of the last candle at/before ts, or null if the nearest is > MAX_GAP_MS stale.
export function priceAt(candles, tsMs) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= tsMs) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (best === -1) return null;
  if (tsMs - candles[best].t > MAX_GAP_MS) return null;
  return candles[best].close;
}

// Extremes over candles with fromMs < t <= toMs.
export function excursions(candles, fromMs, toMs) {
  let hi = null, lo = null;
  for (const c of candles) {
    if (c.t <= fromMs || c.t > toMs) continue;
    if (hi === null || c.high > hi) hi = c.high;
    if (lo === null || c.low  < lo) lo = c.low;
  }
  return { hi, lo };
}

export async function runForwardLabeling(pool, { maxApiCalls = 6 } = {}) {
  const result = { labeled: 0, noData: 0, apiCalls: 0, remaining: 0 };
  try {
    const now = Date.now();
    const matureBefore = new Date(now - 4 * HOUR_MS).toISOString();

    const { rows } = await pool.query(`
      SELECT id, timestamp, price_at_signal
      FROM signals
      WHERE fwd_labeled_at IS NULL AND timestamp < $1
      ORDER BY timestamp ASC
      LIMIT 1500
    `, [matureBefore]);

    // Fully mature = past both t+4h and that day's 21:00 UAE close.
    const mature = rows.filter(r => {
      const t = new Date(r.timestamp).getTime();
      return now > t + 4 * HOUR_MS && now > uaeDayEndMs(t);
    });
    if (mature.length === 0) return result;

    // Fetch M1 coverage in 3-day chunks from the oldest row, capped per run.
    // Rows outside fetched coverage stay unlabeled for the next run.
    const spanStart = new Date(mature[0].timestamp).getTime() - 10 * 60000;
    const spanEnd   = Math.min(
      now,
      Math.max(...mature.map(r => {
        const t = new Date(r.timestamp).getTime();
        return Math.max(t + 4 * HOUR_MS, uaeDayEndMs(t));
      })) + 10 * 60000
    );

    const byT = new Map();
    let cursor = spanStart;
    while (cursor < spanEnd && result.apiCalls < maxApiCalls) {
      const chunkEnd = Math.min(cursor + CHUNK_MS, spanEnd);
      const candles  = await fetchM1Range(cursor, chunkEnd);
      result.apiCalls++;
      for (const c of candles) byT.set(c.t, c);
      cursor = chunkEnd;
    }
    const coveredUntil = cursor;
    const candles = [...byT.values()].sort((a, b) => a.t - b.t);

    for (const row of mature) {
      const t      = new Date(row.timestamp).getTime();
      const endMs  = Math.max(t + 4 * HOUR_MS, uaeDayEndMs(t));
      if (endMs > coveredUntil) { result.remaining++; continue; }

      const base = row.price_at_signal ?? priceAt(candles, t);
      let f1h = null, f4h = null, feod = null, maxUp = null, maxDown = null;
      if (base != null) {
        const p1h  = priceAt(candles, t + 1 * HOUR_MS);
        const p4h  = priceAt(candles, t + 4 * HOUR_MS);
        const peod = priceAt(candles, uaeDayEndMs(t));
        f1h  = p1h  != null ? p1h  - base : null;
        f4h  = p4h  != null ? p4h  - base : null;
        feod = peod != null ? peod - base : null;
        const { hi, lo } = excursions(candles, t, t + 4 * HOUR_MS);
        maxUp   = hi != null ? Math.max(0, hi - base) : null;
        maxDown = lo != null ? Math.max(0, base - lo) : null;
      } else {
        result.noData++;
      }

      // fwd_labeled_at is set even when values are null (no candle coverage)
      // so dead rows don't get reprocessed forever.
      await pool.query(`
        UPDATE signals
        SET fwd_return_1h = $1, fwd_return_4h = $2, fwd_return_eod = $3,
            fwd_max_up_4h = $4, fwd_max_down_4h = $5, fwd_labeled_at = $6
        WHERE id = $7
      `, [f1h, f4h, feod, maxUp, maxDown, new Date().toISOString(), row.id]);
      result.labeled++;
    }

    if (result.labeled > 0 || result.remaining > 0) {
      console.log(`🏷️  [LABELER] labeled=${result.labeled} noData=${result.noData} remaining=${result.remaining} apiCalls=${result.apiCalls}`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [LABELER] run failed: ${err.message}`);
    return { ...result, error: err.message };
  }
}
