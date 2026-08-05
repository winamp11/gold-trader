// Branch analytics aggregation — pure function, no DB. Covers normal
// aggregation correctness and the "historical records with missing new
// fields" robustness scenario (sparse rows from before some column existed).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBranchAnalytics, BRANCHES } from '../hybridAnalytics.js';

describe('computeBranchAnalytics', () => {
  test('returns a zeroed-out row for every branch, even with no data at all', () => {
    const out = computeBranchAnalytics([]);
    for (const b of BRANCHES) {
      assert.equal(out[b].n_evaluations, 0);
      assert.equal(out[b].n_trades, 0);
      assert.equal(out[b].win_rate, null);
    }
  });

  test('aggregates win rate, net P&L, and profit factor for executed trades', () => {
    const rows = [
      { decision_branch: 'agreement', trade_id: 1, pnl: 300, direction: 'LONG', entry_price: 4000, stop_loss: 3990, take_profit: 4030, lot_size: 0.3, max_price_during: 4032, min_price_during: 3998 },
      { decision_branch: 'agreement', trade_id: 2, pnl: -150, direction: 'LONG', entry_price: 4010, stop_loss: 4000, take_profit: 4040, lot_size: 0.15, max_price_during: 4015, min_price_during: 3999 },
    ];
    const out = computeBranchAnalytics(rows);
    assert.equal(out.agreement.n_trades, 2);
    assert.equal(out.agreement.win_rate, 0.5);
    assert.equal(out.agreement.net_pnl, 150);
    assert.ok(out.agreement.profit_factor > 1.9 && out.agreement.profit_factor < 2.1);
  });

  test('a row with no trade_id counts as an evaluation but not a trade', () => {
    const rows = [{ decision_branch: 'no_support', trade_id: null }];
    const out = computeBranchAnalytics(rows);
    assert.equal(out.no_support.n_evaluations, 1);
    assert.equal(out.no_support.n_trades, 0);
    assert.equal(out.no_support.n_no_trade, 1);
  });

  test('counterfactual profit avoided/missed from the rulebook track', () => {
    const rows = [
      {
        decision_branch: 'rulebook_only_overlay_opposed', trade_id: null,
        cf_rulebook_direction: 'SHORT',
        cf_rulebook_outcome: JSON.stringify({ eod: { pnl: -400 } }),   // opposition correctly avoided a loss
      },
      {
        decision_branch: 'rulebook_only_overlay_opposed', trade_id: null,
        cf_rulebook_direction: 'LONG',
        cf_rulebook_outcome: JSON.stringify({ eod: { pnl: 250 } }),    // opposition missed a win
      },
    ];
    const out = computeBranchAnalytics(rows, 'eod');
    assert.equal(out.rulebook_only_overlay_opposed.counterfactual.rulebook.profit_avoided, 400);
    assert.equal(out.rulebook_only_overlay_opposed.counterfactual.rulebook.profit_missed, 250);
  });

  test('unmatured counterfactual (outcome not yet computed) is counted but not summed', () => {
    const rows = [{ decision_branch: 'strong_contradiction', trade_id: null, cf_rulebook_direction: 'LONG', cf_rulebook_outcome: null }];
    const out = computeBranchAnalytics(rows);
    assert.equal(out.strong_contradiction.counterfactual.rulebook.n, 1);
    assert.equal(out.strong_contradiction.counterfactual.rulebook.matured, 0);
    assert.equal(out.strong_contradiction.counterfactual.rulebook.profit_avoided, 0);
  });

  test('historical records missing later-added fields do not throw', () => {
    // Simulates a row inserted before some column existed -- only the bare
    // minimum identity fields present, everything else undefined.
    const sparse = [{ decision_branch: 'agreement' }];
    assert.doesNotThrow(() => computeBranchAnalytics(sparse));
    const out = computeBranchAnalytics(sparse);
    assert.equal(out.agreement.n_evaluations, 1);
    assert.equal(out.agreement.avg_mfe, null);
    assert.equal(out.agreement.counterfactual.rulebook.n, 0);
  });

  test('malformed counterfactual JSON does not throw', () => {
    const rows = [{ decision_branch: 'no_support', cf_rulebook_direction: 'LONG', cf_rulebook_outcome: '{not valid json' }];
    assert.doesNotThrow(() => computeBranchAnalytics(rows));
  });

  test('an all-winning branch reports Infinity profit factor, not a crash or null', () => {
    const rows = [{ decision_branch: 'overlay_only', trade_id: 1, pnl: 100, direction: 'LONG', entry_price: 4000, stop_loss: 3990, take_profit: 4010, lot_size: 0.1 }];
    const out = computeBranchAnalytics(rows);
    assert.equal(out.overlay_only.profit_factor, Infinity);
  });
});
