// Ordering guards for the mechanical_prime/mechanical_session pipeline.
//
// evaluateMechanicalVariant lives in server.js and is not a pure function,
// so it cannot be exercised the way mechanicalRiskEngine.js is. But two of
// its properties are structural, and both were silently violated in ways
// that corrupted the experiment rather than crashing anything:
//
//   1. The ATR clamp must be computed BEFORE the rejection gates, so every
//      REJECT row records the stop this account would really have used. It
//      used to run after them, so early rejections stored clamped_stop=null.
//   2. Maturation must NOT fall back to Mechanical's raw signal_stop when
//      clamped_stop is missing. Combined with (1), that fallback meant
//      essentially every counterfactual — and therefore every value-
//      attribution metric — was resolved against a stop the account would
//      never have traded.
//
// Neither failure produced an error, a log line, or a failing test. They
// just produced confident-looking numbers that meant something other than
// what they claimed, which is the failure mode this whole account
// comparison is most vulnerable to.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));
const read = f => readFileSync(join(BACKEND, f), 'utf8');

/** Body of evaluateMechanicalVariant, from its declaration to the next top-level function. */
function variantPipelineSource() {
  const server = read('server.js');
  const start = server.indexOf('async function evaluateMechanicalVariant');
  assert.notEqual(start, -1, 'evaluateMechanicalVariant not found — has it been renamed?');
  const end = server.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'could not find the end of evaluateMechanicalVariant');
  return server.slice(start, end);
}

describe('mechanical variant pipeline ordering', () => {
  test('the ATR clamp is computed before the first rejection gate', () => {
    const body = variantPipelineSource();
    const clampAt = body.indexOf('clampStopToAtrBand({');
    const firstRejectAt = body.search(/return reject\(/);

    assert.notEqual(clampAt, -1, 'clampStopToAtrBand call not found in the pipeline');
    assert.notEqual(firstRejectAt, -1, 'no rejection gate found in the pipeline');
    assert.ok(
      clampAt < firstRejectAt,
      'clampStopToAtrBand must run before the first `return reject(...)`, otherwise ' +
      'early rejections journal clamped_stop=null and their counterfactuals are ' +
      'resolved against geometry this account would never have traded'
    );
  });

  test('clampStopToAtrBand is called exactly once in the pipeline', () => {
    // Two call sites would let the journalled geometry and the traded
    // geometry drift apart under different config reads.
    const body = variantPipelineSource();
    const calls = [...body.matchAll(/clampStopToAtrBand\(\{/g)].length;
    assert.equal(calls, 1, `expected 1 clamp call site, found ${calls}`);
  });

  test('rejection rows default to the clamp geometry, not null', () => {
    const body = variantPipelineSource();
    assert.match(
      body,
      /clampedStop:\s*extra\.clampedStop\s*\?\?\s*clamp\?\.stop/,
      'the reject() helper no longer defaults clamped_stop to the computed clamp'
    );
  });

  test('maturation never falls back to the raw signal stop', () => {
    const maturation = read('mechanicalVariantMaturation.js');
    assert.ok(
      !/clamped_stop\s*\?\?\s*row\.signal_stop/.test(maturation),
      'maturation resolves counterfactuals against Mechanical\'s raw stop when ' +
      'clamped_stop is missing — skip the row instead, a biased observation is ' +
      'worse than no observation'
    );
    assert.match(
      maturation,
      /const stop = row\.clamped_stop;/,
      'expected maturation to use the clamped stop alone'
    );
  });
});
