// The pre-10:00 UAE entry block.
//
// This is the only finding in the project that survived every test applied to
// it, and it is now enforced in code. The failure modes below are the ones
// that would quietly undo it or overreach:
//
//   1. Blocking the SESSION rather than entries. Open positions must still be
//      monitored and stopped out between 06:00 and 10:00, signals must still
//      be recorded, and the daily close series must keep advancing. A shorter
//      session would strand overnight positions unmonitored.
//   2. Off-by-one at the boundary. 10:00 is Overlay's single best hour
//      (+29,611 over 19 trades, 8 of 9 days profitable). Blocking it too would
//      discard the strongest hour to avoid nothing.
//   3. Silently allowing entries again — the block returning null for a JP
//      timestamp is indistinguishable from "allowed" at the call sites.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTradingHours, isEntryWindow, entryBlockReason, getSession,
} from '../tradingHours.js';

// UAE is UTC+4 with no DST, so a UAE wall-clock time is a fixed UTC offset.
// 2026-09-07 is a Monday; 2026-09-12 a Saturday.
const uae = (h, m = 0, day = '2026-09-07') =>
  new Date(`${day}T${String(h - 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).getTime();

describe('entry window', () => {
  test('entries are blocked from 06:00 to 09:59 UAE', () => {
    for (const h of [6, 7, 8, 9]) {
      assert.equal(isEntryWindow(uae(h)), false, `${h}:00 should be blocked`);
      assert.equal(isEntryWindow(uae(h, 59)), false, `${h}:59 should be blocked`);
    }
  });

  test('10:00 UAE is allowed — the boundary that matters', () => {
    // Overlay's best hour of the day. An off-by-one here is expensive and
    // completely silent.
    assert.equal(isEntryWindow(uae(9, 59)), false);
    assert.equal(isEntryWindow(uae(10, 0)), true);
    assert.equal(isEntryWindow(uae(10, 1)), true);
  });

  test('entries are allowed from 10:00 to 22:59 UAE', () => {
    // Session extended from 21:00 to 23:00 on 12 Sep 2026.
    for (const h of [10, 12, 15, 18, 20, 21, 22]) {
      assert.equal(isEntryWindow(uae(h)), true, `${h}:00 should be allowed`);
    }
    assert.equal(isEntryWindow(uae(22, 59)), true);
    assert.equal(isEntryWindow(uae(23, 0)), false);   // session ends
  });

  test('the session-end boundary is 23:00, and 21:00-23:00 now trades', () => {
    // Pins the extension explicitly. These two hours were previously outside
    // the window entirely, so nothing in the trade record covers them.
    assert.equal(isEntryWindow(uae(21)), true);
    assert.equal(isEntryWindow(uae(22, 55)), true);
    assert.equal(isEntryWindow(uae(23)), false);
    assert.equal(isTradingHours(uae(22, 55)), true);
    assert.equal(isTradingHours(uae(23)), false);
  });

  test('no entries at the weekend', () => {
    assert.equal(isEntryWindow(uae(12, 0, '2026-09-12')), false); // Saturday
    assert.equal(isEntryWindow(uae(12, 0, '2026-09-13')), false); // Sunday
  });
});

describe('the session is NOT shortened', () => {
  // The distinction the whole design rests on: 06:00-10:00 remains a trading
  // window for monitoring and recording, it just cannot open new risk.
  test('06:00-10:00 UAE is still trading hours', () => {
    for (const h of [6, 7, 8, 9]) {
      assert.equal(isTradingHours(uae(h)), true, `${h}:00 must remain a session minute`);
      assert.equal(isEntryWindow(uae(h)), false, `${h}:00 must not permit entries`);
    }
  });

  test('session labelling is untouched, so JP trades still get labelled JP', () => {
    // Historical analysis groups by these labels; renaming or dropping them
    // would break every session comparison made so far.
    assert.equal(getSession(uae(6)), 'JP');
    assert.equal(getSession(uae(9, 59)), 'JP');
    assert.equal(getSession(uae(10)), 'JP-EUR');
  });

  test('every entry minute is a session minute, but not the reverse', () => {
    for (let h = 0; h < 24; h++) {
      if (isEntryWindow(uae(h))) {
        assert.equal(isTradingHours(uae(h)), true, `${h}:00 entry allowed outside the session`);
      }
    }
    // And the difference is exactly the four blocked hours.
    const sessionOnly = [];
    for (let h = 0; h < 24; h++) {
      if (isTradingHours(uae(h)) && !isEntryWindow(uae(h))) sessionOnly.push(h);
    }
    assert.deepEqual(sessionOnly, [6, 7, 8, 9]);
  });
});

describe('entryBlockReason', () => {
  test('returns null exactly when an entry is allowed', () => {
    for (let h = 0; h < 24; h++) {
      assert.equal(entryBlockReason(uae(h)) === null, isEntryWindow(uae(h)), `mismatch at ${h}:00`);
    }
  });

  test('names the pre-10:00 block and the session it fell in', () => {
    // The log line is the only way to tell a deliberate block apart from a
    // bot that simply proposed nothing.
    const r = entryBlockReason(uae(7));
    assert.match(r, /pre-10:00/);
    assert.match(r, /JP/);
  });

  test('distinguishes weekend and after-hours from the entry block', () => {
    assert.equal(entryBlockReason(uae(12, 0, '2026-09-12')), 'weekend');
    assert.match(entryBlockReason(uae(23, 30)), /outside trading hours/);
  });
});
