// dayRegime.js — a PATH-based regime reading, computed day by day.
//
// Distinct from regimeIndicator.js, which compares today's close to the close
// 10 trading days ago. That is a two-point measure: the shape in between is
// invisible, consecutive readings overlap by nine days, and a reading can fall
// on a day price rose because the reference bar rolled forward. It answers
// "where is price versus a fortnight ago", not "is the trend still intact".
//
// This module answers the other question. Each day is classified on its OWN
// move, runs of same-direction days are tracked, and a run is allowed to
// ERODE -- the pattern being modelled is UP UP UP, FLAT, FLAT, slight DOWN,
// DOWN DOWN, where conviction drains before the reversal is visible in any
// two-week average.
//
// TESTED AND FAILED FOR PREDICTION, 2026-08-22. Parameters were preregistered
// (0.5% fixed and 0.5x-ATR variants, confirmDays 3, flatErosion 0.5,
// counterErosion 1.0) and then run against two years of UAE daily closes,
// Aug 2024 - Aug 2026, with 2026 held out.
//
//   confirmed UP, forward return minus the unconditional base rate:
//     fixed 0.5%, 2 years (22 episodes) : -0.04% / -0.18% / -0.47% at 1/3/5d
//     ATR-norm, 2 years  (16 episodes)  : +0.03% / +0.07% / +0.10%
//     fixed 0.5%, 2026 holdout (2 eps)  : +0.08% / +0.11% / -0.11%
//
// UP has a usable episode count and shows nothing: lifts are inside a few
// tenths of a percent and the sign flips between variants and horizons.
//
// Confirmed DOWN shows positive lifts (+0.6% to +2.7%), but on 6-7 episodes
// across the whole sample -- and a POSITIVE lift after a DOWN regime means
// price rose, i.e. a bounce, not a reason to be short. Untested rather than
// disproven, exactly like regimeIndicator's DOWN side.
//
// Note also the base-rate asymmetry: over a two-year gold uptrend the ATR
// variant marked 281 days UP and 7 DOWN. An indicator that is almost always
// UP is largely restating that gold rose.
//
// WHAT IT IS STILL GOOD FOR: describing the path. It answers "is this run
// intact, stalling, or broken" and flags a turn on the day it happens, which
// the 10-day two-point measure structurally cannot. That is a real difference
// and a legitimate label. It is not a forecast.
//
// Nothing here is wired to a decision. Do not wire it on the strength of the
// DOWN numbers -- six episodes is the same evidence base that produced the
// counter-regime gate we removed on 2026-08-16.
//
// Threshold note: gold's median daily move over 2024-2026 was 0.54%, so the
// ±3% used by the 10-day indicator marks 97% of days flat and is useless per
// day. Sensible fixed thresholds sit near 0.5-0.75%. ATR-normalising is
// preferred -- a 0.6% day means one thing in a calm month and another in a
// violent one.
//
// Pure functions only: no I/O, no clock, no randomness.

export const DAY_STATES = ['UP', 'FLAT', 'DOWN'];

export const DAY_REGIME_DEFAULTS = {
  // Fixed percentage move that counts as directional for one day.
  thresholdPct: 0.5,
  // Alternative: classify against recent daily volatility instead of a fixed
  // percentage. When atrPeriod is set, a day is directional if |move| exceeds
  // thresholdAtr * (mean absolute move over the previous atrPeriod days).
  atrPeriod: null,
  thresholdAtr: 0.5,
  // Directional days needed before the run is called a regime.
  confirmDays: 3,
  // How much a non-confirming day drains from the run. A FLAT day is a pause,
  // a counter day is a contradiction, so they are not weighted the same --
  // this asymmetry is the whole point of the model.
  flatErosion: 0.5,
  counterErosion: 1.0,
};

/**
 * Classify one day's move.
 * `ref` is the threshold in the same units as `movePct` (percent), already
 * resolved by the caller so this stays a pure comparison.
 */
export function classifyDay(movePct, ref) {
  if (movePct == null || !isFinite(movePct) || !isFinite(ref) || ref <= 0) return null;
  if (movePct >  ref) return 'UP';
  if (movePct < -ref) return 'DOWN';
  return 'FLAT';
}

