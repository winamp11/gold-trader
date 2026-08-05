// hybridAnalytics.js — aggregates hybrid_decisions (+ joined trade outcomes)
// into per-branch performance stats. Pure function of its input rows: no DB,
// no I/O, so it can be unit-tested directly with synthetic data, including
// rows that predate later-added columns (robustness requirement).

import { VALUE_PER_LOT } from './contractSpec.js';

export const BRANCHES = [
  'agreement', 'rulebook_only_overlay_silent', 'rulebook_only_overlay_opposed',
  'overlay_only', 'strong_contradiction', 'no_support',
];

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }

// Real MFE/MAE for an executed trade, from the same max/min_price_during
// columns the rest of the app already uses (reflectDaily, exports, etc).
function tradeMfeMae(row) {
  if (row.max_price_during == null || row.min_price_during == null || row.entry_price == null) {
    return { mfe: null, mae: null };
  }
  const isLong = row.direction === 'LONG';
  return isLong
    ? { mfe: Math.max(0, row.max_price_during - row.entry_price), mae: Math.max(0, row.entry_price - row.min_price_during) }
    : { mfe: Math.max(0, row.entry_price - row.min_price_during), mae: Math.max(0, row.max_price_during - row.entry_price) };
}

function tradeRMultiple(row) {
  if (row.pnl == null || row.entry_price == null || row.stop_loss == null || !row.lot_size) return null;
  const stopDist = Math.abs(row.entry_price - row.stop_loss);
  if (stopDist <= 0) return null;
  const riskUsd = stopDist * row.lot_size * VALUE_PER_LOT;
  return riskUsd > 0 ? row.pnl / riskUsd : null;
}

// Max drawdown of a branch's own realized P&L sequence, in chronological
// order — peak-to-trough of the running cumulative sum, not calendar time.
function maxDrawdown(pnlsInOrder) {
  let peak = 0, cum = 0, maxDd = 0;
  for (const p of pnlsInOrder) {
    cum += p;
    if (cum > peak) peak = cum;
    maxDd = Math.max(maxDd, peak - cum);
  }
  return maxDd;
}

function safeParseCfOutcome(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

// Aggregates one counterfactual track (rulebook or overlay) across a set of
// rows. horizon: 'h1' | 'h4' | 'eod'.
function aggregateCounterfactual(rows, directionField, outcomeField, horizon) {
  let n = 0, matured = 0, avoided = 0, missed = 0, netIfTaken = 0;
  for (const r of rows) {
    if (!r[directionField]) continue;
    n++;
    const parsed = safeParseCfOutcome(r[outcomeField]);
    const cp = parsed?.[horizon];
    if (!cp || cp.pnl == null) continue;
    matured++;
    netIfTaken += cp.pnl;
    if (cp.pnl < 0) avoided += -cp.pnl;
    else if (cp.pnl > 0) missed += cp.pnl;
  }
  return { n, matured, profit_avoided: avoided, profit_missed: missed, net_if_taken: netIfTaken };
}

// rows: hybrid_decisions rows, each optionally carrying joined trade fields
// (direction, entry_price, stop_loss, take_profit, pnl, max_price_during,
// min_price_during, exit_reason) when trade_id is set. Every field access is
// defensive (?. / ??) so a sparse/historical row never throws.
export function computeBranchAnalytics(rows, horizon = 'eod') {
  const out = {};
  for (const branch of BRANCHES) {
    const branchRows = rows.filter(r => r.decision_branch === branch);
    const tradeRows  = branchRows.filter(r => r.trade_id != null && r.pnl != null);
    const noTradeRows = branchRows.filter(r => r.trade_id == null);

    const pnls = tradeRows.map(r => r.pnl);
    const wins   = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const rMultiples = tradeRows.map(tradeRMultiple).filter(r => r != null);
    const mfeMae = tradeRows.map(tradeMfeMae);
    const mfes = mfeMae.map(x => x.mfe).filter(x => x != null);
    const maes = mfeMae.map(x => x.mae).filter(x => x != null);

    out[branch] = {
      n_evaluations: branchRows.length,
      n_trades: tradeRows.length,
      win_rate: tradeRows.length ? wins.length / tradeRows.length : null,
      net_pnl: pnls.length ? pnls.reduce((s, v) => s + v, 0) : 0,
      avg_pnl: mean(pnls),
      avg_r: mean(rMultiples),
      profit_factor: losses.length
        ? (wins.reduce((s, v) => s + v, 0) / Math.abs(losses.reduce((s, v) => s + v, 0)) || null)
        : (wins.length ? Infinity : null),
      max_drawdown: maxDrawdown(pnls),
      avg_mfe: mean(mfes),
      avg_mae: mean(maes),
      n_no_trade: noTradeRows.length,
      counterfactual: {
        rulebook: aggregateCounterfactual(branchRows, 'cf_rulebook_direction', 'cf_rulebook_outcome', horizon),
        overlay:  aggregateCounterfactual(branchRows, 'cf_overlay_direction',  'cf_overlay_outcome',  horizon),
      },
    };
  }
  return out;
}
