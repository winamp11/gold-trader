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

import { selectPinnableTags, isCostly, reconcilePins } from '../pinning.js';
import { COSTLY_VETO_TAGS, ARTIFACT_TAGS, TAG_TAXONOMY } from '../tagTaxonomy.js';

describe('artifact tags', () => {
  test('every member is a real taxonomy tag', () => {
    for (const tag of ARTIFACT_TAGS) {
      assert.ok(tag in TAG_TAXONOMY, `${tag} is not in TAG_TAXONOMY`);
    }
  });

  test('window_close_exit is treated as an artifact', () => {
    // Its own taxonomy entry says "artifact, exclude from expectancy", yet it
    // was written with entry_type 'loss' and had pinned 34 times, occupying a
    // slot with a lesson that has nothing to teach.
    assert.ok(ARTIFACT_TAGS.has('window_close_exit'));
    assert.match(TAG_TAXONOMY.window_close_exit, /artifact/i);
  });

  test('artifacts are never costly, even typed as a loss', () => {
    assert.equal(isCostly('loss', 'window_close_exit'), false);
    assert.equal(isCostly('loss', 'expired_no_fill'), false);
  });

  test('artifacts cannot pin however often they recur', () => {
    const out = selectPinnableTags(
      [{ tag: 'window_close_exit', entry_type: 'loss', count: 34 }],
      { window_close_exit: 50000 },
    );
    assert.deepEqual(out, []);
  });
});

describe('damage-based ranking', () => {
  const history = [
    { tag: 'frequent_scratch', entry_type: 'loss', count: 20 },
    { tag: 'rare_disaster',    entry_type: 'loss', count: 3  },
  ];

  test('a costly rare mistake outranks a cheap frequent one', () => {
    // The whole point of the change: counting treats a -80 scratch and a
    // -2,400 stop-out identically, and with three slots the cheap frequent
    // mistakes crowd out the expensive ones.
    const out = selectPinnableTags(history, { frequent_scratch: 1600, rare_disaster: 7200 });
    assert.deepEqual(out.map(r => r.tag), ['rare_disaster', 'frequent_scratch']);
  });

  test('count alone would have ranked them the other way', () => {
    // Pins the regression: if damage is ignored, this flips.
    const out = selectPinnableTags(history, {});
    assert.deepEqual(out.map(r => r.tag), ['frequent_scratch', 'rare_disaster']);
  });

  test('falls back to count when no damage joins, not to arbitrary order', () => {
    // Damage comes from a join that can miss rows entirely. Degrading to the
    // previous count behaviour is acceptable; degrading to alphabetical is not.
    const out = selectPinnableTags(history, { unrelated_tag: 999 });
    assert.deepEqual(out.map(r => r.tag), ['frequent_scratch', 'rare_disaster']);
    assert.equal(out[0].damageKnown, false);
  });

  test('reports damage and flags whether it is known', () => {
    const out = selectPinnableTags(history, { rare_disaster: 7200.456 });
    const byTag = Object.fromEntries(out.map(r => [r.tag, r]));
    assert.equal(byTag.rare_disaster.damageUsd, 7200.46);
    assert.equal(byTag.rare_disaster.damageKnown, true);
    assert.equal(byTag.frequent_scratch.damageUsd, 0);
    assert.equal(byTag.frequent_scratch.damageKnown, false);
  });

  test('malformed damage values do not corrupt the ordering', () => {
    // A NaN leaking into the sort key makes the comparator inconsistent and
    // the resulting order unspecified.
    const out = selectPinnableTags(history, { frequent_scratch: 'oops', rare_disaster: null });
    assert.deepEqual(out.map(r => r.tag), ['frequent_scratch', 'rare_disaster']);
    assert.ok(out.every(r => Number.isFinite(r.damageUsd)));
  });
});

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

describe('reconcilePins', () => {
  // The production bug this replaces: pins were reconciled incrementally, with
  // the cap enforced immediately before each insert. Whichever tag was
  // processed last always won a slot regardless of rank, so a 2-occurrence
  // lesson displaced a 34-occurrence one.

  test('a lower-ranked tag cannot displace a higher-ranked one', () => {
    // Exactly the observed failure, replayed. Both tags are already pinned and
    // both are still wanted, so nothing should move at all.
    const active = [
      { id: 1, tag: 'window_close_exit',       journal_id: 100 },
      { id: 2, tag: 'rsi_exhaustion_fade_loss', journal_id: 200 },
    ];
    const desired = [
      { tag: 'window_close_exit',        journalId: 100 },
      { tag: 'rsi_exhaustion_fade_loss', journalId: 200 },
    ];
    const { deactivateIds, insert } = reconcilePins(active, desired);
    assert.deepEqual(deactivateIds, []);
    assert.deepEqual(insert, []);
  });

  test('is idempotent — a second run with unchanged inputs writes nothing', () => {
    // The old loop re-inserted on every cycle, which is why the table holds a
    // dozen near-identical stop_hunt pins.
    const desired = [{ tag: 'stop_hunt', journalId: 900 }];
    const first = reconcilePins([], desired);
    assert.equal(first.insert.length, 1);

    const nowActive = [{ id: 7, tag: 'stop_hunt', journal_id: 900 }];
    const second = reconcilePins(nowActive, desired);
    assert.deepEqual(second.deactivateIds, []);
    assert.deepEqual(second.insert, []);
  });

  test('retires a pin whose tag dropped out of the target set', () => {
    const active  = [{ id: 5, tag: 'demoted_tag', journal_id: 11 }];
    const desired = [{ tag: 'promoted_tag', journalId: 22 }];
    const { deactivateIds, insert } = reconcilePins(active, desired);
    assert.deepEqual(deactivateIds, [5]);
    assert.deepEqual(insert.map(i => i.tag), ['promoted_tag']);
  });

  test('refreshes a still-wanted tag when a newer lesson supersedes it', () => {
    const active  = [{ id: 5, tag: 'stop_hunt', journal_id: 11 }];
    const desired = [{ tag: 'stop_hunt', journalId: 99 }];
    const { deactivateIds, insert } = reconcilePins(active, desired);
    assert.deepEqual(deactivateIds, [5]);
    assert.deepEqual(insert.map(i => i.journalId), [99]);
  });

  test('clears every pin when nothing qualifies any more', () => {
    const active = [
      { id: 1, tag: 'a', journal_id: 1 },
      { id: 2, tag: 'b', journal_id: 2 },
    ];
    const { deactivateIds, insert } = reconcilePins(active, []);
    assert.deepEqual(deactivateIds, [1, 2]);
    assert.deepEqual(insert, []);
  });

  test('handles empty and missing inputs', () => {
    assert.deepEqual(reconcilePins([], []), { deactivateIds: [], insert: [] });
    assert.deepEqual(reconcilePins(undefined, undefined), { deactivateIds: [], insert: [] });
  });
});
