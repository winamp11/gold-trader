// exitReasons.js — the one definition of what a trade's exit_reason can be,
// and which of those count as "forced".
//
// Previously CIRCUIT_BREAKER was written by four unrelated causes, because
// forceClosePortfolio() hardcoded it regardless of why it was called:
//
//   - hybrid give-back series banking (routine profit-taking; the bot
//     explicitly KEEPS TRADING afterwards)
//   - hybrid daily max-loss flatten
//   - hybrid daily-target flatten
//   - the real -10% circuit breaker
//   - the prop_sim trailing hard halt
//
// On claude_hybrid that made 53 of 94 exits read as CIRCUIT_BREAKER, so any
// question of the form "how often does the breaker actually fire" had no
// answerable form. The causes are now distinct reasons.
//
// The set of reasons that mean "the rule closed this, not the trade's own
// stop or target" was also duplicated across five files as an inline
// three-way string comparison, so adding a reason meant finding every copy.
// It lives here instead.

export const EXIT_REASONS = {
  // Strategy exits: the trade's own geometry resolved it.
  TARGET_HIT: 'TARGET_HIT',
  STOP_HIT: 'STOP_HIT',

  // Forced exits: a rule closed the position early.
  WINDOW_CLOSE: 'WINDOW_CLOSE',
  MANAGED_CLOSE: 'MANAGED_CLOSE',
  CIRCUIT_BREAKER: 'CIRCUIT_BREAKER',
  GIVE_BACK: 'GIVE_BACK',
  DAILY_MAX_LOSS: 'DAILY_MAX_LOSS',
  DAILY_TARGET: 'DAILY_TARGET',
  PROP_HARD_HALT: 'PROP_HARD_HALT',

  // Never filled — no P&L, and must never reach a win-rate denominator.
  NO_ENTRY: 'NO_ENTRY',
};

// Order matters only for readability; membership is what callers use.
export const FORCED_EXIT_REASONS = [
  EXIT_REASONS.WINDOW_CLOSE,
  EXIT_REASONS.MANAGED_CLOSE,
  EXIT_REASONS.CIRCUIT_BREAKER,
  EXIT_REASONS.GIVE_BACK,
  EXIT_REASONS.DAILY_MAX_LOSS,
  EXIT_REASONS.DAILY_TARGET,
  EXIT_REASONS.PROP_HARD_HALT,
];

const FORCED = new Set(FORCED_EXIT_REASONS);

/** A rule closed this position early, rather than its own stop/target. */
export function isForcedExit(reason) {
  return FORCED.has(reason);
}

/** The position was filled and therefore has a realized P&L. */
export function isRealizedExit(reason) {
  return reason === EXIT_REASONS.TARGET_HIT
    || reason === EXIT_REASONS.STOP_HIT
    || FORCED.has(reason);
}

/**
 * Forced reasons as a SQL literal list, e.g. `'WINDOW_CLOSE','GIVE_BACK'`.
 * Values are compile-time constants from this file, never user input.
 */
export const FORCED_EXIT_REASONS_SQL = FORCED_EXIT_REASONS
  .map(r => `'${r}'`)
  .join(', ');
