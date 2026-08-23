// The closed entry-reason vocabulary injected into the overlay decider prompt.
//
// This exists because free-text tags produced 77 distinct strings over 125
// trades, 59 of them appearing exactly once — Analyst could not aggregate
// expectancy per setup at all. The failure modes worth pinning are the ones
// that would quietly re-open that door:
//
//   1. The block silently not reaching the prompt (import renamed, string
//      interpolated into the wrong template) — the model then invents tags
//      again and nothing errors.
//   2. Sizing/stop mechanics creeping back into the entry vocabulary. That
//      was the actual cause of the fragmentation: `atr_resize` appeared in 73
//      of the 77 tags, so almost every tag was unique by construction.
//   3. Losing the `other` escape hatch. Without it the model forces bad fits
//      into the nearest tag, which is worse than fragmentation because the
//      resulting expectancy numbers look usable and aren't.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ENTRY_TAG_TAXONOMY, ENTRY_TAXONOMY_PROMPT_BLOCK, TAG_TAXONOMY } from '../tagTaxonomy.js';
import { SYSTEM_PROMPT_FOR_TEST } from '../deciders/claudeOverlayDecider.js';

describe('entry tag taxonomy', () => {
  test('every key is snake_case and every key has a definition', () => {
    for (const [key, desc] of Object.entries(ENTRY_TAG_TAXONOMY)) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `bad key: ${key}`);
      assert.ok(desc && desc.length > 10, `missing/short description for ${key}`);
    }
  });

  test('carries an "other" escape hatch', () => {
    // Removing this is the tempting "cleanup" — it forces the model to
    // mislabel rather than admit no setup applied.
    assert.ok('other' in ENTRY_TAG_TAXONOMY);
  });

  test('contains no sizing or stop-management mechanics', () => {
    // The fragmentation cause. These are risk mechanics, not entry reasons,
    // and they belong in `reasoning`.
    const banned = ['resize', 'atr', 'lot', 'size', 'sized', 'stagger', 'budget', 'cluster'];
    for (const key of Object.keys(ENTRY_TAG_TAXONOMY)) {
      for (const b of banned) {
        assert.ok(!key.includes(b), `entry tag "${key}" encodes a risk mechanic ("${b}")`);
      }
    }
  });

  test('is disjoint from the reflector lesson taxonomy', () => {
    // Two different questions — "why enter?" vs "what did we learn?" — and
    // two different consumers. A shared key would make Analyst aggregate
    // decision-time tags together with post-hoc lesson tags.
    for (const key of Object.keys(ENTRY_TAG_TAXONOMY)) {
      assert.ok(!(key in TAG_TAXONOMY), `"${key}" appears in both taxonomies`);
    }
  });

  test('prompt block lists every key and forbids invention', () => {
    for (const key of Object.keys(ENTRY_TAG_TAXONOMY)) {
      assert.ok(ENTRY_TAXONOMY_PROMPT_BLOCK.includes(key), `prompt block omits ${key}`);
    }
    assert.match(ENTRY_TAXONOMY_PROMPT_BLOCK, /Do not invent tags/);
  });
});

describe('overlay decider prompt wiring', () => {
  test('the taxonomy actually reaches the system prompt', () => {
    // Guards the silent failure: a broken import interpolates "undefined"
    // into the template and the decider goes back to free text with no error.
    assert.ok(!SYSTEM_PROMPT_FOR_TEST.includes('undefined'));
    for (const key of Object.keys(ENTRY_TAG_TAXONOMY)) {
      assert.ok(SYSTEM_PROMPT_FOR_TEST.includes(key), `system prompt omits entry tag ${key}`);
    }
  });

  test('no longer advertises free-text example tags', () => {
    // The old line ("e.g. atr_resize, h1_momentum_long, ...") is what taught
    // the model to compose novel tags; leaving it in would defeat the list.
    assert.ok(!SYSTEM_PROMPT_FOR_TEST.includes('snake_case label'));
    assert.ok(!SYSTEM_PROMPT_FOR_TEST.includes('h4_h1_macd_contra_veto'));
  });

  test('vetoes are still asked for a tag, so shadows stay comparable', () => {
    assert.match(SYSTEM_PROMPT_FOR_TEST, /VETO or NO_TRADE the tag still records/);
  });
});
