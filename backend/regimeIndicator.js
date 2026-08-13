// regimeIndicator.js — 10-day momentum regime, computed deterministically.
//
// Why this exists: hybrid's forward rulebook is keyed on
// session x ADX x RSI with all-history averages and has no time dimension,
// so it cannot represent a change in market behaviour over time. Across the
// Aug 6-13 flip it produced a direction on 0 of 660 evaluations -- not wrong,
// silent -- and every hybrid trade fell through to the overlay_only branch.
// This module supplies the missing axis.
//
// Deliberately one number and one threshold. On the 53 days of history
// available, +/-3% over 10 days fires three episodes:
//
//   Jul 9      UP   +3.04%            1 day   false — FLAT again next day
//   Jul 17-20  DOWN -4.35% / -3.32%   2 days  false — price then bounced
//                                             3994 -> 4126 within two days
//   Aug 6-13   UP   +4.21% -> +9.46%  6+ days real — same day mechanical
//                                             flipped to 100% long
//
// The threshold alone is therefore NOT clean through July: it produces two
// false episodes for every true one. What separates them is persistence,
// which is why suppression requires `confirmDays` while reporting does not.
// Anything more elaborate would be fitted to a single observed flip.
//
// The model is never asked to judge the regime -- same principle as
// hybridBranchClassifier.js's no-self-labelling rule. It is computed here,
// from daily closes, and handed to the LLM as a fact.
//
// Pure functions only: no I/O, no clock, no randomness. The caller supplies
// the series.

export const REGIME_STATES = ['UP', 'DOWN', 'FLAT', 'UNKNOWN'];

export const REGIME_DEFAULTS = {
  lookbackDays: 10,   // "any news event takes time to flow through the market"
  thresholdPct: 3.0,
  // A state must persist this many consecutive days before it is allowed to
  // SUPPRESS anything. Reporting is unaffected -- the raw state is always
  // shown, and the LLM always sees day 1.
  //
  // On the 53 days available, +/-3% fires three episodes: UP for 1 day
  // (Jul 9, +3.04%, straight back to FLAT), DOWN for 2 days (Jul 17-20,
  // -4.35%/-3.32%, immediately before a bounce from 3994 to 4126), and UP
  // from Aug 6 running 6+ days. Both false episodes died within two days;
  // the real one persisted. Requiring three days removes both without
  // touching the threshold, at the cost of two days' lag on a true signal.
  //
  // This is still fitted -- three episodes is not a sample. It is a weaker
  // form of fitting than tuning the threshold, because it only ever errs
  // toward doing nothing.
  confirmDays: 3,
};

/**
 * Percentage change from `lookbackDays` closes ago to the latest close.
 * Returns null when the series is too short to span the lookback.
 *
 * `closes` must be ascending by date: [{ date: 'YYYY-MM-DD', close: Number }].
 * Index -1 is the most recent bar; the reference bar is `lookbackDays` back,
 * so a 10-day lookback needs 11 bars.
 */
export function momentumPct(closes, lookbackDays = REGIME_DEFAULTS.lookbackDays) {
  if (!Array.isArray(closes) || closes.length < lookbackDays + 1) return null;
  const latest = Number(closes[closes.length - 1]?.close);
  const prior  = Number(closes[closes.length - 1 - lookbackDays]?.close);
  if (!isFinite(latest) || !isFinite(prior) || prior <= 0) return null;
  return (latest / prior - 1) * 100;
}

/** Momentum -> state. A null momentum is UNKNOWN, never silently FLAT. */
export function stateFor(momentum, thresholdPct = REGIME_DEFAULTS.thresholdPct) {
  if (momentum == null || !isFinite(momentum)) return 'UNKNOWN';
  if (momentum >= thresholdPct) return 'UP';
  if (momentum <= -thresholdPct) return 'DOWN';
  return 'FLAT';
}

/**
 * Full regime reading for the end of `closes`.
 *
 * Returns:
 *   state           UP | DOWN | FLAT | UNKNOWN
 *   momentumPct     the raw 10-day change
 *   distancePct     how far past the threshold (0 while FLAT) -- +3.1% and
 *                   +9.5% are both "UP" but are not the same situation
 *   daysInState     consecutive days already in this state, this reading
 *                   included. 1 = it flipped today.
 *   previousState   what it was immediately before, and for how long
 *   asOf            date of the latest close used
 *
 * daysInState is the field that matters most and the one a bare label drops:
 * day 1 of a flip is where false positives live, day 15 is where exhaustion
 * risk starts, and a label collapses both into the same token.
 */
