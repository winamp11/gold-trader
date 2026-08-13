// mechanicalVariantAnalytics.js — pure functions over already-fetched rows.
// No DB, no I/O — mirrors hybridAnalytics.js's shape so it's directly
// unit-testable with synthetic data, including sparse/historical rows
// missing later-added columns.
//
// Three independent pieces:
//   computeComparisonMetrics — equity/WR/PF/expectancy/drawdown/streaks for
//     one account's trade history (works for mechanical/prime/session alike
//     since it only needs `trades` rows, not the mechanical_variant_
//     decisions journal mechanical itself never populates).
//   computeTimeBuckets — hour / 3h-window / weekday / weekday×3h breakdown,
//     same reason: driven by trades.timestamp alone.
//   computeAttributionMetrics — the five "does this safety rule add or
//     destroy value" metrics, which DO need the decisions+outcomes journal
//     (mechanical has none of these — only prime/session do).

import { VALUE_PER_LOT } from './contractSpec.js';

const UAE_OFFSET_MS = 4 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const THREE_HOUR_WINDOWS = [
  { key: '06-09', startHour: 6  }, { key: '09-12', startHour: 9  },
  { key: '12-15', startHour: 12 }, { key: '15-18', startHour: 15 },
  { key: '18-21', startHour: 18 },
];

function uaeParts(tsStr) {
  const ms = new Date(tsStr).getTime();
  if (!isFinite(ms)) return null;
  const uae = new Date(ms + UAE_OFFSET_MS);
  return { hour: uae.getUTCHours(), weekday: uae.getUTCDay() };
}

function windowForHour(hour) {
  for (let i = THREE_HOUR_WINDOWS.length - 1; i >= 0; i--) {
    if (hour >= THREE_HOUR_WINDOWS[i].startHour) return THREE_HOUR_WINDOWS[i].key;
  }
  return null; // outside 06:00-21:00 UAE (shouldn't happen for real trades, but never throw)
}

function emptyBucket() { return { n: 0, wins: 0, net_pnl: 0, gross_win: 0, gross_loss: 0 }; }
function addToBucket(b, pnl) {
  b.n++;
  b.net_pnl += pnl;
  if (pnl > 0) { b.wins++; b.gross_win += pnl; }
  else if (pnl < 0) { b.gross_loss += -pnl; }
}
function finalizeBucket(b) {
  return {
    n: b.n,
    win_rate: b.n > 0 ? b.wins / b.n : null,
    net_pnl: b.net_pnl,
    avg_pnl: b.n > 0 ? b.net_pnl / b.n : null,
    profit_factor: b.gross_loss > 0 ? b.gross_win / b.gross_loss : (b.gross_win > 0 ? Infinity : null),
  };
}

// ── Comparison metrics ────────────────────────────────────────────────────
// trades: [{pnl, timestamp, exit_timestamp, entry_price, stop_loss, lot_size}, ...]
// startingBalance: e.g. 100000. Returns null-safe stats even for zero trades.
export function computeComparisonMetrics(trades, startingBalance) {
  const closed = (trades ?? [])
    .filter(t => t.pnl != null)
    .map(t => ({ ...t, pnl: Number(t.pnl), ts: new Date(t.exit_timestamp ?? t.timestamp).getTime() }))
    .filter(t => isFinite(t.ts))
    .sort((a, b) => a.ts - b.ts);

  const n = closed.length;
  const netPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);

  // Equity curve + drawdown (chronological, cumulative).
  let equity = startingBalance, peak = startingBalance, maxDrawdown = 0;
  for (const t of closed) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const currentDrawdown = peak - equity;

  // Consecutive-loss streaks (chronological).
  let currentConsecutiveLosses = 0, worstLosingStreak = 0, running = 0;
  for (const t of closed) {
    if (t.pnl < 0) { running++; worstLosingStreak = Math.max(worstLosingStreak, running); }
    else if (t.pnl > 0) { running = 0; }
    // pnl === 0 (breakeven) doesn't break or extend a streak
  }
  // current streak = trailing run at the END of the sequence
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].pnl < 0) currentConsecutiveLosses++;
    else if (closed[i].pnl > 0) break;
  }

  // Expectancy expressed in R (avg pnl / initial risk), not raw dollars —
  // needs entry/stop/lots on the trade row; skips trades missing any of them.
  const rMultiples = closed
    .map(t => {
      const dist = Math.abs((t.entry_price ?? null) - (t.stop_loss ?? null));
      const riskUsd = dist > 0 && t.lot_size > 0 ? dist * t.lot_size * VALUE_PER_LOT : null;
      return riskUsd > 0 ? t.pnl / riskUsd : null;
    })
    .filter(r => r != null);

  return {
    current_equity: equity,
    net_pnl: netPnl,
    return_pct: startingBalance > 0 ? (netPnl / startingBalance) * 100 : null,
    closed_trades: n,
    win_rate: n > 0 ? (wins.length / n) * 100 : null,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avg_pnl: n > 0 ? netPnl / n : null,
    expectancy_r: rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null,
    max_drawdown: maxDrawdown,
    current_drawdown: currentDrawdown,
    avg_winner: wins.length > 0 ? grossWin / wins.length : null,
    avg_loser: losses.length > 0 ? -grossLoss / losses.length : null,
    largest_winner: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : null,
    largest_loss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : null,
    current_consecutive_losses: currentConsecutiveLosses,
    worst_losing_streak: worstLosingStreak,
  };
}

