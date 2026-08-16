// The daily reflector's scheduling decision.
//
// This is the code that stopped overlay's journal for 16 days without raising
// anything. The job itself was fine the whole time — the LLM call, the
// selection query and the INSERT all worked when invoked by hand. What failed
// was the condition deciding whether to invoke it, which was untested,
// in-memory, and silent when it never became true.
//
// Both defects it had are pinned here: a config value that could disable the
// job forever, and a schedule with no way to recover a missed day.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReflectMin,
  shouldReflectNow,
  REFLECT_DEFAULT_MIN,
  REFLECT_PORTFOLIO_IDS,
} from '../deciders/reflector.js';

describe('normalizeReflectMin', () => {
  test('unset falls back to 21:15 UAE', () => {
    assert.equal(normalizeReflectMin(undefined), REFLECT_DEFAULT_MIN);
    assert.equal(normalizeReflectMin(null), REFLECT_DEFAULT_MIN);
    assert.equal(normalizeReflectMin(''), REFLECT_DEFAULT_MIN);
    assert.equal(REFLECT_DEFAULT_MIN, 21 * 60 + 15);
  });

  test('a valid minutes-since-midnight value is honoured', () => {
    assert.equal(normalizeReflectMin('600'), 600);
    assert.equal(normalizeReflectMin(0), 0);
    assert.equal(normalizeReflectMin(1439), 1439);
  });

  test('REGRESSION: HHMM-style 2115 cannot silently disable the job', () => {
    // The prime suspect for the 16-day outage. Minutes-since-midnight maxes
    // out at 1439, so a threshold of 2115 is never reached: the scheduler
    // returns early forever and the journal simply stops, with no error
    // raised anywhere in the system.
    const warnings = [];
    assert.equal(normalizeReflectMin('2115', m => warnings.push(m)), REFLECT_DEFAULT_MIN);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2115/);
    assert.match(warnings[0], /disable daily reflection/);
  });

  test('other unreachable or nonsensical values also fall back, loudly', () => {
    for (const bad of ['1440', '9999', '-5', 'abc', 'NaN']) {
      const warnings = [];
      assert.equal(normalizeReflectMin(bad, m => warnings.push(m)), REFLECT_DEFAULT_MIN, bad);
      assert.equal(warnings.length, 1, `${bad} should warn`);
    }
  });
});

describe('shouldReflectNow', () => {
  const base = { today: '2026-08-16', yesterday: '2026-08-15', reflectMin: 1275 };

  test('does not run twice on the same day', () => {
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-08-16', minsNow: 1400 });
    assert.equal(r.due, false);
    assert.match(r.reason, /already ran today/);
  });

  test('waits for the scheduled minute on a normal day', () => {
    // Ran yesterday, so nothing is missed — no reason to fire early.
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-08-15', minsNow: 1274 });
    assert.equal(r.due, false);
    assert.match(r.reason, /before the scheduled time/);
  });

  test('fires at exactly the scheduled minute', () => {
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-08-15', minsNow: 1275 });
    assert.equal(r.due, true);
    assert.equal(r.reason, 'scheduled');
  });

  test('REGRESSION: a missed day is caught up regardless of the clock', () => {
    // The second defect. The old schedule only ran between 21:15 and midnight,
    // so a process not alive in that window lost the day permanently — and
    // every following day too, since nothing tracked the gap.
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-08-14', minsNow: 30 });
    assert.equal(r.due, true, 'a two-day-old run must catch up immediately');
    assert.match(r.reason, /catch-up/);
  });

  test('the 16-day gap would have been caught on the very next tick', () => {
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-07-31', minsNow: 0 });
    assert.equal(r.due, true);
    assert.match(r.reason, /catch-up — last run 2026-07-31/);
  });

  test('a first-ever run catches up rather than waiting for the window', () => {
    const r = shouldReflectNow({ ...base, lastRunDate: null, minsNow: 0 });
    assert.equal(r.due, true);
    assert.match(r.reason, /never run/);
  });

  test('yesterday plus early-morning is NOT treated as a missed day', () => {
    // Boundary worth pinning: ran yesterday evening, it is now this morning.
    // Nothing has been missed, so it should wait rather than double up.
    const r = shouldReflectNow({ ...base, lastRunDate: '2026-08-15', minsNow: 400 });
    assert.equal(r.due, false);
  });
});

describe('reflector scope', () => {
  test('disabled accounts are not reflected on', () => {
    // claude_solo (3) stopped trading on 2026-08-09. Reflecting its history
    // spends tokens producing lessons nothing will read.
    assert.deepEqual(REFLECT_PORTFOLIO_IDS, [2]);
    assert.ok(!REFLECT_PORTFOLIO_IDS.includes(3), 'solo must not be reflected on while disabled');
  });
});
