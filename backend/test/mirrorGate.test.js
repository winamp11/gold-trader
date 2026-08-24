// overlay_mirror's entry gate.
//
// The bug this covers, observed in production: overlay decided TRADE, its own
// 3-position cap blocked the open, but overlayDecision.action stayed 'TRADE'.
// The mirror gate keyed off that field alone and opened a position overlay
// never took — mirror held a LONG at 4658.96 that appears nowhere in overlay's
// open positions or its trade history.
//
// That breaks the experiment rather than merely skewing it. overlay_mirror
// exists to isolate one variable (overlay's judgement inside hybrid's risk
// envelope), which only works while both books hold the same positions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mirrorSkipReason } from '../mirrorGate.js';

const cfg = {
  mondayBlockStartHour: 6, mondayBlockEndHour: 9,
  fridayBlockStartHour: 6, fridayBlockEndHour: 9,
  maxOpenPositions: 3,
};

// A cycle where overlay proposed AND opened, and nothing else blocks.
const ok = {
  overlayAction: 'TRADE',
  overlayExecuted: true,
  overlayBlockedReason: null,
  dayOfWeek: 3, hour: 12,
  cfg,
  stoppedReason: null,
  circuitBreaker: false,
  openPositions: 1,
  riskLeftUsd: 1000, riskUsedUsd: 500, riskBudgetUsd: 1500,
};

describe('mirrorSkipReason', () => {
  test('mirrors a trade overlay actually opened', () => {
    assert.equal(mirrorSkipReason(ok), null);
  });

  test('does NOT mirror a decision overlay was blocked from opening', () => {
    // The production bug, replayed. action is still 'TRADE'.
    const out = mirrorSkipReason({
      ...ok, overlayExecuted: false, overlayBlockedReason: 'position cap 3/3',
    });
    assert.equal(out?.code, 'OVERLAY_NOT_EXECUTED');
    assert.match(out.reason, /position cap 3\/3/);
  });

  test('the block is independent of mirror having room', () => {
    // Mirror was at 1 of 3 open positions when it took the phantom trade, so
    // its own cap could never have caught this. Nothing about mirror's state
    // may re-enable the entry.
    for (const openPositions of [0, 1, 2]) {
      const out = mirrorSkipReason({ ...ok, overlayExecuted: false, openPositions });
      assert.equal(out?.code, 'OVERLAY_NOT_EXECUTED', `re-enabled at ${openPositions} open`);
    }
  });

  test('names the blocking reason, or says unknown rather than guessing', () => {
    const out = mirrorSkipReason({ ...ok, overlayExecuted: false, overlayBlockedReason: null });
    assert.match(out.reason, /unknown/);
  });

  test('a non-TRADE decision still reports NO_OVERLAY_TRADE, not NOT_EXECUTED', () => {
    // Order matters: a VETO never executes either, but conflating the two
    // would hide how often overlay is being capped.
    for (const action of ['VETO', 'NO_TRADE', undefined]) {
      const out = mirrorSkipReason({ ...ok, overlayAction: action, overlayExecuted: false });
      assert.equal(out?.code, 'NO_OVERLAY_TRADE');
    }
  });

  test('execution is checked before mirror-side guards', () => {
    // If a mirror-side guard matched first, the log would attribute a phantom
    // entry to the wrong cause and the divergence would stay invisible.
    const out = mirrorSkipReason({
      ...ok, overlayExecuted: false, stoppedReason: 'daily target hit', circuitBreaker: true,
    });
    assert.equal(out?.code, 'OVERLAY_NOT_EXECUTED');
  });

  test('mirror-side guards still apply once overlay has executed', () => {
    const cases = [
      [{ dayOfWeek: 1, hour: 7 },                 'MONDAY_BLOCK'],
      [{ dayOfWeek: 5, hour: 7 },                 'FRIDAY_BLOCK'],
      [{ stoppedReason: 'daily target hit' },     'STOOD_DOWN'],
      [{ circuitBreaker: true },                  'CIRCUIT_BREAKER'],
      [{ openPositions: 3 },                      'POSITION_CAP'],
      [{ riskLeftUsd: 10 },                       'RISK_EXHAUSTED'],
    ];
    for (const [patch, code] of cases) {
      assert.equal(mirrorSkipReason({ ...ok, ...patch })?.code, code, `expected ${code}`);
    }
  });

  test('day blocks do not fire outside their hour window or on other days', () => {
    assert.equal(mirrorSkipReason({ ...ok, dayOfWeek: 1, hour: 9 }), null);
    assert.equal(mirrorSkipReason({ ...ok, dayOfWeek: 1, hour: 5 }), null);
    assert.equal(mirrorSkipReason({ ...ok, dayOfWeek: 2, hour: 7 }), null);
  });
});
