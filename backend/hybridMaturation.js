// hybridMaturation.js — computes hypothetical (counterfactual) outcomes for
// hybrid_decisions rows, and matures the executed-trade side of the journal.
//
// Shares forwardLabeler.js's exact candle-lookup machinery (priceAt/
// excursions/uaeDayEndMs) and draws M1 candles from the shared cache in
// m1CandleCache.js, so hybrid's counterfactuals use the same look-ahead-
// bias-free mechanism as the signals forward labeler and mechanical variant
// maturation, off the SAME stored candle history — not three independent
// Twelve Data fetchers. Outcomes are only ever computed from candles
// timestamped strictly AFTER the decision, never from anything the model
// could have seen. This never feeds back into a live decision — it exists
// solely for /api/hybrid/branch-analytics.
//
// resolveHypothetical() is generic (no hybrid-specific fields) and is
// reused as-is by mechanicalVariantMaturation.js — not copy-pasted.
//
// runHybridMaturation() never throws — a failed run logs and returns counts.

import database from './database.js';
import { priceAt, excursions, uaeDayEndMs } from './forwardLabeler.js';
import { getM1Candles } from './m1CandleCache.js';
import { SPREAD_POINTS, VALUE_PER_LOT } from './contractSpec.js';

const HOUR_MS = 3600000;

// Walks candles chronologically from `fromMs` and reports which level a
// hypothetical position would hit first: stop, target, or neither by capMs
// (the 21:00 UAE close for that decision's day — positions don't hold
// overnight in this system, real or hypothetical). Also reports the
// excursion-based MFE/MAE over the same window, for R-multiple math.
export function resolveHypothetical(candles, direction, entry, stop, target, fromMs, capMs) {
  const isLong = direction === 'LONG';
  let outcome = 'NEITHER', exitPrice = null, exitAtMs = null;

  for (const c of candles) {
    if (c.t <= fromMs || c.t > capMs) continue;
    const hitStop   = isLong ? c.low  <= stop   : c.high >= stop;
    const hitTarget = isLong ? c.high >= target : c.low  <= target;
    if (hitStop && hitTarget) { outcome = 'STOP'; exitPrice = stop; exitAtMs = c.t; break; }  // conservative: stop wins a same-candle tie
    if (hitStop)   { outcome = 'STOP';   exitPrice = stop;   exitAtMs = c.t; break; }
    if (hitTarget) { outcome = 'TARGET'; exitPrice = target; exitAtMs = c.t; break; }
  }
  if (outcome === 'NEITHER') {
    exitPrice = priceAt(candles, capMs) ?? entry;
    exitAtMs  = capMs;
  }

  const { hi, lo } = excursions(candles, fromMs, capMs);
  const mfe = hi != null && lo != null
    ? (isLong ? Math.max(0, hi - entry) : Math.max(0, entry - lo))
    : null;
  const mae = hi != null && lo != null
    ? (isLong ? Math.max(0, entry - lo) : Math.max(0, hi - entry))
    : null;

  return { outcome, exitPrice, exitAtMs, mfe, mae };
}

// Builds the {h1, h4, eod} JSON blob for one counterfactual track (rulebook
// or overlay), given its frozen geometry and the decision's own candle set.
function buildCounterfactualOutcome({ direction, entry, stop, target, riskUsd, lots }, candles, decisionMs, dayEndMs) {
  const checkpoints = { h1: decisionMs + 1 * HOUR_MS, h4: decisionMs + 4 * HOUR_MS, eod: dayEndMs };
  const out = { matured_at: new Date().toISOString() };

  const stopDist = Math.abs(entry - stop);
  const effectiveLots = lots ?? (riskUsd && stopDist ? Math.max(0.01, riskUsd / (stopDist * VALUE_PER_LOT)) : 0.01);

  for (const [label, capMs] of Object.entries(checkpoints)) {
    const r = resolveHypothetical(candles, direction, entry, stop, target, decisionMs, Math.min(capMs, dayEndMs));
    const moveTowardWin = direction === 'LONG' ? r.exitPrice - entry : entry - r.exitPrice;
    const pnl = (moveTowardWin - SPREAD_POINTS) * VALUE_PER_LOT * effectiveLots;
    const rMultiple = stopDist > 0 ? moveTowardWin / stopDist : null;
    out[label] = {
      outcome: r.outcome, exit_price: r.exitPrice, pnl,
      r_multiple: rMultiple, mfe: r.mfe, mae: r.mae,
    };
  }
  return out;
}

