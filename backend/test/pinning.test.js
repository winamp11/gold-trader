// Pin selection.
//
// Pins are the only journal entries fed back into the decider's prompt, so
// what qualifies here determines what overlay can actually remember. The bug
// this fixes: eligibility required entry_type = 'loss', while veto entries are
// typed 'veto', so all 1,641 veto counterfactuals were permanently unpinnable
// despite carrying the cleanest right/wrong verdicts in the journal.
//
// The failure modes pinned below are the ones that would restore that silence
// or overcorrect into its mirror image:
//   1. Vetoes excluded again (regression to loss-only).
//   2. Vetoes included indiscriminately — pinning "I vetoed and was right" as
//      though it were a mistake, which teaches the opposite of the lesson.
//   3. Counts assigned rather than accumulated, so a tag qualifying through
//      both a loss and a veto reports only one of them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { selectPinnableTags, isCostly } from '../pinning.js';
import { COSTLY_VETO_TAGS, TAG_TAXONOMY } from '../tagTaxonomy.js';

describe('costly veto tag set', () => {
  test('every member is a real taxonomy tag', () => {
    // Guards a silent emptying: rename a tag in TAG_TAXONOMY without updating
    // this set and vetoes quietly stop pinning again, with nothing failing.
    for (const tag of COSTLY_VETO_TAGS) {
      assert.ok(tag in TAG_TAXONOMY, `${tag} is not in TAG_TAXONOMY`);
    }
  });

  test('excludes the correct-veto tags', () => {
    // These describe vetoes that WORKED. Pinning them would remind overlay of
    // its successes as if they were errors.
    assert.ok(!COSTLY_VETO_TAGS.has('veto_correct_outcome_avoided'));
    assert.ok(!COSTLY_VETO_TAGS.has('rsi_extreme_veto_correct'));
    assert.ok(!COSTLY_VETO_TAGS.has('veto_correct_outcome_avoided'));
  });
});

describe('isCostly', () => {
  test('a losing trade is costly regardless of tag', () => {
    assert.equal(isCostly('loss', 'anything_at_all'), true);
  });

  test('a veto is costly only when it gave up a winner', () => {
    assert.equal(isCostly('veto', 'veto_missed_winner'), true);
    assert.equal(isCostly('veto', 'rsi_extreme_veto_missed'), true);
    assert.equal(isCostly('veto', 'veto_correct_outcome_avoided'), false);
    assert.equal(isCostly('veto', 'rsi_extreme_veto_correct'), false);
  });

  test('wins are never costly', () => {
    assert.equal(isCostly('win', 'atr_resize_win'), false);
  });
});

describe('selectPinnableTags', () => {
  test('vetoes that gave up winners now qualify', () => {
    // The regression this whole change exists to prevent.
    const out = selectPinnableTags([
      { tag: 'veto_missed_winner', entry_type: 'veto', count: 19 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tag, 'veto_missed_winner');
    assert.equal(out[0].costlyCount, 19);
  });

  test('correct vetoes never qualify, however many there are', () => {
    // 74 correct vetoes is the single most common entry in overlay's journal.
    // If the predicate is loosened to entry_type === 'veto', this tag floods
    // the 3-slot pin cap with non-mistakes.
    const out = selectPinnableTags([
      { tag: 'veto_correct_outcome_avoided', entry_type: 'veto', count: 74 },
    ]);
    assert.deepEqual(out, []);
  });

  test('losses and costly vetoes on one tag are summed, not overwritten', () => {
    // The original code did lossCounts[tag] = cnt (assignment). With two
    // contributing entry_types that silently discards one of them.
    const out = selectPinnableTags([
      { tag: 'veto_missed_winner', entry_type: 'veto', count: 5 },
      { tag: 'veto_missed_winner', entry_type: 'loss', count: 3 },
    ]);
    assert.equal(out[0].costlyCount, 8);
  });

  test('totalCount includes non-costly entries for the same tag', () => {
    const out = selectPinnableTags([
      { tag: 'stop_hunt', entry_type: 'loss', count: 3 },
      { tag: 'stop_hunt', entry_type: 'win',  count: 7 },
    ]);
    assert.equal(out[0].costlyCount, 3);
    assert.equal(out[0].totalCount, 10);
  });

  test('still requires recurrence — a single costly outcome does not pin', () => {
    const out = selectPinnableTags([
      { tag: 'stop_hunt',           entry_type: 'loss', count: 1 },
      { tag: 'veto_missed_winner',  entry_type: 'veto', count: 1 },
    ]);
    assert.deepEqual(out, []);
  });

  test('orders by costly count descending, ties broken deterministically', () => {
    // Non-deterministic ordering would churn the 3-pin cap between equal
    // candidates on every cycle.
    const rows = [
      { tag: 'b_tag',     entry_type: 'loss', count: 4 },
      { tag: 'a_tag',     entry_type: 'loss', count: 4 },
      { tag: 'big_tag',   entry_type: 'loss', count: 9 },
    ];
    const first  = selectPinnableTags(rows).map(r => r.tag);
    const second = selectPinnableTags([...rows].reverse()).map(r => r.tag);
    assert.deepEqual(first, ['big_tag', 'a_tag', 'b_tag']);
    assert.deepEqual(first, second);
  });

  test('tolerates malformed history rows', () => {
    // getTagFullHistory returns COUNT(*) as a string, and a null tag is
    // possible in the table. Neither should throw or produce a NaN count.
    const out = selectPinnableTags([
      null,
      { tag: null,      entry_type: 'loss', count: 5 },
      { tag: 'ok_tag',  entry_type: 'loss', count: '4' },
      { tag: 'bad_num', entry_type: 'loss', count: 'not-a-number' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tag, 'ok_tag');
    assert.equal(out[0].costlyCount, 4);
  });

  test('empty and missing history are handled', () => {
    assert.deepEqual(selectPinnableTags([]), []);
    assert.deepEqual(selectPinnableTags(undefined), []);
  });
});
