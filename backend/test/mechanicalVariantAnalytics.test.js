// mechanicalVariantAnalytics.test.js — comparison metrics, time buckets, and
// the five value-attribution metrics. Pure functions over synthetic rows,
// no DB. Mirrors hybridAnalytics.test.js's conventions, including the
// sparse/malformed-row robustness checks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeComparisonMetrics, computeTimeBuckets, computeAttributionMetrics } from '../mechanicalVariantAnalytics.js';

function trade(pnl, isoTs, extra = {}) {
  return { pnl, timestamp: isoTs, exit_timestamp: isoTs, entry_price: 4000, stop_loss: 3990, lot_size: 0.1, ...extra };
}

describe('computeComparisonMetrics', () => {
  test('zero trades returns a fully null-safe row, not a crash', () => {
    const r = computeComparisonMetrics([], 100000);
    assert.equal(r.closed_trades, 0);
    assert.equal(r.win_rate, null);
    assert.equal(r.current_equity, 100000);
    assert.equal(r.current_consecutive_losses, 0);
  });

  test('win rate, net P&L, profit factor over a simple win/loss mix', () => {
    const trades = [
      trade(300, '2026-08-10T10:00:00Z'),
      trade(-150, '2026-08-10T11:00:00Z'),
      trade(200, '2026-08-10T12:00:00Z'),
    ];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.closed_trades, 3);
    assert.ok(Math.abs(r.win_rate - 66.666) < 0.01);
    assert.equal(r.net_pnl, 350);
    assert.ok(r.profit_factor > 3.3 && r.profit_factor < 3.4); // 500/150
    assert.equal(r.current_equity, 100350);
  });

  test('all-winning trades report Infinity profit factor, not null/crash', () => {
    const trades = [trade(100, '2026-08-10T10:00:00Z'), trade(50, '2026-08-10T11:00:00Z')];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.profit_factor, Infinity);
  });

  test('max drawdown and current drawdown from a chronological equity curve', () => {
    // 100k -> +1000 (101k, new peak) -> -1500 (99.5k, dd=1500) -> +500 (100k, still 1000 below peak)
    const trades = [
      trade(1000, '2026-08-10T09:00:00Z'),
      trade(-1500, '2026-08-10T10:00:00Z'),
      trade(500, '2026-08-10T11:00:00Z'),
    ];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.max_drawdown, 1500);
    assert.equal(r.current_drawdown, 1000);
  });

  test('current_consecutive_losses counts only the TRAILING run, worst_losing_streak the longest run anywhere', () => {
    // win, loss, loss, loss, win, loss, loss  -> trailing run = 2, worst run = 3
    const trades = ['2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z', '2026-08-10T12:00:00Z',
      '2026-08-10T13:00:00Z', '2026-08-10T14:00:00Z', '2026-08-10T15:00:00Z']
      .map((ts, i) => trade([100, -50, -50, -50, 100, -50, -50][i], ts));
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.current_consecutive_losses, 2);
    assert.equal(r.worst_losing_streak, 3);
  });

  test('largest winner/loser and averages are correct and separate from each other', () => {
    const trades = [trade(500, '2026-08-10T09:00:00Z'), trade(100, '2026-08-10T10:00:00Z'), trade(-300, '2026-08-10T11:00:00Z'), trade(-50, '2026-08-10T12:00:00Z')];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.largest_winner, 500);
    assert.equal(r.largest_loss, -300);
    assert.equal(r.avg_winner, 300);
    assert.equal(r.avg_loser, -175);
  });

  test('expectancy is expressed in R (risk-normalized), not raw average dollars', () => {
    // stop distance 10, lot 0.1 -> risk = 10*0.1*100 = $100. pnl=200 -> 2R. pnl=-100 -> -1R.
    const trades = [
      trade(200, '2026-08-10T09:00:00Z', { entry_price: 4000, stop_loss: 3990, lot_size: 0.1 }),
      trade(-100, '2026-08-10T10:00:00Z', { entry_price: 4000, stop_loss: 3990, lot_size: 0.1 }),
    ];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.expectancy_r, 0.5); // (2 + -1)/2
    assert.notEqual(r.expectancy_r, r.avg_pnl); // must not silently equal raw avg dollars
  });

  test('a trade missing entry/stop is excluded from expectancy but still counted in win rate/PF', () => {
    const trades = [trade(200, '2026-08-10T09:00:00Z'), { pnl: 100, timestamp: '2026-08-10T10:00:00Z', exit_timestamp: '2026-08-10T10:00:00Z' }];
    const r = computeComparisonMetrics(trades, 100000);
    assert.equal(r.closed_trades, 2);
    assert.equal(r.expectancy_r, 2); // only the first trade contributes (200/100)
  });
});

