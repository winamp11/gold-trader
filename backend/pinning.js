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

import { COSTLY_VETO_TAGS } from './tagTaxonomy.js';

// True when a (tag, entry_type) pair represents an outcome that cost money.
export function isCostly(entryType, tag) {
  if (entryType === 'loss') return true;
  if (entryType === 'veto') return COSTLY_VETO_TAGS.has(tag);
  return false;
}

// history: rows of { tag, entry_type, count } — one row per (tag, entry_type),
// as returned by getTagFullHistory.
//
// Returns [{ tag, costlyCount, totalCount }] for tags at or above minCount,
// most costly first. Ties break on tag name so the ordering is deterministic
// and the pin cap doesn't silently churn between equal candidates.
export function selectPinnableTags(history, minCount = 2) {
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
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([tag, costlyCount]) => ({
      tag,
      costlyCount,
      totalCount: total[tag] ?? costlyCount,
    }));
}
