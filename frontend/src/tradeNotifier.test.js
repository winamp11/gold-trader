// Trade-alert diffing.
//
// Two failure modes matter here, and both are silent — they produce
// notifications that look plausible and are wrong:
//
//   1. Alerting for positions that were already open when the page loaded.
//      You would open the dashboard and get a burst of alerts for trades from
//      hours ago, and might act on a stale one with real money.
//   2. Re-alerting for the same position on every poll, which trains you to
//      ignore the alerts.

import {
  diffNewPositions, formatPosition, NOTIFY_ACCOUNT,
  toggleState, TOGGLE_LABEL, TOGGLE_TITLE, isMuted, setMuted,
} from './tradeNotifier';

const pos = (key, extra = {}) => ({
  key, portfolioName: NOTIFY_ACCOUNT, direction: 'LONG',
  entryPrice: 4500, stopLoss: 4480, target: 4540, lots: 0.5, ...extra,
});

test('first poll primes silently — no alerts for already-open positions', () => {
  const { fresh, seen } = diffNewPositions(null, [pos('2_100'), pos('2_101')]);
  expect(fresh).toHaveLength(0);
  expect(seen.has('2_100')).toBe(true);
  expect(seen.has('2_101')).toBe(true);
});

test('an empty first poll still primes, and is not confused with null', () => {
  // The distinction that makes case 1 work: "no previous state" must differ
  // from "previous state was empty". If both were an empty Set, a page opened
  // while positions are live would alert on all of them.
  const primed = diffNewPositions(null, []);
  expect(primed.fresh).toHaveLength(0);

  const next = diffNewPositions(primed.seen, [pos('2_100')]);
  expect(next.fresh.map(p => p.key)).toEqual(['2_100']);
});

test('a genuinely new position alerts exactly once', () => {
  const first = diffNewPositions(null, [pos('2_100')]);
  const second = diffNewPositions(first.seen, [pos('2_100'), pos('2_101')]);
  expect(second.fresh.map(p => p.key)).toEqual(['2_101']);

  // Same book on the next poll — nothing new.
  const third = diffNewPositions(second.seen, [pos('2_100'), pos('2_101')]);
  expect(third.fresh).toHaveLength(0);
});

test('a position whose price moves is not treated as new', () => {
  // Matching on price or index rather than key would re-alert every poll,
  // since unrealised P&L and current price change continuously.
  const first = diffNewPositions(null, [pos('2_100', { entryPrice: 4500 })]);
  const second = diffNewPositions(first.seen, [
    pos('2_100', { entryPrice: 4500, currentPrice: 4533, unrealizedPnl: 1650 }),
  ]);
  expect(second.fresh).toHaveLength(0);
});

test('other accounts never alert', () => {
  const first = diffNewPositions(null, []);
  const second = diffNewPositions(first.seen, [
    { ...pos('1_200'), portfolioName: 'mechanical' },
    { ...pos('4_201'), portfolioName: 'overlay_mirror' },
    { ...pos('3_202'), portfolioName: 'claude_hybrid' },
  ]);
  expect(second.fresh).toHaveLength(0);
});

test('closing a position drops it from the seen set', () => {
  const first = diffNewPositions(null, [pos('2_100')]);
  const closed = diffNewPositions(first.seen, []);
  expect(closed.seen.size).toBe(0);
});

test('positions without a key are ignored rather than alerted blindly', () => {
  // A malformed row must not produce an alert with undefined levels — that is
  // worse than no alert, because it looks actionable.
  const first = diffNewPositions(null, []);
  const second = diffNewPositions(first.seen, [{ portfolioName: NOTIFY_ACCOUNT, direction: 'LONG' }]);
  expect(second.fresh).toHaveLength(0);
});

test('missing or malformed input does not throw', () => {
  expect(() => diffNewPositions(null, undefined)).not.toThrow();
  expect(() => diffNewPositions(new Set(), [null, undefined])).not.toThrow();
});