/**
 * Walk a series of daily closes and produce, for each day, the run state.
 *
 * `closes`: ascending [{ date, close }].
 *
 * Returns one entry per day (from the second day onward, since day one has no
 * move) with:
 *   date, close, movePct, day        the day itself
 *   direction                        run direction: UP | DOWN | null
 *   score                            run strength; regime is confirmed at >= confirmDays
 *   confirmed                        score >= confirmDays
 *   regime                           direction when confirmed, else 'FLAT'
 *   runDays                          directional days contributing to this run
 *   flatDays, counterDays            non-confirming days absorbed by this run
 *   eroding                          true when the last day drained the score
 *
 * The score model: a day in the run's direction adds 1, a FLAT day subtracts
 * flatErosion. That is what lets a run decay through a stall rather than
 * resetting on the first non-trending day -- a plain consecutive-day counter
 * would call UP UP UP FLAT UP a fresh one-day run, losing four days of
 * context.
 *
 * A counter day is handled by whether the run is still CONFIRMED:
 *
 *   confirmed run   -> erode by counterErosion, keep the direction. An
 *                      established trend should not invert on one red day.
 *   unconfirmed run -> flip immediately, new direction at score 1. The run
 *                      was already stalling, so the counter day is the start
 *                      of the new move rather than noise inside the old one.
 *
 * The alternative -- always erode, flip only when the score crosses zero --
 * was tried first and rejected: after a confirmed 3-day rally it took five
 * counter days to confirm a reversal, because the old run's credit had to be
 * spent before the new one could build. That reintroduces exactly the
 * late-flip problem this module exists to avoid.
 */
export function computeDayRegime(closes, cfg = {}) {
  const c = { ...DAY_REGIME_DEFAULTS, ...cfg };
  const series = Array.isArray(closes) ? closes : [];
  const out = [];

  let direction = null, score = 0, runDays = 0, flatDays = 0, counterDays = 0;

  for (let i = 1; i < series.length; i++) {
    const prev = Number(series[i - 1]?.close);
    const cur  = Number(series[i]?.close);
    if (!isFinite(prev) || !isFinite(cur) || prev <= 0) continue;
    const movePct = (cur / prev - 1) * 100;

    // Resolve the threshold for THIS day. ATR mode looks only at days strictly
    // before i, so the day being classified never influences its own bar.
    let ref = c.thresholdPct;
    if (c.atrPeriod) {
      const win = [];
      for (let j = Math.max(1, i - c.atrPeriod); j < i; j++) {
        const a = Number(series[j - 1]?.close), b = Number(series[j]?.close);
        if (isFinite(a) && isFinite(b) && a > 0) win.push(Math.abs((b / a - 1) * 100));
      }
      if (win.length < Math.min(c.atrPeriod, 5)) { continue; }  // not enough history yet
      ref = c.thresholdAtr * (win.reduce((s, v) => s + v, 0) / win.length);
    }

    const day = classifyDay(movePct, ref);
    if (day == null) continue;

    let eroding = false;
    if (direction == null) {
      if (day !== 'FLAT') { direction = day; score = 1; runDays = 1; flatDays = 0; counterDays = 0; }
    } else if (day === direction) {
      score += 1; runDays += 1;
    } else if (day === 'FLAT') {
      score -= c.flatErosion; flatDays += 1; eroding = true;
      if (score <= 0) { direction = null; score = 0; runDays = 0; flatDays = 0; counterDays = 0; }
    } else if (score >= c.confirmDays) {
      // Established trend: absorb the counter day, keep the direction.
      score -= c.counterErosion; counterDays += 1; eroding = true;
    } else {
      // Already stalling: this is the new move starting, not noise.
      direction = day; score = 1; runDays = 1; flatDays = 0; counterDays = 0;
    }

    const confirmed = direction != null && score >= c.confirmDays;
    out.push({
      date: series[i].date, close: cur, movePct, day,
      direction, score, confirmed,
      regime: confirmed ? direction : 'FLAT',
      runDays, flatDays, counterDays, eroding,
      thresholdUsed: ref,
    });
  }
  return out;
}

/** Contiguous stretches of the same confirmed regime — the real sample unit. */
export function regimeEpisodes(rows) {
  const eps = [];
  let cur = null;
  for (const r of rows) {
    const state = r.confirmed ? r.direction : 'FLAT';
    if (!cur || cur.state !== state) {
      if (cur) eps.push(cur);
      cur = { state, from: r.date, to: r.date, days: 1 };
    } else { cur.to = r.date; cur.days += 1; }
  }
  if (cur) eps.push(cur);
  return eps;
}
