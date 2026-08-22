// Exit-reason classification: the distinction between "the trade's own
// stop/target resolved it" and "a rule closed it early", and the fact that
// five different rules no longer collapse into CIRCUIT_BREAKER.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_REASONS,
  FORCED_EXIT_REASONS,
  FORCED_EXIT_REASONS_SQL,
  isForcedExit,
  isRealizedExit,
} from '../exitReasons.js';

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));
const read = f => readFileSync(join(BACKEND, f), 'utf8');

describe('exit reason classification', () => {
  test('strategy exits are realized but not forced', () => {
    for (const r of [EXIT_REASONS.TARGET_HIT, EXIT_REASONS.STOP_HIT]) {
      assert.equal(isForcedExit(r), false, r);
      assert.equal(isRealizedExit(r), true, r);
    }
  });

  test('every forced reason is both forced and realized', () => {
    for (const r of FORCED_EXIT_REASONS) {
      assert.equal(isForcedExit(r), true, r);
      assert.equal(isRealizedExit(r), true, r);
    }
  });

  test('NO_ENTRY is neither — it was never filled and has no P&L', () => {
    // This is the row that inflated the account-overview win-rate
    // denominator: an exit_reason with no possible P&L.
    assert.equal(isForcedExit(EXIT_REASONS.NO_ENTRY), false);
    assert.equal(isRealizedExit(EXIT_REASONS.NO_ENTRY), false);
  });

  test('unknown and empty reasons are not silently treated as forced', () => {
    for (const r of [undefined, null, '', 'SOMETHING_ELSE']) {
      assert.equal(isForcedExit(r), false, String(r));
      assert.equal(isRealizedExit(r), false, String(r));
    }
  });

  test('the give-back and daily-guard causes are distinct from CIRCUIT_BREAKER', () => {
    // The whole point: "how often did the breaker actually fire" must be an
    // answerable question. Give-back banking is routine profit-taking that
    // keeps trading, not a breaker event.
    const distinct = [
      EXIT_REASONS.GIVE_BACK,
      EXIT_REASONS.DAILY_MAX_LOSS,
      EXIT_REASONS.DAILY_TARGET,
      EXIT_REASONS.PROP_HARD_HALT,
    ];
    for (const r of distinct) {
      assert.notEqual(r, EXIT_REASONS.CIRCUIT_BREAKER);
      assert.ok(FORCED_EXIT_REASONS.includes(r), `${r} should still count as forced`);
    }
    assert.equal(new Set(distinct).size, distinct.length, 'reasons must be distinct values');
  });

  test('the SQL literal list is quoted, complete, and injection-free', () => {
    for (const r of FORCED_EXIT_REASONS) {
      assert.ok(FORCED_EXIT_REASONS_SQL.includes(`'${r}'`), `${r} missing from SQL list`);
    }
    assert.match(FORCED_EXIT_REASONS_SQL, /^'[A-Z_]+'(, '[A-Z_]+')*$/);
  });
});

describe('forceClosePortfolio callers state their cause', () => {
  test('no caller relies on the default reason', () => {
    // The default exists only so the signature stays compatible; every real
    // call site must name its cause, or the four causes silently merge again.
    const server = read('server.js');
    // Was >= 4 until 2026-08-22, when prop_sim's hard halt and the mechanical
    // variants were retired. The count is not the point -- naming the cause is
    // -- so the floor tracks the call sites that actually remain.
    const calls = [...server.matchAll(/forceClosePortfolio\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(calls.length >= 2, `expected at least 2 call sites, found ${calls.length}`);
    for (const args of calls) {
      assert.match(
        args, /EXIT_REASONS\./,
        `forceClosePortfolio(${args}) does not name an explicit exit reason`
      );
    }
  });

  test('give-back banking is not labelled CIRCUIT_BREAKER', () => {
    const server = read('server.js');
    assert.match(
      server,
      /logSeries\('give_back'[\s\S]{0,200}?forceClosePortfolio\([^)]*EXIT_REASONS\.GIVE_BACK\)/,
      'the give-back path must close positions as GIVE_BACK'
    );
  });

  test('nothing hardcodes a forced reason string inside outcomeTracker', () => {
    const tracker = read('outcomeTracker.js');
    assert.ok(
      !/finalizePosition\([^)]*'CIRCUIT_BREAKER'/.test(tracker),
      'forceClosePortfolio must pass its caller-supplied reason through'
    );
  });
});