export async function runHybridMaturation(pool, { maxApiCalls } = {}) {
  // maxApiCalls kept for backward compatibility, no longer used — the
  // shared budget lives in m1CandleCache.js. See getM1CacheMetrics().
  void maxApiCalls;
  const result = { matured: 0, noData: 0, remaining: 0, cacheIncomplete: false };
  try {
    const now = Date.now();
    const rows = await database.getUnmaturedHybridDecisions(1500);
    if (rows.length === 0) return result;

    // Fully mature = past this decision's own day-end (21:00 UAE) AND past
    // now-4h so the 4h checkpoint itself has real candle coverage.
    const mature = rows.filter(r => {
      const t = new Date(r.cycle_ts).getTime();
      return now > t + 4 * HOUR_MS && now > uaeDayEndMs(t);
    });
    if (mature.length === 0) return result;

    const spanStart = new Date(mature[0].cycle_ts).getTime() - 10 * 60000;
    const spanEnd   = Math.min(
      now,
      Math.max(...mature.map(r => uaeDayEndMs(new Date(r.cycle_ts).getTime()))) + 10 * 60000
    );

    const { candles, complete, reason } = await getM1Candles('XAU/USD', spanStart, spanEnd, { consumer: 'hybrid_maturation' });
    if (!complete) {
      result.cacheIncomplete = true;
      console.warn(`⚠️  [HYBRID MATURATION] M1 cache incomplete this run (${reason}) — maturing only what's actually covered`);
    }
    candles.sort((a, b) => a.t - b.t);
    const coveredUntil = candles.length ? candles[candles.length - 1].t : spanStart;

    for (const row of mature) {
      const t = new Date(row.cycle_ts).getTime();
      const dayEndMs = uaeDayEndMs(t);
      if (dayEndMs > coveredUntil) { result.remaining++; continue; }

      if (row.cf_rulebook_direction && !row.cf_rulebook_outcome) {
        const outcome = buildCounterfactualOutcome({
          direction: row.cf_rulebook_direction, entry: row.cf_rulebook_entry,
          stop: row.cf_rulebook_stop, target: row.cf_rulebook_target,
          riskUsd: row.cf_rulebook_risk_usd, lots: row.cf_rulebook_lots,
        }, candles, t, dayEndMs);
        await database.setHybridDecisionCounterfactualOutcome(row.id, 'rulebook', JSON.stringify(outcome));
        result.matured++;
      }
      if (row.cf_overlay_direction && !row.cf_overlay_outcome) {
        const outcome = buildCounterfactualOutcome({
          direction: row.cf_overlay_direction, entry: row.cf_overlay_entry,
          stop: row.cf_overlay_stop, target: row.cf_overlay_target, lots: row.cf_overlay_lots,
        }, candles, t, dayEndMs);
        await database.setHybridDecisionCounterfactualOutcome(row.id, 'overlay', JSON.stringify(outcome));
        result.matured++;
      }
    }

    if (result.matured > 0 || result.remaining > 0) {
      console.log(`🏷️  [HYBRID MATURATION] matured=${result.matured} remaining=${result.remaining} cacheIncomplete=${result.cacheIncomplete}`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [HYBRID MATURATION] run failed: ${err.message}`);
    return { ...result, error: err.message };
  }
}
