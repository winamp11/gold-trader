// Does intraday RANGE COMPRESSION predict that these systems lose money?
//
// PREREGISTERED. This spec and its pass criteria were committed before the
// data was queried. Read-only: it changes no trading behaviour.
//
// ── The question, stated precisely ───────────────────────────────────────
//
// This is NOT the question I tested earlier in the month and rejected. That
// one asked whether compression predicts a breakout — a forecasting claim
// about the market. This asks whether compression predicts THESE STRATEGIES
// LOSING, which is a claim about strategy-market fit and can be true while
// the forecasting claim is false.
//
// The mechanism, stated in advance so it can be wrong: every account here is
// a trend-follower with ATR-scaled stops. On a day that travels less than its
// own average range, price chops through a stop placed ~1.5x ATR away without
// ever reaching a target ~2.5x ATR away. Losses are then structural rather
// than directional — the strategy has no room to express itself.
//
// ── No lookahead ─────────────────────────────────────────────────────────
//
// The obvious version of this test cheats: a day's FULL high-low range is only
// known after the close, so filtering on it uses information the decider could
// not have had. Every field used here is suffixed _at_signal and was recorded
// at decision time:
//
//   adr_consumed_pct     = (day range so far) / ADR * 100, at signal
//   range_width_vs_h1_atr = session range so far, in H1 ATRs, at signal
//
// A trade is judged only on what was visible when it was opened.
//
// ── Design ───────────────────────────────────────────────────────────────
//
// DEV:     trades opened before  2026-08-15
// HOLDOUT: trades opened on/after 2026-08-15
//
// The split is by date, not by random sample: these observations are serially
// correlated within a day, so a random split would leak the same day into both
// halves and inflate the holdout.
//
// Both trade-weighted and day-weighted results are reported. A signal that
// fires many times on days it fails looks profitable trade-weighted and is
// not — that error turned a range-position signal from +3.50 into -1.02
// earlier this month, and it is the specific failure this project keeps
// hitting.
//
// ── Pass criteria — ALL must hold, on the HOLDOUT ────────────────────────
//
//   1. DIRECTION: the compressed bucket's day-mean P&L is negative, and the
//      uncompressed bucket's is positive.
//   2. SIZE: the gap between bucket day-means is at least 500 USD.
//   3. SAMPLE: the compressed bucket covers at least 8 distinct days and 15
//      trades. Below that, do not interpret the result at all.
//   4. ROBUSTNESS: the compressed bucket stays negative after removing its
//      two worst days. Concentration in a handful of days has killed every
//      other finding this month.
//   5. CONSISTENCY: at least 60% of compressed days are losing days. A mean
//      dragged by outliers is not a rule.
//   6. AGREEMENT: criteria 1-5 hold for BOTH claude_overlay and mechanical.
//      These are independent systems; a real strategy-market-fit effect must
//      appear in both. This is what made the JP finding credible and what
//      every rejected finding lacked.
//
// Anything less is NOT CONFIRMED. Partial passes are reported as failures --
// no post-hoc threshold shopping, no "promising, worth another look".
//
// ── Thresholds, fixed in advance ─────────────────────────────────────────
//
// Compressed is defined by adr_consumed_pct at signal. The cut is 40%: by
// mid-session a normal day has travelled a substantial share of its ADR, so
// under 40% is a day that is not going anywhere. Chosen for being a round
// number with a stated rationale, NOT by scanning for the best-performing
// cut. The sweep below is reported for information only and cannot change the
// verdict, which is fixed to CUT_PCT.

export const CUT_PCT   = 40;
export const DEV_END   = '2026-08-15';
export const MIN_DAYS  = 8;
export const MIN_TRADES = 15;
export const MIN_GAP_USD = 500;
export const MIN_LOSING_DAY_SHARE = 0.60;
export const ACCOUNTS = ['claude_overlay', 'mechanical'];

// Reported for information. Sweeping these and picking the best is exactly how
// the RSI dip rule looked good in development and died in holdout.
export const INFO_ONLY_SWEEP = [20, 30, 40, 50, 60];

export function bucketOf(adrConsumedPct, cut = CUT_PCT) {
  if (adrConsumedPct == null || !Number.isFinite(Number(adrConsumedPct))) return null;
  return Number(adrConsumedPct) < cut ? 'compressed' : 'normal';
}

// rows: [{ open_time, pnl, adr_consumed_pct }]
export function summarize(rows, cut = CUT_PCT) {
  const out = {};
  for (const b of ['compressed', 'normal']) {
    const r = rows.filter(x => bucketOf(x.adr_consumed_pct, cut) === b);
    const byDay = {};
    for (const x of r) {
      const d = x.open_time.slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + Number(x.pnl);
    }
    const days = Object.values(byDay).sort((a, z) => a - z);
    const net  = r.reduce((s, x) => s + Number(x.pnl), 0);
    out[b] = {
      trades: r.length,
      days: days.length,
      net: Math.round(net),
      tradeMean: r.length ? Math.round(net / r.length) : 0,
      dayMean:   days.length ? Math.round(net / days.length) : 0,
      // Robustness: drop the two worst days.
      dayMeanExWorst2: days.length > 2
        ? Math.round(days.slice(2).reduce((s, v) => s + v, 0) / (days.length - 2))
        : null,
      losingDays: days.filter(v => v < 0).length,
      losingDayShare: days.length ? days.filter(v => v < 0).length / days.length : 0,
    };
  }
  return out;
}

export function verdictFor(summary) {
  const c = summary.compressed, n = summary.normal;
  const checks = {
    direction:  c.dayMean < 0 && n.dayMean > 0,
    size:       (n.dayMean - c.dayMean) >= MIN_GAP_USD,
    sample:     c.days >= MIN_DAYS && c.trades >= MIN_TRADES,
    robustness: c.dayMeanExWorst2 != null && c.dayMeanExWorst2 < 0,
    consistency: c.losingDayShare >= MIN_LOSING_DAY_SHARE,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}
