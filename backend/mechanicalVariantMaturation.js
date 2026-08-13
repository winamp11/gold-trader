// mechanicalVariantMaturation.js — computes hypothetical outcomes for
// mechanical_prime/mechanical_session REJECT decisions (the ones with no
// real trade ever placed, so no ground truth exists any other way).
// EXECUTE/REDUCE decisions already have real ground truth via their linked
// trade_id -> trades row and are never matured here.
//
// Reuses the same shared candle cache (m1CandleCache.js) and the same
// trusted resolution logic already built for hybrid (resolveHypothetical,
// priceAt/excursions/uaeDayEndMs from forwardLabeler.js) — no separate
// resolution implementation. Outcomes are written to
// mechanical_variant_decision_outcomes, a separate table, never as a column
// on mechanical_variant_decisions: the immutable decision record is never
// touched again once written.
//
// ONE signal -> ONE account decision -> ONE eventual outcome row. A
// decision only becomes eligible once its EOD horizon is reachable, at
// which point h1/h4/eod are all resolved together in a single pass and
// written once (ON CONFLICT (decision_id) DO NOTHING at the DB layer) — a
// repeated maturation check can never create a second observation for the
// same decision.
//
// runMechanicalVariantMaturation() never throws — a failed run logs and
// returns counts.

import database from './database.js';
import { uaeDayEndMs } from './forwardLabeler.js';
import { resolveHypothetical } from './hybridMaturation.js';
import { getM1Candles } from './m1CandleCache.js';
import { SPREAD_POINTS, VALUE_PER_LOT } from './contractSpec.js';

const HOUR_MS = 3600000;

// Builds the {h1, h4, eod} resolution for one decision's hypothetical trade,
// same shape/logic as hybrid's buildCounterfactualOutcome, parameterized
// for a flat lot size (POSITION_SIZING_VALUE is computed separately in
// mechanicalVariantAnalytics.js by comparing this against
// theoretical_1pct_lots — no need to duplicate that math here).
function buildOutcome({ direction, entry, stop, target, lots }, candles, decisionMs, dayEndMs) {
  const checkpoints = { h1: decisionMs + 1 * HOUR_MS, h4: decisionMs + 4 * HOUR_MS, eod: dayEndMs };
  const stopDist = Math.abs(entry - stop);
  const out = { matured_at: new Date().toISOString() };

  for (const [label, capMs] of Object.entries(checkpoints)) {
    const r = resolveHypothetical(candles, direction, entry, stop, target, decisionMs, Math.min(capMs, dayEndMs));
    const moveTowardWin = direction === 'LONG' ? r.exitPrice - entry : entry - r.exitPrice;
    const pnl = (moveTowardWin - SPREAD_POINTS) * VALUE_PER_LOT * lots;
    const rMultiple = stopDist > 0 ? moveTowardWin / stopDist : null;
    out[label] = { outcome: r.outcome, exitPrice: r.exitPrice, pnl, rMultiple, mfe: r.mfe, mae: r.mae };
  }
  return out;
}

export async function runMechanicalVariantMaturation(pool) {
  const result = { matured: 0, skippedInvalidStop: 0, remaining: 0, cacheIncomplete: false };
  try {
    const now = Date.now();
    const rows = await database.getUnmaturedMechanicalVariantDecisions(1500);
    if (rows.length === 0) return result;

    const mature = rows.filter(r => {
      const t = new Date(r.cycle_ts_utc).getTime();
      return now > t + 4 * HOUR_MS && now > uaeDayEndMs(t);
    });
    if (mature.length === 0) return result;

    const spanStart = new Date(mature[0].cycle_ts_utc).getTime() - 10 * 60000;
    const spanEnd   = Math.min(
      now,
      Math.max(...mature.map(r => uaeDayEndMs(new Date(r.cycle_ts_utc).getTime()))) + 10 * 60000
    );

    const { candles, complete, reason } = await getM1Candles('XAU/USD', spanStart, spanEnd, { consumer: 'mechanical_variant_maturation' });
    if (!complete) {
      result.cacheIncomplete = true;
      console.warn(`⚠️  [MECH VARIANT MATURATION] M1 cache incomplete this run (${reason}) — maturing only what's actually covered`);
    }
    candles.sort((a, b) => a.t - b.t);
    const coveredUntil = candles.length ? candles[candles.length - 1].t : spanStart;

    for (const row of mature) {
      const t = new Date(row.cycle_ts_utc).getTime();
      const dayEndMs = uaeDayEndMs(t);
      if (dayEndMs > coveredUntil) { result.remaining++; continue; }

      // The stop the account WOULD have used is the ATR-clamped one; if the
      // clamp itself couldn't run (INVALID_STOP — no ATR reference at the
      // time), there's no valid hypothetical geometry to resolve at all.
      //
      // No fallback to signal_stop. It used to fall back, which quietly
      // resolved the counterfactual against Mechanical's raw stop — a trade
      // this account would never have placed — and fed that into the value
      // attribution as though it were evidence. Rows genuinely missing the
      // clamp are skipped instead: no observation is better than a biased
      // one. Decision rows written before the clamp moved above the
      // rejection gates have no clamped_stop and are skipped permanently,
      // which is the honest outcome for data that was never recoverable.
      const stop = row.clamped_stop;
      if (stop == null || row.signal_entry == null || row.signal_target == null) {
        result.skippedInvalidStop++;
        continue;
      }

      const outcome = buildOutcome({
        direction: row.direction, entry: row.signal_entry, stop, target: row.signal_target,
        lots: row.theoretical_1pct_lots > 0 ? row.theoretical_1pct_lots : 0.01,
      }, candles, t, dayEndMs);

      await database.saveMechanicalVariantDecisionOutcome({
        decisionId: row.id,
        h1: outcome.h1, h4: outcome.h4, eod: outcome.eod,
        maturedAt: outcome.matured_at,
      });
      result.matured++;
    }

    if (result.matured > 0 || result.remaining > 0) {
      console.log(`🏷️  [MECH VARIANT MATURATION] matured=${result.matured} skipped=${result.skippedInvalidStop} remaining=${result.remaining} cacheIncomplete=${result.cacheIncomplete}`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [MECH VARIANT MATURATION] run failed: ${err.message}`);
    return { ...result, error: err.message };
  }
}
