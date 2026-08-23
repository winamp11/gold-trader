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

describe('overlay veto-history claim', () => {
  // The prompt previously told overlay that "vetoes have missed more winners
  // than they avoided losers". Measured across all 1,069 resolved veto
  // counterfactuals that is false on both axes: 519 would-be winners vs 550
  // would-be losers (a coin flip, not a deficit), and +85,356 net in favour
  // of vetoing once WINDOW_CLOSE artifacts are excluded. The claim was
  // suppressing a behaviour that pays, so these tests pin it out.

  test('does not reassert the disproven claim', () => {
    assert.ok(
      !/missed more\s+winners than they avoided losers/.test(SYSTEM_PROMPT_FOR_TEST),
      'the disproven veto claim is back in the prompt',
    );
  });

  test('states the measured counts and dollars, and dates them', () => {
    // Figures without a date silently rot as more shadows resolve.
    assert.match(SYSTEM_PROMPT_FOR_TEST, /1,069 resolved shadows/);
    assert.match(SYSTEM_PROMPT_FOR_TEST, /519 .*would have won/);
    assert.match(SYSTEM_PROMPT_FOR_TEST, /550 would\s+have lost/);
    assert.match(SYSTEM_PROMPT_FOR_TEST, /\+85,356/);
    assert.match(SYSTEM_PROMPT_FOR_TEST, /as of 2026-08-23/);
  });

  test('attributes the edge to loss size, not to veto selection skill', () => {
    // The mechanism matters: overlay's veto win rate is 48.5%, so telling it
    // it can pick losers would invite more marginal vetoes, each ~EV 0.
    assert.match(SYSTEM_PROMPT_FOR_TEST, /NOT from picking which trades would fail/);
  });

  test('keeps veto reserved for genuine direction disagreement', () => {
    // The corrected figures must not read as blanket encouragement to veto.
    assert.match(SYSTEM_PROMPT_FOR_TEST, /marginal veto has close to zero expected value/);
    assert.match(SYSTEM_PROMPT_FOR_TEST, /Veto is reserved for disagreeing with the DIRECTION/);
  });
});
