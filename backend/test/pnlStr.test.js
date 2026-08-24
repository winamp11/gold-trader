// P&L formatting for the reflector prompt.
//
// This one string is the only place a journal entry learns whether a result
// was a gain or a loss, so a sign error here is not cosmetic — it corrupts
// every lesson written, and downstream everything those lessons feed: pin
// selection, the Analyst, and the decider prompt itself.
//
// The bug: the negative branch emitted an EMPTY prefix while the positive
// branch emitted '+'. A -718.26 loss rendered as "$718.26" and sat in the
// prompt beside "+$3,360.00" gains, reading as an unsigned positive.
//
// Trades exited by STOP_HIT or TARGET_HIT carried a partial hint from the
// exit reason. Forced exits — WINDOW_CLOSE, CIRCUIT_BREAKER, GIVE_BACK — carry
// no directional hint at all, so for those the sign was the ONLY signal and it
// was absent.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pnlStr } from '../deciders/reflector.js';

describe('pnlStr', () => {
  test('a loss is signed negative', () => {
    // The exact regression. Before the fix this returned '$718.26'.
    assert.equal(pnlStr(-718.26), '-$718.26');
  });

  test('a gain is signed positive', () => {
    assert.equal(pnlStr(718.26), '+$718.26');
  });

  test('gain and loss of equal magnitude never render identically', () => {
    // The property that actually matters: whatever the format, the reader must
    // be able to tell the two apart.
    for (const v of [0.01, 5, 718.26, 2487, 13157.5]) {
      assert.notEqual(pnlStr(v), pnlStr(-v), `${v} and -${v} render the same`);
    }
  });

  test('every output carries an explicit sign', () => {
    for (const v of [-2400, -0.5, 0, 0.5, 2400]) {
      assert.match(pnlStr(v), /^[+-]\$/, `unsigned output for ${v}`);
    }
  });

  test('zero is not treated as a loss', () => {
    assert.equal(pnlStr(0), '+$0.00');
    assert.equal(pnlStr(-0), '+$0.00');
  });

  test('null and undefined stay n/a rather than becoming $0.00', () => {
    // A missing P&L must not be reported to the reflector as a flat trade.
    assert.equal(pnlStr(null), 'n/a');
    assert.equal(pnlStr(undefined), 'n/a');
  });

  test('non-numeric input is n/a, not NaN', () => {
    // pnl arrives from pg, which returns NUMERIC columns as strings; a
    // malformed value must not render as '$NaN' inside the prompt.
    assert.equal(pnlStr('not-a-number'), 'n/a');
    assert.equal(pnlStr(NaN), 'n/a');
    assert.equal(pnlStr(Infinity), 'n/a');
  });

  test('numeric strings from pg are formatted, not rejected', () => {
    assert.equal(pnlStr('-718.26'), '-$718.26');
    assert.equal(pnlStr('718.26'), '+$718.26');
  });

  test('always two decimal places', () => {
    assert.equal(pnlStr(-5), '-$5.00');
    assert.equal(pnlStr(-5.006), '-$5.01');
    assert.equal(pnlStr(-5.004), '-$5.00');
    // Not -5.005: that value is below 5.005 in binary floating point, so
    // toFixed(2) yields "5.00". Standard JS, not a formatting fault.
  });
});