test('the alert body carries every level needed to mirror the trade', () => {
  const { title, body } = formatPosition(pos('2_100', { tag: 'trend_h1' }));
  expect(title).toContain('LONG');
  expect(body).toContain('4500.00');   // entry
  expect(body).toContain('4480.00');   // stop
  expect(body).toContain('4540.00');   // target
  expect(body).toContain('0.50');      // lots
  expect(body).toContain('trend_h1');
});

test('missing levels render as a dash, not as undefined or NaN', () => {
  const { body } = formatPosition({ key: 'x', direction: 'SHORT' });
  expect(body).not.toMatch(/undefined|NaN/);
  expect(body).toContain('—');
});

// ── Toggle state machine ────────────────────────────────────────────────
//
// Browser permission is one-way — once granted it can only be revoked in
// Chrome's site settings. The app therefore needs its own mute flag, and the
// button has to represent five states, not two. The bug this replaces
// rendered a status label once permission was granted, so there was no way to
// stop alerts from inside the app at all.

describe('toggleState', () => {
  test('covers every permission and mute combination', () => {
    expect(toggleState('unsupported', false)).toBe('unsupported');
    expect(toggleState('denied', false)).toBe('denied');
    expect(toggleState('default', false)).toBe('default');
    expect(toggleState('granted', false)).toBe('on');
    expect(toggleState('granted', true)).toBe('muted');
  });

  test('mute is irrelevant until permission is granted', () => {
    // A stale muted flag from a previous grant must not make an ungranted
    // button read as "muted", which would look like alerts are merely paused.
    expect(toggleState('default', true)).toBe('default');
    expect(toggleState('denied', true)).toBe('denied');
    expect(toggleState('unsupported', true)).toBe('unsupported');
  });

  test('every actionable state has a label and a tooltip', () => {
    for (const s of ['default', 'on', 'muted', 'denied']) {
      expect(TOGGLE_LABEL[s]).toBeTruthy();
      expect(TOGGLE_TITLE[s]).toBeTruthy();
    }
  });

  test('on and muted are visually distinguishable', () => {
    expect(TOGGLE_LABEL.on).not.toBe(TOGGLE_LABEL.muted);
  });
});

describe('mute persistence', () => {
  beforeEach(() => window.localStorage.clear());

  test('defaults to unmuted', () => {
    expect(isMuted()).toBe(false);
  });

  test('round-trips through storage so a reload does not un-mute', () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  // These must spy on Storage.prototype, NOT assign to window.localStorage
  // .getItem. jsdom silently ignores that assignment — the original version of
  // these tests did exactly that, passed, and still passed when the try/catch
  // was deleted. They were guarding nothing.

  test('survives unreadable storage without throwing', () => {
    // localStorage throws outright in some privacy modes. Failing to read the
    // preference must not take the dashboard down with it.
    const spy = jest.spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => { throw new Error('blocked'); });
    expect(() => isMuted()).not.toThrow();
    expect(isMuted()).toBe(false);        // safe default: alert rather than go silent
    spy.mockRestore();
  });

  test('survives unwritable storage without throwing', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setMuted(true)).not.toThrow();
    spy.mockRestore();
  });

  test('survives an unremovable key without throwing', () => {
    // Un-muting takes the removeItem path, which is a separate call.
    const spy = jest.spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setMuted(false)).not.toThrow();
    spy.mockRestore();
  });
});

describe('muting does not replay backlog', () => {
  test('the seen-set still advances while muted', () => {
    // Muting suppresses delivery only. If the diff stopped running, unmuting
    // would fire an alert for every position opened in the meantime.
    const first = diffNewPositions(null, []);
    const during = diffNewPositions(first.seen, [pos('2_100'), pos('2_101')]);
    expect(during.seen.size).toBe(2);

    const after = diffNewPositions(during.seen, [pos('2_100'), pos('2_101')]);
    expect(after.fresh).toHaveLength(0);
  });
});
