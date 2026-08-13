// Guards the raw-SQL write paths against the class of mistake that shipped
// in saveMechanicalVariantDecision: 39 column names against 38 `$n`
// placeholders. That INSERT threw on every call from the moment it
// deployed, and because the throw was uncaught the overlay and hybrid
// accounts' decisions were silently dropped on every cycle Mechanical
// proposed a trade. Nothing caught it because all 141 existing tests are
// pure-function and never touch the database.
//
// These checks are static: they parse the SQL out of the source text and
// compare it against the CREATE TABLE / ALTER TABLE definitions in
// database.js. No connection, no fixtures, no Postgres in CI — they run in
// the ordinary `npm test` pass. Live persistence is covered separately by
// db.integration.test.js, which is gated on TEST_DATABASE_URL.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractSchema,
  extractInserts,
  extractParameterisedStatements,
  extractDdlSequence,
  placeholderIndices,
  stripSqlComments,
} from './helpers/sqlIntrospect.js';

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));

// verify-*.js are one-off manual verification scripts, not part of the
// running service — several predate the Postgres migration and still carry
// SQLite-style `?` placeholders. Linting them would report noise about dead
// code rather than defects in live write paths.
const isLintable = f => f.endsWith('.js') && !f.startsWith('verify-');

function sourceFiles() {
  const files = [];
  for (const f of readdirSync(BACKEND)) {
    if (isLintable(f)) files.push(join(BACKEND, f));
  }
  for (const dir of ['deciders']) {
    let entries;
    try { entries = readdirSync(join(BACKEND, dir)); } catch { continue; }
    for (const f of entries) {
      if (isLintable(f)) files.push(join(BACKEND, dir, f));
    }
  }
  return files;
}

const FILES = sourceFiles().map(path => ({
  path,
  rel: relative(BACKEND, path),
  source: readFileSync(path, 'utf8'),
}));

// The schema lives entirely in database.js's initialize().
const SCHEMA = extractSchema(
  FILES.find(f => f.rel === 'database.js').source
);

const ALL_INSERTS = FILES.flatMap(f => extractInserts(f.source, f.rel));

// INSERTs whose VALUES tuple is statically knowable — the ones we can
// check arity on. Dynamic (`VALUES ${rows.join(',')}`) and INSERT..SELECT
// forms are excluded by construction, not by accident.
const STATIC_INSERTS = ALL_INSERTS.filter(
  i => i.columns && !i.dynamicValues && !i.valuesFromSelect && i.rowValueCount > 0
);

const describeInsert = i => `${i.rel ?? i.file}:${i.line} INSERT INTO ${i.table}`;

describe('sqlIntrospect parser', () => {
  // The linter is only worth having if it actually fires on the bug it was
  // written for, so the original defect is pinned here as a fixture.
  test('detects the saveMechanicalVariantDecision 39/38 mismatch', () => {
    const buggy = `
      const r = await this.pool.query(\`
        INSERT INTO mechanical_variant_decisions (
          account, signal_id, cycle_ts_utc
        ) VALUES (
          $1,$2
        ) RETURNING id
      \`, [d.account, d.signalId, d.cycleTsUtc]);
    `;
    const [stmt] = extractInserts(buggy, 'fixture.js');
    assert.equal(stmt.table, 'mechanical_variant_decisions');
    assert.equal(stmt.columns.length, 3);
    assert.equal(stmt.rowValueCount, 2);
    assert.notEqual(stmt.columns.length, stmt.rowValueCount);
  });

  test('accepts a well-formed INSERT', () => {
    const ok = `
      await this.pool.query(\`
        INSERT INTO t (a, b, c) VALUES ($1,$2,$3) RETURNING id
      \`, [1, 2, 3]);
    `;
    const [stmt] = extractInserts(ok, 'fixture.js');
    assert.equal(stmt.columns.length, 3);
    assert.equal(stmt.rowValueCount, 3);
  });

  test('counts only the first tuple of a multi-row VALUES', () => {
    const multi = 'q(`INSERT INTO t (a, b) VALUES ($1,$2),($3,$4)`)';
    const [stmt] = extractInserts(multi, 'fixture.js');
    assert.equal(stmt.rowPlaceholderCount, 2);
    assert.deepEqual(stmt.allPlaceholders, [1, 2, 3, 4]);
  });

  test('flags interpolated VALUES as dynamic rather than guessing', () => {
    const dyn = 'q(`INSERT INTO t (a, b) VALUES ${values.join(x)} ON CONFLICT DO NOTHING`)';
    const [stmt] = extractInserts(dyn, 'fixture.js');
    assert.equal(stmt.dynamicValues, true);
  });

  test('does not count placeholders in ON CONFLICT toward the row tuple', () => {
    const upsert =
      'q(`INSERT INTO t (a, b) VALUES ($1,$2) ON CONFLICT (a) DO UPDATE SET b = $3`)';
    const [stmt] = extractInserts(upsert, 'fixture.js');
    assert.equal(stmt.rowPlaceholderCount, 2);
    assert.deepEqual(stmt.allPlaceholders, [1, 2, 3]);
  });

  test('strips comments without disturbing string literals', () => {
    const sql = "SELECT 'a -- b' AS x -- trailing\n, y";
    const stripped = stripSqlComments(sql);
    assert.ok(stripped.includes("'a -- b'"));
    assert.ok(!stripped.includes('trailing'));
  });

  test('parses CREATE TABLE columns and skips table constraints', () => {
    const schema = extractSchema(`
      await q(\`
        CREATE TABLE IF NOT EXISTS t (
          id      SERIAL PRIMARY KEY,
          name    TEXT NOT NULL,
          note    TEXT,
          made_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD'),
          UNIQUE (name)
        )
      \`);
    `);
    assert.deepEqual([...schema.t.columns.keys()], ['id', 'name', 'note', 'made_at']);
    assert.equal(schema.t.columns.get('name').notNull, true);
    assert.equal(schema.t.columns.get('name').hasDefault, false);
    assert.equal(schema.t.columns.get('made_at').hasDefault, true);
    assert.equal(schema.t.columns.get('id').isSerial, true);
  });

  test('folds ALTER TABLE ADD COLUMN migrations into the schema', () => {
    const schema = extractSchema(`
      await q(\`CREATE TABLE IF NOT EXISTS t (id SERIAL PRIMARY KEY)\`);
      await q(\`ALTER TABLE t ADD COLUMN IF NOT EXISTS extra DOUBLE PRECISION\`);
    `);
    assert.ok(schema.t.columns.has('extra'));
  });

  test('rawStatement carries the whole statement, comments blanked', () => {
    const src = [
      'await q(`',
      '  INSERT INTO t (a, b) -- trailing note',
      '  VALUES ($1,$2) RETURNING id',
      '`);',
    ].join('\n');
    const [stmt] = extractInserts(src, 'fixture.js');
    assert.match(stmt.rawStatement, /^INSERT INTO t/);
    assert.match(stmt.rawStatement, /RETURNING id/);
    assert.ok(!stmt.rawStatement.includes('trailing note'));
  });

  test('placeholderIndices deduplicates and sorts', () => {
    assert.deepEqual(placeholderIndices('$2,$10,$1,$2'), [1, 2, 10]);
  });
});

