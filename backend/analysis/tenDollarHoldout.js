// Can a $10-target strategy work in the two high-accuracy hours?
//
// PREREGISTERED. Spec and pass criteria committed before the data was queried.
// Read-only: changes no trading behaviour and touches no live account.
//
// ── The question ─────────────────────────────────────────────────────────
//
// Everything measured so far describes trades sized for ~$39 targets with
// ~$22 stops. This asks a different question at a different scale: entering in
// a given direction during 10:00 or 16:00 UAE, how often does price reach
// +$10 before -$10?
//
// Those two hours are the only ones where directional accuracy beat a coin
// flip on BOTH independent systems (overlay 79%/75%, mechanical 75%/66%,
// against ~50% everywhere else). If a $10 strategy works anywhere, it is here.
//
// ── Costs are not optional at this scale ─────────────────────────────────
//
// A $0.30 round-trip spread against a $10 target is 3% per trade. Modelled
// explicitly: a win nets +9.70, a loss costs -10.30. Breakeven win rate is
// therefore 10.30 / (9.70 + 10.30) = 51.5%, NOT 50%. Any result between 50%
// and 51.5% is a losing strategy that looks like an edge.
export const TARGET_USD = 10.00;
export const STOP_USD   = 10.00;
export const SPREAD_USD = 0.30;
export const BREAKEVEN_WR = (STOP_USD + SPREAD_USD) / (TARGET_USD - SPREAD_USD + STOP_USD + SPREAD_USD);

// ── Overlapping samples are the main statistical trap here ───────────────
//
// Twelve 5-minute bars per hour × ~45 weekdays gives ~540 entries per hour,
// but they are NOT 540 independent observations: one $10 move resolves every
// entry inside it the same way. Treating them as independent is how a range
// -position signal once looked like +3.50 when it was -1.02.
//
// So every result is reported twice — per-entry and per-DAY (each day
// contributing one win-rate figure). The day-level figure is the one the pass
// criteria are judged on, and the day count is the real sample size.
export const HOURS_UAE = [10, 16];

// ── Design ───────────────────────────────────────────────────────────────
//
// DEV:     12 Jul – 31 Aug
// HOLDOUT: 1 Sep onward
//
// Split by date, not at random: intraday observations are serially correlated
// and a random split would leak the same day into both halves.
export const DEV_END = '2026-09-01';

// Direction rules tested. The first is the null hypothesis and exists to
// answer a question that must be settled before any filter is interesting:
// is there a TIMING edge at all, independent of direction? If ALWAYS_LONG and
// ALWAYS_SHORT both sit at ~50%, then these hours carry no intrinsic drift and
// every bit of the edge has to come from picking direction.
export const RULES = ['always_long', 'always_short', 'h1_momentum', 'h1_momentum_inverse'];

// ── Pass criteria — ALL must hold, on the HOLDOUT ────────────────────────
//
//  1. EDGE:        day-level mean win rate > 55%. Not 51.5% — a strategy that
//                  clears breakeven by 0.5pp is not worth running, and the
//                  margin absorbs slippage worse than the modelled spread.
//  2. SAMPLE:      at least 15 distinct days with at least 40 resolved entries.
//  3. CONSISTENCY: at least 60% of days above breakeven.
//  4. ROBUSTNESS:  still above 55% after dropping the best two days.
//  5. BOTH HOURS:  10:00 and 16:00 each clear 55% on their own. One hour
//                  carrying the result is a 45-day fluke, not a mechanism.
//  6. DEV AGREES:  the same rule also passed 1-5 on dev. A rule that only
//                  works out of sample is noise, not a discovery.
//
// Anything less is NOT CONFIRMED. No threshold shopping afterwards.
export const MIN_WR         = 0.55;
export const MIN_DAYS       = 15;
export const MIN_ENTRIES    = 40;
export const MIN_DAY_SHARE  = 0.60;

// resolve(): walk forward bar by bar from an entry and report which level was
// touched first. Bars where BOTH levels fall inside one bar's high/low are
// 'ambiguous' and excluded from win rates rather than guessed — at a $10
// distance on 5-minute bars this is rare but must not be silently resolved in
// the strategy's favour, which is the single easiest way to fake an edge here.
export function resolve(entryPx, dir, forwardBars) {
  const tgt  = dir === 'LONG' ? entryPx + TARGET_USD : entryPx - TARGET_USD;
  const stop = dir === 'LONG' ? entryPx - STOP_USD   : entryPx + STOP_USD;
  for (const b of forwardBars) {
    const hitT = dir === 'LONG' ? b.high >= tgt : b.low  <= tgt;
    const hitS = dir === 'LONG' ? b.low  <= stop : b.high >= stop;
    if (hitT && hitS) return 'ambiguous';
    if (hitT) return 'win';
    if (hitS) return 'loss';
  }
  return 'unresolved';
}

// Direction for a rule, given the trailing hour of bars before entry.
// h1_momentum: sign of the last 12 five-minute bars' net move — the simplest
// possible "go with the recent move". Its inverse is included because the JP
// analysis suggested these systems may be systematically on the wrong side,
// and a rule that loses at 40% is as informative as one that wins at 60%.
export function directionFor(rule, trailingBars) {
  if (rule === 'always_long')  return 'LONG';
  if (rule === 'always_short') return 'SHORT';
  if (!trailingBars.length) return null;
  const net = trailingBars[trailingBars.length - 1].close - trailingBars[0].open;
  if (net === 0) return null;
  const mom = net > 0 ? 'LONG' : 'SHORT';
  if (rule === 'h1_momentum') return mom;
  if (rule === 'h1_momentum_inverse') return mom === 'LONG' ? 'SHORT' : 'LONG';
  return null;
}

export function summarize(rows) {
  const resolved = rows.filter(r => r.outcome === 'win' || r.outcome === 'loss');
  const byDay = {};
  for (const r of resolved) {
    byDay[r.day] = byDay[r.day] || { w: 0, n: 0 };
    byDay[r.day].n += 1;
    if (r.outcome === 'win') byDay[r.day].w += 1;
  }
  const dayWrs = Object.values(byDay).map(d => d.w / d.n).sort((a, b) => a - b);
  const entryWr = resolved.length ? resolved.filter(r => r.outcome === 'win').length / resolved.length : 0;
  const dayMean = dayWrs.length ? dayWrs.reduce((s, v) => s + v, 0) / dayWrs.length : 0;
  return {
    entries: rows.length,
    resolved: resolved.length,
    ambiguous: rows.filter(r => r.outcome === 'ambiguous').length,
    unresolved: rows.filter(r => r.outcome === 'unresolved').length,
    days: dayWrs.length,
    entryWr,
    dayMean,
    // Robustness: drop the two best days.
    dayMeanExBest2: dayWrs.length > 2
      ? dayWrs.slice(0, -2).reduce((s, v) => s + v, 0) / (dayWrs.length - 2)
      : null,
    daysAboveBreakeven: dayWrs.filter(v => v > BREAKEVEN_WR).length,
    dayShare: dayWrs.length ? dayWrs.filter(v => v > BREAKEVEN_WR).length / dayWrs.length : 0,
  };
}

export function verdict(s, perHour) {
  const checks = {
    edge:        s.dayMean > MIN_WR,
    sample:      s.days >= MIN_DAYS && s.resolved >= MIN_ENTRIES,
    consistency: s.dayShare >= MIN_DAY_SHARE,
    robustness:  s.dayMeanExBest2 != null && s.dayMeanExBest2 > MIN_WR,
    bothHours:   HOURS_UAE.every(h => (perHour?.[h]?.dayMean ?? 0) > MIN_WR),
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}
