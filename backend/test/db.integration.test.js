// Live-database checks for the raw-SQL write paths.
//
// sqlShape.test.js proves the SQL is internally consistent with the schema
// as written in database.js. This file proves the other half: that Postgres
// itself accepts every statement, and that the write paths actually persist
// a row rather than merely not throwing. The 39/38 INSERT was "not throwing"
// only because nobody was looking at the throw.
//
// SKIPPED unless TEST_DATABASE_URL is set, so the ordinary `npm test` pass
// stays connection-free:
//
//   TEST_DATABASE_URL=postgres://localhost/gold_trader_test npm test
//
// TEST_DATABASE_URL must be a scratch database. It is deliberately a
// separate variable from DATABASE_URL, and the suite refuses to run if the
// two match, so a stray environment can never point these writes at
// production.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractInserts } from './helpers/sqlIntrospect.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_ACCOUNT = '__sqltest_account__';

if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL must not equal DATABASE_URL — these tests write rows ' +
    'and must never run against the live database.'
  );
}

function staticInserts() {
  const lintable = f => f.endsWith('.js') && !f.startsWith('verify-');
  const files = [];
  for (const f of readdirSync(BACKEND)) {
    if (lintable(f)) files.push(join(BACKEND, f));
  }
  for (const dir of ['deciders']) {
    let entries;
    try { entries = readdirSync(join(BACKEND, dir)); } catch { continue; }
    for (const f of entries) if (lintable(f)) files.push(join(BACKEND, dir, f));
  }
  return files.flatMap(path =>
    extractInserts(readFileSync(path, 'utf8'), relative(BACKEND, path))
  ).filter(i => i.columns && !i.dynamicValues && !i.valuesFromSelect && i.rowValueCount > 0);
}

describe('database write paths (live)', { skip: TEST_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = TEST_URL;
    db = (await import('../database.js')).default;
    await db.init();
  });

  after(async () => {
    if (!db?.pool) return;
    await db.pool.query(
      `DELETE FROM mechanical_variant_decision_outcomes
       WHERE decision_id IN (SELECT id FROM mechanical_variant_decisions WHERE account = $1)`,
      [TEST_ACCOUNT]
    );
    await db.pool.query(
      'DELETE FROM mechanical_variant_decisions WHERE account = $1',
      [TEST_ACCOUNT]
    );
    await db.pool.end();
  });

  // PREPARE makes Postgres parse and plan the statement — resolving every
  // table and column and binding every $n — without executing it. Any
  // arity error, typo, or reference to a column the live schema does not
  // have fails here, across every write path at once, with no test needing
  // to know what a valid row for that table looks like.
  test('Postgres accepts every INSERT statement', async () => {
    const failures = [];
    let n = 0;
    for (const stmt of staticInserts()) {
      const name = `sqlcheck_${n++}`;
      const sql = stmt.rawStatement ?? null;
      if (!sql) continue;
      try {
        await db.pool.query(`PREPARE ${name} AS ${sql}`);
        await db.pool.query(`DEALLOCATE ${name}`);
      } catch (err) {
        failures.push(`${stmt.file}:${stmt.line} INSERT INTO ${stmt.table} — ${err.message}`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  test('saveMechanicalVariantDecision persists a row it can read back', async () => {
    const decision = {
      account: TEST_ACCOUNT,
      signalId: null,
      cycleTsUtc: '2026-08-13T12:00:00.000Z',
      cycleTsUae: '2026-08-13T16:00:00.000Z',
      uaeWeekday: 4,
      uaeHour: 16,
      direction: 'LONG',
      signalEntry: 2400.5,
      signalStop: 2390.0,
      signalTarget: 2420.0,
      mechTag: 'TEST',
      mechReasoning: 'integration test row',
      h4Rsi: 55, h1Rsi: 52, h4MacdHist: 0.4, h1MacdHist: 0.2,
      h4Adx: 25, h1Adx: 22, h1Atr: 4.2, h4Atr: 9.1,
      clampedStop: 2392.1,
      atrMultApplied: 1.75,
      sessionPermitted: true,
      riskStateBefore: 'NORMAL',
      riskStateAfter: 'NORMAL',
      stateTransitionReason: null,
      allowedRiskPct: 1.0,
      equity: 100000,
      dayStartEquity: 100000,
      dayPnl: 0,
      openRiskPctBefore: 0,
      openPositionCount: 0,
      consecutiveLosses: 0,
      finalAction: 'EXECUTE',
      reasonCode: null,
      lots: 0.5,
      riskUsd: 1000,
      theoretical1pctLots: 0.5,
      tradeId: null,
      configVersion: 'abc123def456',
      configSnapshot: JSON.stringify({ entryWindowStartHour: 15, entryWindowEndHour: 18 }),
    };

    const id = await db.saveMechanicalVariantDecision(decision);
    assert.ok(Number.isInteger(id), 'expected an inserted row id');

    const { rows } = await db.pool.query(
      'SELECT * FROM mechanical_variant_decisions WHERE id = $1',
      [id]
    );
    assert.equal(rows.length, 1, 'row was not persisted');

    // Spot-check across the full width of the statement — the 39/38 bug was
    // an off-by-one at the very end of a long column list, so the last
    // columns matter more than the first.
    const row = rows[0];
    assert.equal(row.account, TEST_ACCOUNT);
    assert.equal(row.direction, 'LONG');
    assert.equal(row.final_action, 'EXECUTE');
    assert.equal(Number(row.theoretical_1pct_lots), 0.5);
    assert.equal(Number(row.risk_usd), 1000);
    assert.equal(row.trade_id, null);
    assert.equal(row.session_permitted, true);
    assert.equal(row.consecutive_losses, 0);
    // The config stamp is at the very end of the column list, which is
    // exactly where an arity mistake lands.
    assert.equal(row.config_version, 'abc123def456');
    assert.equal(JSON.parse(row.config_snapshot).entryWindowStartHour, 15);
  });

  test('saveMechanicalVariantDecisionOutcome persists once and is idempotent', async () => {
    const { rows: [decision] } = await db.pool.query(
      'SELECT id FROM mechanical_variant_decisions WHERE account = $1 LIMIT 1',
      [TEST_ACCOUNT]
    );
    assert.ok(decision, 'expected the decision row from the previous test');

    const leg = outcome => ({
      outcome, exitPrice: 2410, pnl: 250, rMultiple: 1.2, mfe: 300, mae: -80,
    });
    const payload = {
      decisionId: decision.id,
      h1: leg('TARGET_HIT'),
      h4: leg('TARGET_HIT'),
      eod: leg('TARGET_HIT'),
      maturedAt: '2026-08-13T21:00:00.000Z',
    };

    await db.saveMechanicalVariantDecisionOutcome(payload);
    await db.saveMechanicalVariantDecisionOutcome(payload);

    const { rows } = await db.pool.query(
      'SELECT * FROM mechanical_variant_decision_outcomes WHERE decision_id = $1',
      [decision.id]
    );
    assert.equal(rows.length, 1, 'ON CONFLICT (decision_id) DO NOTHING did not hold');
    assert.equal(rows[0].eod_outcome, 'TARGET_HIT');
    assert.equal(Number(rows[0].h1_r_multiple), 1.2);
  });
});