export function computeRegime(closes, cfg = {}) {
  const lookbackDays = cfg.lookbackDays ?? REGIME_DEFAULTS.lookbackDays;
  const thresholdPct = cfg.thresholdPct ?? REGIME_DEFAULTS.thresholdPct;

  const series = Array.isArray(closes) ? closes : [];
  const momentum = momentumPct(series, lookbackDays);
  const state = stateFor(momentum, thresholdPct);

  const base = {
    state,
    momentumPct: momentum,
    thresholdPct,
    lookbackDays,
    distancePct: null,
    daysInState: null,
    previousState: null,
    previousStateDays: null,
    asOf: series.length ? series[series.length - 1].date : null,
    closesAvailable: series.length,
  };

  base.confirmDays = cfg.confirmDays ?? REGIME_DEFAULTS.confirmDays;

  if (state === 'UNKNOWN') {
    base.confirmed = false;
    return base;
  }

  base.distancePct = state === 'FLAT'
    ? 0
    : (state === 'UP' ? momentum - thresholdPct : momentum + thresholdPct);

  // Walk backwards recomputing the state at each earlier bar. Every step
  // needs its own full lookback window, so the walk stops once the series
  // runs out -- daysInState is then a floor ("at least this many"), which
  // callers can detect via truncatedHistory.
  const states = [];
  for (let end = series.length; end >= lookbackDays + 1; end--) {
    const window = series.slice(0, end);
    states.push(stateFor(momentumPct(window, lookbackDays), thresholdPct));
  }

  let run = 0;
  while (run < states.length && states[run] === state) run++;
  base.daysInState = run;
  base.truncatedHistory = run === states.length;
  // FLAT is never "confirmed" -- there is nothing to confirm, and it
  // suppresses nothing either way.
  base.confirmed = state !== 'FLAT' && run >= base.confirmDays;

  const prevIdx = run;
  if (prevIdx < states.length) {
    base.previousState = states[prevIdx];
    let prevRun = 0;
    while (prevIdx + prevRun < states.length && states[prevIdx + prevRun] === base.previousState) prevRun++;
    base.previousStateDays = prevRun;
  }

  return base;
}

/**
 * Is `direction` fighting the regime?
 *
 * Used as a hard gate in code rather than as prompt guidance: a rule written
 * into a system prompt is a suggestion, and a long enough reasoning chain
 * argues its way past it. FLAT and UNKNOWN never block anything -- absence of
 * a regime is not evidence for one.
 */
export function isCounterRegime(direction, regime) {
  if (!direction || !regime) return false;
  // Only a CONFIRMED regime suppresses. A one- or two-day reading is exactly
  // the shape both of the observed false positives took, and suppression is
  // the one irreversible thing this indicator does -- it silently removes a
  // signal the rest of the system never gets to weigh.
  if (!regime.confirmed) return false;
  if (regime.state === 'UP')   return direction === 'SHORT';
  if (regime.state === 'DOWN') return direction === 'LONG';
  return false;
}

/**
 * The regime as the LLM should receive it: the number, its age, and its
 * distance past the threshold -- not a bare label it would anchor on and
 * then rationalise toward.
 */
export function formatRegimeForPrompt(regime) {
  if (!regime || regime.state === 'UNKNOWN') {
    return [
      'REGIME (10-day momentum): UNKNOWN — insufficient daily closes.',
      'Treat this as no information. Do not infer a regime from the price action in this prompt.',
    ].join('\n');
  }

  const sign = regime.momentumPct >= 0 ? '+' : '';
  const lines = [
    'REGIME (deterministic, computed from daily closes — not your judgement):',
    `  ${regime.lookbackDays}-day momentum : ${sign}${regime.momentumPct.toFixed(2)}%`,
    `  threshold           : ±${regime.thresholdPct.toFixed(1)}%`,
    `  state               : ${regime.state}`,
    `  days in this state  : ${regime.daysInState}${regime.truncatedHistory ? '+ (history truncated)' : ''}`,
    `  confirmed           : ${regime.confirmed ? 'yes' : `no (needs ${regime.confirmDays} days)`}`,
  ];
  if (regime.state !== 'FLAT') {
    lines.push(`  past threshold by   : ${regime.distancePct >= 0 ? '+' : ''}${regime.distancePct.toFixed(2)}%`);
  }
  if (regime.previousState) {
    lines.push(`  previous state      : ${regime.previousState} for ${regime.previousStateDays} day(s)`);
  }

  lines.push(
    '',
    'How to use this. It informs SIZE and STOP WIDTH, not direction — direction',
    'is already decided upstream. Counter-regime trades are blocked in code before',
    'you see them, so you never need to argue about that.',
    '  - Confirmed regime (days in state >= 3): pullbacks are more likely noise than',
    '    reversal. Favour the wider end of the ATR stop band and holding the position.',
    '  - Fresh flip (days in state <= 2): the signal may be a false positive. Reduce',
    '    size rather than changing direction.',
    '  - FLAT: no trend edge. Favour tighter stops, smaller size, quicker exits.',
  );

  return lines.join('\n');
}
