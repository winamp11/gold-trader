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
// UAE day's 21:00 close). M1 candles come from the shared cache in
// m1CandleCache.js — this file no longer talks to Twelve Data directly;
// hybridMaturation.js and mechanicalVariantMaturation.js draw from the same
// cache, so the three maturation jobs stop independently re-fetching the
// same XAU/USD history.
//
// runForwardLabeling() never throws — a failed run logs and returns counts.

import { getM1Candles } from './m1CandleCache.js';

const HOUR_MS       = 3600000;
const UAE_OFFSET_MS = 4 * HOUR_MS;
const MAX_GAP_MS    = 3 * HOUR_MS;        // stale-candle tolerance for point lookups

// Epoch of 21:00 UAE (17:00 UTC) on the UAE day containing ts.
// Exported: hybridMaturation.js and mechanicalVariantMaturation.js share
// this exact day-boundary logic so every maturation job agrees on what
// "end of day" means, rather than each computing it independently.
export function uaeDayEndMs(tsMs) {
  const uae = new Date(tsMs + UAE_OFFSET_MS);
  const dayStartUtcMs = Date.UTC(uae.getUTCFullYear(), uae.getUTCMonth(), uae.getUTCDate()) - UAE_OFFSET_MS;
  return dayStartUtcMs + 21 * HOUR_MS;
}

// Close of the last candle at/before ts, or null if the nearest is > MAX_GAP_MS stale.
// candles must be sorted ascending by t.
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

export async function runForwardLabeling(pool, { maxApiCalls } = {}) {
  // maxApiCalls is accepted for backward compatibility but no longer used —
  // the API budget now lives in m1CandleCache.js, shared across all
  // consumers, not assigned per-caller. See getM1CacheMetrics() to observe it.
  void maxApiCalls;
  const result = { labeled: 0, noData: 0, remaining: 0, cacheIncomplete: false };
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

    const spanStart = new Date(mature[0].timestamp).getTime() - 10 * 60000;
    const spanEnd   = Math.min(
      now,
      Math.max(...mature.map(r => {
        const t = new Date(r.timestamp).getTime();
        return Math.max(t + 4 * HOUR_MS, uaeDayEndMs(t));
      })) + 10 * 60000
    );

    const { candles, complete, reason } = await getM1Candles('XAU/USD', spanStart, spanEnd, { consumer: 'forward_labeler' });
    if (!complete) {
      result.cacheIncomplete = true;
      console.warn(`⚠️  [LABELER] M1 cache incomplete this run (${reason}) — labeling only what's actually covered`);
    }
    candles.sort((a, b) => a.t - b.t);
    // Correctness floor: never label a row whose required window extends
    // past what candles were actually returned, complete or not — a false
    // "complete" near a data anomaly would otherwise still be caught here.
    const coveredUntil = candles.length ? candles[candles.length - 1].t : spanStart;

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

      // fwd_labeled_at is set even when values are null (no candle coverage
      // within the already-COVERED range) so dead rows don't get
      // reprocessed forever. A row skipped for being beyond coveredUntil
      // above is NOT touched here — it stays eligible for the next run.
      await pool.query(`
        UPDATE signals
        SET fwd_return_1h = $1, fwd_return_4h = $2, fwd_return_eod = $3,
            fwd_max_up_4h = $4, fwd_max_down_4h = $5, fwd_labeled_at = $6
        WHERE id = $7
      `, [f1h, f4h, feod, maxUp, maxDown, new Date().toISOString(), row.id]);
      result.labeled++;
    }

    if (result.labeled > 0 || result.remaining > 0) {
      console.log(`🏷️  [LABELER] labeled=${result.labeled} noData=${result.noData} remaining=${result.remaining} cacheIncomplete=${result.cacheIncomplete}`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [LABELER] run failed: ${err.message}`);
    return { ...result, error: err.message };
  }
}
