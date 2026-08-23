// Pin selection — which journal tags are recurring enough mistakes to be
// pinned into the decider's prompt.
//
// Extracted from database.updatePinnedLessons so the selection rule is
// testable without a database. The DB function keeps the write side (which
// journal row to pin, cap enforcement, deactivation).
//
// Why vetoes count here: pinning previously required entry_type = 'loss'.
// Veto entries are typed 'veto', so every counterfactual was permanently
// ineligible — on overlay that is the large majority of the journal, and it
// is the highest-signal part of it, because a counterfactual carries a clean
// right/wrong verdict that a taken trade does not.
//
// Only COSTLY vetoes count. A veto that correctly avoided a loss is not a
// mistake and must not be pinned as one. This mirrors the existing asymmetry
// on the trade side, where losses pin and wins do not: pins are a
// mistake-reminder channel, not a balanced performance summary.
//
// Ranking is by DOLLARS LOST, not by number of occurrences. Counting treats a
// -80 scratch and a -2,400 stop-out as the same lesson, and with only three
// pin slots the cheap-but-frequent mistakes crowd out the expensive ones.

import { COSTLY_VETO_TAGS, ARTIFACT_TAGS } from './tagTaxonomy.js';

// True when a (tag, entry_type) pair represents an outcome that cost money.
// Artifact tags are never costly however they are typed: window_close_exit
// entries are written with entry_type 'loss', but the position was ended by
// the trading window, not by the thesis failing.
export function isCostly(entryType, tag) {
  if (ARTIFACT_TAGS.has(tag)) return false;
  if (entryType === 'loss') return true;
  if (entryType === 'veto') return COSTLY_VETO_TAGS.has(tag);
  return false;
}

// history:   rows of { tag, entry_type, count } from getTagFullHistory.
// damageMap: { [tag]: usd } from getTagDamage — dollars lost by that tag.
//
// Counts come from history and damage from damageMap deliberately: the damage
// query joins journal to trades/veto_shadows, so journal rows with a null or
// unmatched signal_or_trade_id drop out of it. Taking counts from the complete
// history keeps such tags eligible instead of silently erasing them.
//
// Returns [{ tag, costlyCount, totalCount, damageUsd, damageKnown }] for tags
// at or above minCount, most damaging first.
export function selectPinnableTags(history, damageMap = {}, minCount = 2) {
  const costly = {};
  const total  = {};

  for (const row of history ?? []) {
    if (!row || row.tag == null) continue;
    const n = parseInt(row.count, 10);
    if (!Number.isFinite(n) || n <= 0) continue;

    total[row.tag] = (total[row.tag] ?? 0) + n;
    // Accumulate rather than assign: a tag can now qualify through more than
    // one entry_type ('loss' and 'veto'), where before only 'loss' counted.
    if (isCostly(row.entry_type, row.tag)) {
      costly[row.tag] = (costly[row.tag] ?? 0) + n;
    }
  }

  return Object.entries(costly)
    .filter(([, n]) => n >= minCount)
    .map(([tag, costlyCount]) => {
      const raw = damageMap?.[tag];
      const damage = Number(raw);
      const damageKnown = Number.isFinite(damage) && damage > 0;
      return {
        tag,
        costlyCount,
        totalCount: total[tag] ?? costlyCount,
        damageUsd: damageKnown ? Math.round(damage * 100) / 100 : 0,
        damageKnown,
      };
    })
    // Damage first. Count is the secondary key, not merely a tie-break: when
    // no damage is joinable at all the ranking degrades to the old count
    // behaviour rather than to an arbitrary order. Tag name last, so the
    // result is deterministic and the pin cap does not churn between equals.
    .sort((a, b) =>
      (b.damageUsd - a.damageUsd) ||
      (b.costlyCount - a.costlyCount) ||
      a.tag.localeCompare(b.tag));
}

// Decides how the active pin set should change, given what is currently
// pinned and what the ranking says should be pinned.
//
// This replaces an incremental loop that deactivated the lowest-count ACTIVE
// pin immediately before each insert. Because the check ran per-insert rather
// than against the final target, whichever tag was processed last always won
// a slot regardless of rank — in production a 2-occurrence lesson displaced a
// 34-occurrence one. Deciding the whole set at once makes the outcome depend
// on rank alone and makes the operation idempotent: running it twice with
// unchanged inputs produces no writes the second time.
//
// active:  [{ id, tag, journal_id }]  — currently active pins
// desired: [{ tag, journalId, ... }]  — already ranked and capped
export function reconcilePins(active, desired) {
  const wanted = new Map((desired ?? []).map(d => [d.tag, d]));
  const deactivateIds = [];

  for (const row of active ?? []) {
    const want = wanted.get(row.tag);
    // Already pinned to the right journal row — leave it alone, and drop it
    // from the insert set so an unchanged pin is not rewritten every cycle.
    if (want && want.journalId === row.journal_id) {
      wanted.delete(row.tag);
      continue;
    }
    // Either no longer wanted, or superseded by a newer lesson on the same tag.
    deactivateIds.push(row.id);
  }

  return { deactivateIds, insert: [...wanted.values()] };
}