describe('SQL write paths', () => {
  test('the parser found the write paths it is meant to guard', () => {
    // A refactor that moves or reshapes these statements should fail loudly
    // here rather than quietly reduce this whole file to a no-op.
    assert.ok(
      STATIC_INSERTS.length >= 10,
      `expected to parse at least 10 static INSERTs, found ${STATIC_INSERTS.length}`
    );
    const tables = new Set(STATIC_INSERTS.map(i => i.table));
    for (const required of [
      'mechanical_variant_decisions',
      'mechanical_variant_decision_outcomes',
      'hybrid_decisions',
      'trades',
      'signals',
    ]) {
      assert.ok(tables.has(required), `no parsed INSERT into ${required}`);
    }
  });

  test('every INSERT has one VALUES entry per column', () => {
    const bad = STATIC_INSERTS
      .filter(i => i.columns.length !== i.rowValueCount)
      .map(i =>
        `${describeInsert(i)} — ${i.columns.length} columns, ${i.rowValueCount} values`
      );
    assert.deepEqual(bad, [], `INSERT arity mismatch:\n${bad.join('\n')}`);
  });

  test('every INSERT column list parses as identifiers', () => {
    const bad = ALL_INSERTS
      .filter(i => i.malformed && i.malformed.length)
      .map(i => `${describeInsert(i)} — unparsable: ${i.malformed.join(', ')}`);
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('every INSERT column exists in the schema', () => {
    const bad = [];
    for (const i of ALL_INSERTS) {
      if (!i.columns) continue;
      const table = SCHEMA[i.table];
      if (!table) {
        bad.push(`${describeInsert(i)} — table not defined in database.js`);
        continue;
      }
      for (const col of i.columns) {
        if (!table.columns.has(col)) {
          bad.push(`${describeInsert(i)} — unknown column "${col}"`);
        }
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('every INSERT supplies all NOT NULL columns lacking a default', () => {
    const bad = [];
    for (const i of ALL_INSERTS) {
      if (!i.columns) continue;
      const table = SCHEMA[i.table];
      if (!table) continue;
      const supplied = new Set(i.columns);
      for (const col of table.columns.values()) {
        if (!col.notNull || col.hasDefault || col.isSerial) continue;
        if (!supplied.has(col.name)) {
          bad.push(`${describeInsert(i)} — omits NOT NULL column "${col.name}"`);
        }
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('no ALTER TABLE runs before its own CREATE TABLE', () => {
    // initialize() is the only schema bootstrap there is, and it must work
    // against a genuinely empty database — a new Railway instance, a
    // restore, a local test DB. An ALTER above its CREATE only looks fine
    // because existing deployments already have the table.
    const created = new Set();
    const bad = [];
    for (const stmt of extractDdlSequence(
      FILES.find(f => f.rel === 'database.js').source
    )) {
      if (stmt.kind === 'create') { created.add(stmt.table); continue; }
      if (!created.has(stmt.table)) {
        bad.push(`database.js:${stmt.line} — ALTER TABLE ${stmt.table} precedes its CREATE TABLE`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('every parameterised statement uses a contiguous $1..$N sequence', () => {
    const bad = [];
    for (const f of FILES) {
      for (const stmt of extractParameterisedStatements(f.source, f.rel)) {
        // Interpolated SQL numbers its own placeholders at runtime, so a
        // gap in the literal source text is expected and meaningless.
        if (stmt.dynamic) continue;
        const { placeholders } = stmt;
        const max = placeholders[placeholders.length - 1];
        const missing = [];
        for (let n = 1; n <= max; n++) {
          if (!placeholders.includes(n)) missing.push(`$${n}`);
        }
        if (missing.length) {
          bad.push(
            `${stmt.file}:${stmt.line} ${stmt.verb} — highest is $${max} but ${missing.join(', ')} unused`
          );
        }
      }
    }
    assert.deepEqual(bad, [], `placeholder gaps:\n${bad.join('\n')}`);
  });
});
