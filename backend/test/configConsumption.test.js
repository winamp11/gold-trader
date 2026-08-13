// Every configurable setting must actually be read by something.
//
// maxRiskPerTradePct was exposed in both mechanical variant schemas, with
// help text promising it was the "ceiling for any single position at NORMAL
// risk state" — and nothing ever read it. Prime and Session were therefore
// not testing the configuration they documented, and the dashboard showed a
// control that did nothing. A dead setting is worse than a missing one: it
// silently invalidates the experiment it appears to configure.
//
// This is a deliberately blunt check — it asks whether the key name appears
// anywhere in the service outside the schema that declares it, without
// pretending to trace data flow.
//
// Known limit, worth being honest about: the sweep is per-key, not
// per-schema. A name shared by two schemas counts as consumed if EITHER
// consumer reads it, which is precisely how maxRiskPerTradePct hid — hybrid
// used it, so the name was present while the variant pipeline ignored it.
// The sweep alone would not have caught the original bug. That is why the
// per-trade cap has its own pinned assertion at the bottom of this file;
// apply the same treatment to any other setting whose wiring matters.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_SCHEMA,
  MECHANICAL_PRIME_SCHEMA,
  MECHANICAL_SESSION_SCHEMA,
} from '../botConfig.js';

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));

// botConfig.js declares the schemas, so a key naturally appears there;
// verify-*.js are one-off scripts and do not count as a consumer.
const DECLARING_FILE = 'botConfig.js';

function consumerSources() {
  const lintable = f => f.endsWith('.js') && !f.startsWith('verify-') && f !== DECLARING_FILE;
  const files = [];
  for (const f of readdirSync(BACKEND)) {
    if (lintable(f)) files.push(join(BACKEND, f));
  }
  for (const dir of ['deciders']) {
    let entries;
    try { entries = readdirSync(join(BACKEND, dir)); } catch { continue; }
    for (const f of entries) if (lintable(f)) files.push(join(BACKEND, dir, f));
  }
  return files.map(path => ({
    rel: relative(BACKEND, path),
    source: readFileSync(path, 'utf8'),
  }));
}

const SOURCES = consumerSources();

function consumersOf(key) {
  // Word-boundary match so `atrMultMin` cannot be satisfied by `atrMultMinX`.
  const re = new RegExp(`\\b${key}\\b`);
  return SOURCES.filter(s => re.test(s.source)).map(s => s.rel);
}

const SCHEMAS = [
  ['hybrid (CONFIG_SCHEMA)', CONFIG_SCHEMA],
  ['mechanical_prime', MECHANICAL_PRIME_SCHEMA],
  ['mechanical_session', MECHANICAL_SESSION_SCHEMA],
];

describe('bot config settings are actually consumed', () => {
  for (const [label, schema] of SCHEMAS) {
    test(`${label}: every key is read somewhere in the service`, () => {
      const dead = schema
        .map(field => field.key)
        .filter(key => consumersOf(key).length === 0);
      assert.deepEqual(
        dead, [],
        `${label} declares settings nothing reads: ${dead.join(', ')}`
      );
    });
  }

  test('schemas declare no duplicate keys', () => {
    for (const [label, schema] of SCHEMAS) {
      const keys = schema.map(f => f.key);
      assert.equal(
        new Set(keys).size, keys.length,
        `${label} has duplicate keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`
      );
    }
  });

  test('every schema field carries the metadata the dashboard renders', () => {
    for (const [label, schema] of SCHEMAS) {
      for (const field of schema) {
        assert.ok(field.key, `${label}: field without a key`);
        assert.ok(field.label, `${label}:${field.key} has no label`);
        assert.ok(field.help, `${label}:${field.key} has no help text`);
        assert.equal(typeof field.def, 'number', `${label}:${field.key} has no numeric default`);
      }
    }
  });

  test('the per-trade risk cap specifically is wired into the variant pipeline', () => {
    // Pinned separately from the generic sweep above: this is the setting
    // that was dead, and the sweep would still pass if the key survived only
    // in a comment.
    const server = SOURCES.find(s => s.rel === 'server.js').source;
    assert.match(
      server,
      /applyPerTradeRiskCap\(\s*RISK_STATE_PCT\[[^\]]+\],\s*cfg\.maxRiskPerTradePct\s*\)/,
      'server.js no longer applies maxRiskPerTradePct to the risk-state percentage'
    );
  });
});
