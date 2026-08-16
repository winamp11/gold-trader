// regimeIndicator.js — 10-day momentum regime, computed deterministically.
//
// Why this exists: hybrid's forward rulebook is keyed on
// session x ADX x RSI with all-history averages and has no time dimension,
// so it cannot represent a change in market behaviour over time. Across the
// Aug 6-13 flip it produced a direction on 0 of 660 evaluations -- not wrong,
// silent -- and every hybrid trade fell through to the overlay_only branch.
// This module supplies the missing axis.
//
// WHAT THIS IS NOW: a LABEL, not a predictor. It answers "what had the market
// done over the last 10 trading days" -- a fact about the past, useful for
// knowing which conditions an observation was collected under. It does not
// forecast, and nothing in the pipeline acts on it.
//
// VALIDATED AND FAILED, 2026-08-16. The parameters below were originally
// chosen by eye from 53 days (2026-06 to 2026-08). Tested afterwards on two
// years of daily closes -- 527 rows, 467 of them out-of-sample, 21 confirmed
// episodes -- a confirmed regime carried no forward information:
//
//   mean forward return vs the unconditional base rate, out-of-sample
//     confirmed UP :  +0.08% at 5d,  -0.37% at 10d,  +0.52% at 20d
//
// The sign flips with the horizon. Confirmed DOWN had only 5 episodes, so it
// is untested rather than disproven. Counter-regime suppression was removed
// from server.js as a result.
//
// Two things the same study showed about the fitting window itself: it
// produced regime episodes at roughly twice the out-of-sample rate, and its
// gold/EUR-USD correlation ran 0.799 against a 0.335 two-year norm. The
// parameters were fitted to an unusual stretch of market, which is the
// likeliest reason they did not generalise. Treat any future parameter
// chosen from a short recent window with the same suspicion.
//
// Still worth keeping: this is how EUR/strong/bullish was caught holding 151
// observations drawn from three days entirely inside one rally. Provenance is
// a real use; prediction is not.
//
// The model is never asked to judge the regime -- same principle as
// hybridBranchClassifier.js's no-self-labelling rule. It is computed here,
// from daily closes, and handed to the LLM as descriptive context.
//
// Pure functions only: no I/O, no clock, no randomness. The caller supplies
// the series.

export const REGIME_STATES = ['UP', 'DOWN', 'FLAT', 'UNKNOWN'];

export const REGIME_DEFAULTS = {
  lookbackDays: 10,   // "any news event takes time to flow through the market"
  thresholdPct: 3.0,
  // Consecutive days a directional state must hold before `confirmed` is set.
  // Nothing acts on `confirmed` any more -- it is reported, not enforced --
  // so this now only affects what the dashboard and the prompt describe.
  //
  // Out-of-sample it removes a lot: 56% of directional episodes lasted two
  // days or fewer and never reached confirmation. That makes it a reasonable
  // description of "persistent", but persistence turned out not to predict
  // anything, so do not mistake the filtering for an edge.
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
 * NOT WIRED TO ANYTHING as of 2026-08-16. It was hybrid's counter-regime gate
 * until out-of-sample testing showed a confirmed regime carries no forward
 * information (see the header). Kept, with its tests, because the decision is
 * reversible and the implementation is correct for what it does.
 *
 * Do not re-wire it on the strength of a good week. The sample unit is
 * confirmed EPISODES, not days or trades: two years produced 16 UP and 5 DOWN.
 * Restoring this needs a fresh out-of-sample test on a materially larger
 * episode count, not a fresh opinion.
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
    'This is CONTEXT, not an instruction. It describes what the market has',
    'already done over the last 10 trading days. It does not predict what',
    'happens next, and you should not treat it as though it does.',
    '',
    'Tested on two years of daily closes: after a confirmed regime, forward',
    'returns beat the unconditional base rate by +0.08%, -0.37% and +0.52% at',
    '5, 10 and 20 days — a sign that flips with the horizon, on 21 episodes.',
    'There is no measured edge here. Earlier versions of this block told you to',
    'widen stops in a confirmed regime; that advice was removed because nothing',
    'supports it.',
    '',
    'Weigh it as one descriptive input among the others, or ignore it.',
  );

  return lines.join('\n');
}