// ── Time-bucket breakdowns ────────────────────────────────────────────────
export function computeTimeBuckets(trades) {
  const byHour = {}, byWindow = {}, byWeekday = {}, byWeekdayWindow = {};
  for (let h = 0; h < 24; h++) byHour[h] = emptyBucket();
  for (const w of THREE_HOUR_WINDOWS) byWindow[w.key] = emptyBucket();
  for (const d of WEEKDAY_NAMES) byWeekday[d] = emptyBucket();

  for (const t of trades ?? []) {
    if (t.pnl == null) continue;
    // ENTRY time, never exit time. These buckets exist to answer "which
    // entry hour/window produces good trades" -- the entire premise of
    // mechanical_prime vs mechanical_session. Bucketing by exit time
    // attributes a 15:30 entry that closed at 20:00 to the 18-21 window,
    // which is the opposite of what the comparison is for. Equity-curve
    // ordering in computeComparisonMetrics still uses exit time, correctly:
    // P&L realizes when a trade closes, but it is *caused* at entry.
    const parts = uaeParts(t.timestamp);
    if (!parts) continue;
    const pnl = Number(t.pnl);
    addToBucket(byHour[parts.hour], pnl);
    const winKey = windowForHour(parts.hour);
    if (winKey) addToBucket(byWindow[winKey], pnl);
    const dayKey = WEEKDAY_NAMES[parts.weekday];
    addToBucket(byWeekday[dayKey], pnl);
    if (winKey) {
      const wdKey = `${dayKey} ${winKey}`;
      if (!byWeekdayWindow[wdKey]) byWeekdayWindow[wdKey] = emptyBucket();
      addToBucket(byWeekdayWindow[wdKey], pnl);
    }
  }

  const finalize = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, finalizeBucket(v)]));
  return {
    by_hour: finalize(byHour),
    by_3h_window: finalize(byWindow),
    by_weekday: finalize(byWeekday),
    by_weekday_window: finalize(byWeekdayWindow),
  };
}

// ── Value-attribution metrics ─────────────────────────────────────────────
// decisionRows: mechanical_variant_decisions LEFT JOIN ...outcomes LEFT JOIN
// trades (by trade_id), as returned by the /comparison endpoint's query.
// Each row may be missing outcome/trade fields (unmatured, or an EXECUTE/
// REDUCE row with no outcome at all by design) — every access is defensive.

function parseOutcomeField(row, prefix) {
  // row has flat columns like eod_outcome/eod_pnl/eod_r_multiple from the join.
  const pnl = row[`${prefix}_pnl`];
  return pnl != null ? Number(pnl) : null;
}

// avoided-loser-minus-missed-winner over a set of rejected rows' matured EOD outcome.
function sumAvoidedMinusMissed(rows) {
  let value = 0, nMatured = 0;
  for (const r of rows) {
    const pnl = parseOutcomeField(r, 'eod');
    if (pnl == null) continue;
    nMatured++;
    value += pnl < 0 ? -pnl : -Math.max(0, pnl); // avoided loss: +|pnl|; missed win: -pnl
  }
  return { value, n_contributing: rows.length, n_matured: nMatured };
}

// straight sum of matured EOD counterfactual P&L (no avoided/missed split) —
// used for the two "what if the bot had kept trading" metrics, where a
// positive number means the guard cost missed profit and a negative number
// means it correctly prevented further loss.
function sumCounterfactual(rows) {
  let value = 0, nMatured = 0;
  for (const r of rows) {
    const pnl = parseOutcomeField(r, 'eod');
    if (pnl == null) continue;
    nMatured++;
    value += pnl;
  }
  return { value, n_contributing: rows.length, n_matured: nMatured };
}

export function computeAttributionMetrics(decisionRows) {
  const rows = decisionRows ?? [];

  const timeFilterRows   = rows.filter(r => r.reason_code === 'OUTSIDE_PRIME_WINDOW' || r.reason_code === 'OUTSIDE_SESSION_WINDOW');
  const lossClusterRows  = rows.filter(r => r.reason_code === 'LOSS_CLUSTER_PAUSE');
  const dailyLossRows    = rows.filter(r => r.reason_code === 'DAILY_MAX_LOSS');
  const givebackRows     = rows.filter(r => r.reason_code === 'DAILY_GIVEBACK_LOCK');
  const sizedRows        = rows.filter(r => (r.final_action === 'EXECUTE' || r.final_action === 'REDUCE') && r.trade_pnl != null && r.lots > 0 && r.theoretical_1pct_lots > 0);

  let sizingValue = 0;
  for (const r of sizedRows) {
    const actualPnl = Number(r.trade_pnl);
    const scale = Number(r.theoretical_1pct_lots) / Number(r.lots);
    sizingValue += actualPnl - actualPnl * scale; // actual - hypothetical-at-flat-1%
  }

  return {
    TIME_FILTER_VALUE:      sumAvoidedMinusMissed(timeFilterRows),
    LOSS_CLUSTER_VALUE:     sumAvoidedMinusMissed(lossClusterRows),
    DAILY_LOSS_LIMIT_VALUE: sumCounterfactual(dailyLossRows),
    GIVEBACK_LOCK_VALUE:    sumCounterfactual(givebackRows),
    POSITION_SIZING_VALUE:  { value: sizingValue, n_contributing: sizedRows.length, n_matured: sizedRows.length },
  };
}
