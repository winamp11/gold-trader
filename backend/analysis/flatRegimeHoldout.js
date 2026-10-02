// Do the bots lose on days that START in a multi-day range?
//
// PREREGISTERED. Spec and pass criteria committed before any P&L was split
// by this classifier. Read-only: changes no trading behaviour.
//
// ── RESULT (2 Oct 2026): NOT CONFIRMED — and the wrong tool for the job ───
//
// Spec committed 54417c5 before the split. 67 days: 20 FLAT, 47 TREND.
//
//   mean P&L per day        DEV FLAT / TREND      HOLDOUT FLAT / TREND
//   mechanical               +592 /  +760          +1,946 / -1,896
//   overlay                +2,292 / +1,077          +1,716 / -1,912
//   (hybrid, reported)       -407 /     +1          +1,245 /   -331
//   (mirror, reported)          — /   +368            +897 /   -156
//
// P1, P2 and P4 fail for both tested accounts: in the holdout the bots made
// money on FLAT-start days and lost on TREND-start days. Dev doesn't show
// that ordering consistently (overlay's dev goes the other way), so it is
// not an inverted rule either.
//
// Why it missed the week that motivated it: 28 Sep - 1 Oct all classified
// TREND. Monday's $155 drop put the 3d/5d readings at -3% to -5% (DOWN) for
// the whole week, so a range that forms AFTER a big move reads as a
// downtrend on these windows. Close-to-close change can't see chop that
// follows a gap; it would need a range-based measure (e.g. how many days
// price has stayed inside one day's high-low), which is a different test.
//
// ── Why this question ────────────────────────────────────────────────────
//
// Week of 28 Sep: gold dropped 4,286 -> 4,131 on Monday, then chopped in a
// ~$70 band. Mechanical -8.5k, overlay -9.9k. The morning-range test showed a
// chop day can't be recognised by 12:00 from the morning alone. This asks
// whether a range that is already visible at the PREVIOUS close — the 3- and
// 5-day price-change readings sitting FLAT — marks days the bots lose on.
//
// An earlier "flat days" finding (10-day reading) turned out to be the
// 06:00-10:00 window in disguise. That window is now blocked, and entries
// before 10:00 UAE are excluded below so it cannot recur.
//
// ── Classifier (known before the day starts) ─────────────────────────────
//
//   For day D, take daily closes up to and including the previous trading
//   day's close. Compute the 3-day and 5-day price change with the same
//   functions and sqrt-time thresholds the Analyst page uses:
//     3d  ±1.6%      5d  ±2.1%
//   FLAT day  = BOTH the 3d and 5d readings are FLAT.
//   TREND day = anything else (either reading UP or DOWN).
//   One definition, fixed here; no "either", no other windows tried after.
//
// ── Outcome ──────────────────────────────────────────────────────────────
//
//   Per account, per UAE trading day: summed P&L of trades OPENED that day
//   at or after 10:00 UAE. A trading day with no such trades counts as 0.
//   Accounts tested: mechanical, claude_overlay (both span the full period).
//   claude_hybrid and overlay_mirror are reported, not tested — hybrid
//   started 27 Jul and mirror 24 Aug, so they have no full dev period.
//
// ── Split (by date) ──────────────────────────────────────────────────────
//
//   DEV       2026-07-01 .. 2026-08-31
//   HOLDOUT   2026-09-01 .. 2026-10-01
//
// Confounds inside the holdout: signal gate 4->5 on 22 Sep, mechanical stops
// to 1.5x ATR on 24 Sep. Both apply to FLAT and TREND days alike.
//
// ── Pass criteria — ALL must hold, for BOTH accounts independently ───────
//
//   P1  HOLDOUT mean P&L per FLAT day is negative.
//   P2  HOLDOUT mean P&L per FLAT day is below the mean per TREND day.
//   P3  HOLDOUT has at least 5 FLAT days and 5 TREND days.
//   P4  P1 and P2 still hold with the single worst FLAT day removed AND the
//       single best TREND day removed.
//   A1  DEV shows P2 as well (FLAT mean below TREND mean).
//
// Anything less is NOT CONFIRMED.

import { momentumPct, stateFor } from '../regimeIndicator.js';

export const DEV_START = '2026-07-01';
export const SPLIT     = '2026-09-01';
export const END       = '2026-10-01';
export const ENTRY_FROM_MIN = 10 * 60;
export const WINDOWS = [
  { lookbackDays: 3, thresholdPct: 1.6 },
  { lookbackDays: 5, thresholdPct: 2.1 },
];
export const TESTED_ACCOUNTS   = ['mechanical', 'claude_overlay'];
export const REPORTED_ACCOUNTS = ['claude_hybrid', 'overlay_mirror'];
export const MIN_DAYS = 5;

// closes: ascending [{date, close}]. Classify `day` from closes strictly
// before it. Returns 'FLAT' | 'TREND' | null (not enough history).
export function classifyDay(closes, day) {
  const prior = closes.filter(c => c.date < day);
  const states = WINDOWS.map(w => stateFor(momentumPct(prior, w.lookbackDays), w.thresholdPct));
  if (states.includes('UNKNOWN')) return null;
  return states.every(s => s === 'FLAT') ? 'FLAT' : 'TREND';
}

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

// rows: [{ day, cls, pnl }] for one account and one period.
export function summarise(rows) {
  const flat  = rows.filter(r => r.cls === 'FLAT').map(r => r.pnl);
  const trend = rows.filter(r => r.cls === 'TREND').map(r => r.pnl);
  const flatEx  = [...flat].sort((a, b) => a - b).slice(1);           // drop worst FLAT
  const trendEx = [...trend].sort((a, b) => b - a).slice(1);          // drop best TREND
  return {
    nFlat: flat.length, nTrend: trend.length,
    flatMean: mean(flat), trendMean: mean(trend),
    flatMeanEx: mean(flatEx), trendMeanEx: mean(trendEx),
    flatUp: flat.filter(v => v > 0).length, trendUp: trend.filter(v => v > 0).length,
  };
}

export function verdict(dev, hold) {
  const lt = (a, b) => a != null && b != null && a < b;
  return {
    P1: hold.flatMean != null && hold.flatMean < 0,
    P2: lt(hold.flatMean, hold.trendMean),
    P3: hold.nFlat >= MIN_DAYS && hold.nTrend >= MIN_DAYS,
    P4: hold.flatMeanEx != null && hold.flatMeanEx < 0 && lt(hold.flatMeanEx, hold.trendMeanEx),
    A1: lt(dev.flatMean, dev.trendMean),
  };
}