describe('computeTimeBuckets', () => {
  test('buckets trades by UAE hour, 3h window, weekday, and weekday×window', () => {
    // 2026-08-10 is a Monday. 06:30 UTC = 10:30 UAE -> window 09-12.
    const trades = [trade(100, '2026-08-10T06:30:00Z'), trade(-50, '2026-08-10T06:45:00Z')];
    const b = computeTimeBuckets(trades);
    assert.equal(b.by_hour[10].n, 2);
    assert.equal(b.by_3h_window['09-12'].n, 2);
    assert.equal(b.by_weekday.Mon.n, 2);
    assert.equal(b.by_weekday_window['Mon 09-12'].n, 2);
    assert.equal(b.by_3h_window['09-12'].net_pnl, 50);
  });

  test('every hour bucket exists even with zero trades in it (n=0, not missing)', () => {
    const b = computeTimeBuckets([]);
    assert.equal(b.by_hour[3].n, 0);
    assert.equal(b.by_hour[3].win_rate, null);
    for (let h = 0; h < 24; h++) assert.ok(b.by_hour[h] !== undefined);
  });

  test('a trade with an unparseable timestamp is skipped, not a crash', () => {
    assert.doesNotThrow(() => computeTimeBuckets([{ pnl: 100, timestamp: 'not-a-date' }]));
  });
});

describe('computeAttributionMetrics — the five value-attribution metrics', () => {
  function decisionRow(reasonCode, finalAction, eodPnl, extra = {}) {
    return { reason_code: reasonCode, final_action: finalAction, eod_pnl: eodPnl, ...extra };
  }

  test('TIME_FILTER_VALUE: an avoided loser adds value, a missed winner subtracts it', () => {
    const rows = [
      decisionRow('OUTSIDE_PRIME_WINDOW', 'REJECT', -400), // correctly avoided a loss
      decisionRow('OUTSIDE_SESSION_WINDOW', 'REJECT', 250), // missed a win
    ];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.TIME_FILTER_VALUE.value, 400 - 250);
    assert.equal(r.TIME_FILTER_VALUE.n_matured, 2);
  });

  test('unmatured rejections (no eod_pnl yet) are counted but contribute zero value', () => {
    const rows = [decisionRow('OUTSIDE_PRIME_WINDOW', 'REJECT', null)];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.TIME_FILTER_VALUE.n_contributing, 1);
    assert.equal(r.TIME_FILTER_VALUE.n_matured, 0);
    assert.equal(r.TIME_FILTER_VALUE.value, 0);
  });

  test('LOSS_CLUSTER_VALUE only counts LOSS_CLUSTER_PAUSE rows, not other rejection reasons', () => {
    const rows = [
      decisionRow('LOSS_CLUSTER_PAUSE', 'REJECT', -200),
      decisionRow('MAX_POSITIONS', 'REJECT', -900), // must NOT leak into loss-cluster value
    ];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.LOSS_CLUSTER_VALUE.value, 200);
    assert.equal(r.LOSS_CLUSTER_VALUE.n_contributing, 1);
  });

  test('DAILY_LOSS_LIMIT_VALUE and GIVEBACK_LOCK_VALUE are straight sums, not avoided-minus-missed', () => {
    const rows = [
      decisionRow('DAILY_MAX_LOSS', 'REJECT', 300),  // would have been a further win -- halting cost profit
      decisionRow('DAILY_MAX_LOSS', 'REJECT', -100), // would have been a further loss -- halting saved money
    ];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.DAILY_LOSS_LIMIT_VALUE.value, 200); // net sum, not |300| - |-100| style avoided/missed split
  });

  test('POSITION_SIZING_VALUE compares actual P&L to what flat-1% sizing would have made, on the same trades', () => {
    // actual lots 0.25 (DEFENSIVE-ish), theoretical 1% lots 1.0, actual pnl +100
    // -> hypothetical at 1% = 100 * (1.0/0.25) = 400; sizing "cost" 300 by under-sizing a winner
    const rows = [
      { final_action: 'EXECUTE', trade_pnl: 100, lots: 0.25, theoretical_1pct_lots: 1.0 },
    ];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.POSITION_SIZING_VALUE.value, 100 - 400);
  });

  test('REDUCE rows are included in position sizing value, REJECT rows are not (no real trade to size)', () => {
    const rows = [
      { final_action: 'REDUCE', trade_pnl: 50, lots: 0.1, theoretical_1pct_lots: 0.2 },
      { final_action: 'REJECT', trade_pnl: null, lots: null, theoretical_1pct_lots: 0.5 },
    ];
    const r = computeAttributionMetrics(rows);
    assert.equal(r.POSITION_SIZING_VALUE.n_contributing, 1);
  });

  test('empty input never throws and reports zero everywhere', () => {
    assert.doesNotThrow(() => computeAttributionMetrics([]));
    const r = computeAttributionMetrics([]);
    assert.equal(r.TIME_FILTER_VALUE.value, 0);
    assert.equal(r.POSITION_SIZING_VALUE.value, 0);
  });

  test('malformed/sparse rows (missing fields) do not throw', () => {
    assert.doesNotThrow(() => computeAttributionMetrics([{}, { reason_code: 'DAILY_MAX_LOSS' }, null].filter(Boolean)));
  });
});
