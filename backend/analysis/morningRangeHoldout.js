// Does the morning's range predict whether the rest of the day will trend?
//
// PREREGISTERED. Spec, thresholds method and pass criteria committed before
// any data was pulled. Read-only: changes no trading behaviour.
//
// ── Why this question ────────────────────────────────────────────────────
//
// The review on 24 Sep found that daily P&L is decided by how far gold moves,
// not by what the bots decide. Days split into thirds by close-to-close move:
//
//                  small (~$10)   medium (~$35)   big (~$91)
//   mechanical      -3,615          -4,058          +5,058    avg P&L/day
//   overlay         -3,775            -662          +4,810
//
// And the bots trade the same amount on every kind of day. If chop-day
// losses were halved, mechanical goes roughly -47k -> +29k and overlay
// +12k -> +51k over the same days. So the question worth money is whether a
// chop day can be recognised EARLY enough to stand down.
//
// ── The trap this design avoids ──────────────────────────────────────────
//
// The obvious test correlates the morning's range with the whole day's range.
// That is circular: the morning IS part of the day, so a big morning
// mechanically makes a big day. The outcome here is measured strictly AFTER
// the cutoff — rest-of-day movement from 12:00 to the 21:00 close — so the
// predictor and the outcome share no bars.
//
// Tercile thresholds are computed on the DEV period only and then applied
// unchanged to the holdout. Computing them on the full sample would leak the
// holdout's distribution into the rule.
//
// ── Definitions ──────────────────────────────────────────────────────────
//
//   Cutoff:            12:00 UAE
//   Predictor:         high - low of H1 bars from 06:00 to 12:00 UAE
//                      (six bars, all fully closed before the cutoff)
//   Outcome (market):  |close at 21:00 - close at 12:00|  — rest-of-day move
//   Outcome (bots):    P&L of trades OPENED at or after 12:00 UAE, per day,
//                      for mechanical and claude_overlay
//
// Two outcomes because they answer different questions. The market outcome
// asks whether volatility clusters within a day — it almost certainly does,
// and passing it alone proves nothing actionable. The bot outcome asks the
// question that matters: does the bots' afternoon P&L actually follow the
// morning's range? A rule is only worth building if BOTH pass.
//
// ── Split ────────────────────────────────────────────────────────────────
//
//   Market:  DEV before 2026-07-15, HOLDOUT from 2026-07-15
//   Bots:    DEV before 2026-08-15, HOLDOUT from 2026-08-15
//
// Different split dates because the bots only have trades from June; the
// market series goes back further. Both splits are by date: intraday
// observations are serially correlated and a random split would leak.
export const CUTOFF_HOUR_UAE   = 12;
export const MORNING_START_UAE = 6;
export const CLOSE_HOUR_UAE    = 21;
export const MARKET_SPLIT      = '2026-07-15';
export const BOT_SPLIT         = '2026-08-15';
export const BOT_ACCOUNTS      = ['mechanical', 'claude_overlay'];

// ── Pass criteria — ALL must hold, on the HOLDOUT ────────────────────────
//
//  MARKET
//   M1. Mean rest-of-day |move| in the TOP morning tercile is at least 1.5x
//       the BOTTOM tercile's.
//   M2. The ordering is monotone: bottom < middle < top.
//
//  BOTS — for BOTH accounts independently
//   B1. Mean afternoon P&L per day in the TOP tercile is positive.
//   B2. Mean afternoon P&L per day in the BOTTOM tercile is negative.
//   B3. At least 6 distinct days in each of the top and bottom terciles.
//   B4. Top tercile stays positive after dropping its single best day.
//       Concentration in one or two days has killed most findings this month.
//
//  AGREEMENT
//   A1. Dev shows the same signs for M1, B1 and B2. A rule that only works
//       out of sample is noise, not a discovery.
//
// Anything less is NOT CONFIRMED. No threshold shopping, no alternative
// cutoff hours tried afterwards — the cutoff is fixed at 12:00 above.
export const MIN_RATIO_TOP_BOTTOM = 1.5;
export const MIN_DAYS_PER_TERCILE = 6;

// Tercile edges from a list of dev-period predictor values.
export function tercileEdges(values) {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return null;
  return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]];
}

export function tercileOf(v, edges) {
  if (!edges || !Number.isFinite(v)) return null;
  if (v < edges[0]) return 'bottom';
  if (v < edges[1]) return 'middle';
  return 'top';
}

// days: [{ day, morningRange, restMove }]
export function marketSummary(days, edges) {
  const g = { bottom: [], middle: [], top: [] };
  for (const d of days) {
    const t = tercileOf(d.morningRange, edges);
    if (t && Number.isFinite(d.restMove)) g[t].push(Math.abs(d.restMove));
  }
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return {
    bottom: { n: g.bottom.length, meanRest: mean(g.bottom) },
    middle: { n: g.middle.length, meanRest: mean(g.middle) },
    top:    { n: g.top.length,    meanRest: mean(g.top) },
  };
}

// dayPnl: { [day]: afternoonPnl }, morning: { [day]: morningRange }
export function botSummary(dayPnl, morning, edges) {
  const g = { bottom: [], middle: [], top: [] };
  for (const [day, pnl] of Object.entries(dayPnl)) {
    const t = tercileOf(morning[day], edges);
    if (t) g[t].push(pnl);
  }
  const s = a => {
    if (!a.length) return { n: 0, mean: null, meanExBest: null, winDays: 0 };
    const sorted = [...a].sort((x, y) => x - y);
    const tot = a.reduce((x, y) => x + y, 0);
    return {
      n: a.length,
      mean: tot / a.length,
      meanExBest: a.length > 1 ? (tot - sorted[sorted.length - 1]) / (a.length - 1) : null,
      winDays: a.filter(v => v > 0).length,
    };
  };
  return { bottom: s(g.bottom), middle: s(g.middle), top: s(g.top) };
}

export function marketVerdict(m) {
  const ok = m.bottom.meanRest != null && m.top.meanRest != null && m.middle.meanRest != null;
  return {
    M1: ok && m.top.meanRest >= MIN_RATIO_TOP_BOTTOM * m.bottom.meanRest,
    M2: ok && m.bottom.meanRest < m.middle.meanRest && m.middle.meanRest < m.top.meanRest,
  };
}

export function botVerdict(b) {
  return {
    B1: b.top.mean != null && b.top.mean > 0,
    B2: b.bottom.mean != null && b.bottom.mean < 0,
    B3: b.top.n >= MIN_DAYS_PER_TERCILE && b.bottom.n >= MIN_DAYS_PER_TERCILE,
    B4: b.top.meanExBest != null && b.top.meanExBest > 0,
  };
}
