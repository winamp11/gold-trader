// signalEdge.js — evaluate an entry condition against what price actually did.
//
// READ-ONLY. Issues SELECTs and nothing else. It does not import database.js,
// because that runs initialize() and would apply DDL as a side effect of an
// analysis run. It is a CLI tool: no Express route, nothing in the frontend.
//
// WHY THIS EXISTS
//
// The `signals` table holds one row per 5-minute cycle with the indicators
// frozen at decision time, plus fwd_return_1h / _4h / _eod written later by
// forwardLabeler.js -- for EVERY cycle, traded or not. That absence of
// selection bias is the whole point: a rule can be judged on what price did
// next, not on the subset somebody chose to trade.
//
// Every analysis run this way during August was ad-hoc and thrown away, so no
// two runs were guaranteed to compute the same thing. This makes the loop
// repeatable.
//
// WHAT IT REFUSES TO LET YOU FOOL YOURSELF WITH
//
// 1. It always reports UNIQUE DAYS next to observation count. 5-minute rows
//    inside one day are overlapping views of the same move: 1,857 rows across
//    12 days is 12 samples, not 1,857. Every over-confident result in this
//    project so far came from ignoring that.
// 2. It always reports the BASE RATE and the lift over it, never the
//    conditional mean alone. In a trending window every condition looks
//    profitable; only the difference from "no condition at all" is evidence.
// 3. It reports the base rate's own direction, so a one-way market is visible
//    rather than mistaken for edge.
//
// Forward returns are in PRICE POINTS (USD), signed: positive = price rose.
// For a SHORT idea, negate the lift before reading it.
//
// USAGE
//   node analysis/signalEdge.js --list
//   node analysis/signalEdge.js --condition rsi_band_oversold
//   node analysis/signalEdge.js --condition adx_high --since 2026-07-01
//   node analysis/signalEdge.js --expr "row.h4_adx_at_signal >= 35"
//
// --expr evaluates a JS expression against each row. It is a local developer
// tool run by the repo owner against their own database. It must NEVER be
// wired to an HTTP route or accept input from a request.

import pg from 'pg';

const { Pool } = pg;

// ── Pure helpers (exported for tests) ────────────────────────────────────

/** Distinct YYYY-MM-DD dates present in a set of rows. The real sample size. */
export function uniqueDays(rows) {
  return new Set(rows.map(r => String(r.timestamp).slice(0, 10))).size;
}

function mean(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Mean per day, then mean across days. Equal weight to every day. */
function dayWeightedMean(rows, field) {
  const byDay = new Map();
  for (const r of rows) {
    const v = r[field];
    if (v == null || !Number.isFinite(Number(v))) continue;
    const d = String(r.timestamp).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(Number(v));
  }
  if (byDay.size === 0) return null;
  const perDay = [...byDay.values()].map(v => v.reduce((s, x) => s + x, 0) / v.length);
  return perDay.reduce((s, x) => s + x, 0) / perDay.length;
}

/**
 * Summary for one group of rows, at BOTH weightings. Reporting only one is how
 * this tool misleads you, and it did:
 *
 *   trade-weighted -- the plain mean over observations. What someone taking
 *     every signal actually receives. Its flaw is that 169 overlapping
 *     5-minute rows in a day are nothing like 169 independent facts.
 *
 *   day-weighted -- mean within each day, then across days. Fixes that
 *     autocorrelation, but silently assumes signal frequency is unrelated to
 *     outcome. When a rule fires 12 times on the days it fails and 3 times on
 *     the days it works, equal-weighting days makes a loser look like a
 *     winner.
 *
 * Measured on the range-position rule, 2026-08-22, out-of-sample:
 *   day-weighted   +3.50 pts   (looked like a strong edge)
 *   trade-weighted -1.02 pts   (loses money, confirmed by trade simulation)
 * The busiest third of days averaged -5.59; the quietest third +12.00.
 *
 * Neither number is "the truth". A large disagreement between them IS the
 * finding -- it says the rule's firing rate is tied to its outcome.
 */
export function summarizeGroup(rows) {
  const perDayCounts = [...rows.reduce((m, r) => {
    const d = String(r.timestamp).slice(0, 10);
    return m.set(d, (m.get(d) ?? 0) + 1);
  }, new Map()).values()].sort((a, b) => a - b);

  const at = field => ({
    trade: mean(rows.map(r => r[field])),
    day:   dayWeightedMean(rows, field),
  });

  return {
    n:      rows.length,
    days:   uniqueDays(rows),
    // Proper median: the average of the two middle values on an even count.
    // Taking the upper element instead skews this upward, which matters here
    // because a high signals-per-day figure is the warning sign.
    perDayMedian: perDayCounts.length
      ? (perDayCounts.length % 2
          ? perDayCounts[(perDayCounts.length - 1) / 2]
          : (perDayCounts[perDayCounts.length / 2 - 1] + perDayCounts[perDayCounts.length / 2]) / 2)
      : 0,
    perDayMax:    perDayCounts.length ? perDayCounts[perDayCounts.length - 1] : 0,
    fwd1h:  at('fwd_return_1h'),
    fwd4h:  at('fwd_return_4h'),
    fwdEod: at('fwd_return_eod'),
  };
}

/**
 * Rolling self-normalising band over a numeric series, as used by the
 * "RSI vs its own Bollinger band" idea: at index i, compare value[i] against
 * mean/stdev of the PRECEDING `window` values.
 *
 * Strictly backward-looking -- index i is never included in its own band, or
 * the condition would peek at the bar it is judging.
 *
 * Returns an array aligned to `values`: 'oversold' | 'neutral' | 'overbought'
 * | null (insufficient history, or zero variance).
 */
export function rollingBand(values, window = 14, mult = 1) {
  const out = new Array(values.length).fill(null);
  for (let i = window; i < values.length; i++) {
    const win = values.slice(i - window, i).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
    if (win.length < window) continue;
    const mu = win.reduce((s, x) => s + x, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - mu) ** 2, 0) / win.length);
    const v  = Number(values[i]);
    if (!Number.isFinite(v) || sd === 0) continue;
    out[i] = v < mu - mult * sd ? 'oversold'
           : v > mu + mult * sd ? 'overbought'
           : 'neutral';
  }
  return out;
}

/**
 * Lift over the unconditional base rate, per horizon, at BOTH weightings.
 * The lift -- not the conditional mean -- is what constitutes evidence, since
 * a directional window makes every condition look profitable.
 */
export function computeLift(group, base) {
  const d = (a, b) => (a == null || b == null ? null : a - b);
  const pair = k => ({ trade: d(group[k]?.trade, base[k]?.trade), day: d(group[k]?.day, base[k]?.day) });
  return { fwd1h: pair('fwd1h'), fwd4h: pair('fwd4h'), fwdEod: pair('fwdEod') };
}

/**
 * Do the two weightings tell the same story?
 *
 * Disagreement means the rule's firing rate is correlated with its outcome,
 * which is a real property of the rule and not a rounding artefact. Trade-
 * weighted is the one a trader receives, so it wins -- but the divergence is
 * worth surfacing loudly, because a rule that fires hardest when it is wrong
 * behaves very differently from one that does not.
 */
export function weightingDisagreement(lift) {
  const out = [];
  for (const [k, v] of Object.entries(lift)) {
    if (v.trade == null || v.day == null) continue;
    const signFlip = (v.trade > 0) !== (v.day > 0) && Math.abs(v.trade) > 0.01 && Math.abs(v.day) > 0.01;
    const inflated = Math.abs(v.day) > 2 * Math.abs(v.trade) && Math.abs(v.day - v.trade) > 0.5;
    if (signFlip || inflated) out.push({ horizon: k, trade: v.trade, day: v.day, signFlip });
  }
  return out;
}

// ── Named conditions ─────────────────────────────────────────────────────
// Each is (row, ctx) => boolean. ctx carries series-derived state, e.g. the
// rolling RSI band, which cannot be computed from a single row.

export const CONDITIONS = {
  // The TTP Intelligent Accumulator entry, detached from its martingale:
  // RSI below its own rolling mean minus one standard deviation. Adapts to
  // how volatile RSI itself has been, unlike a fixed RSI<30 line.
  //
  // Tested 2026-08-19 over 12 days: it pointed the WRONG way (oversold
  // underperformed the base rate, overbought beat it). 12 days of a one-way
  // rally proves nothing either way -- rerun on a two-sided sample.
  rsi_band_oversold:   (row, ctx) => ctx.h1Band[ctx.i] === 'oversold',
  rsi_band_overbought: (row, ctx) => ctx.h1Band[ctx.i] === 'overbought',

  // Mechanical's worst regime by a wide margin: -471/trade at ADX 35+ over
  // 117 trades, but only 15 unique days. The single biggest loss cluster
  // found in the live record, and the most obvious filter candidate.
  adx_high:  row => Number(row.h4_adx_at_signal) >= 35,
  adx_chop:  row => Number(row.h4_adx_at_signal) <  20,

  // Where price sits in the day's range at decision time. Computed for the
  // signals table but never passed to any decider.
  range_top:    row => Number(row.range_position_pct) >= 80,
  range_bottom: row => Number(row.range_position_pct) <= 20,

  // The dollar-proxy field, never tested against forward returns.
  dxy_rising:  row => row.dxy_bias_at_signal === 'rising',
  dxy_falling: row => row.dxy_bias_at_signal === 'falling',
};

// ── Data ─────────────────────────────────────────────────────────────────

async function loadRows(pool, since) {
  const { rows } = await pool.query(`
    SELECT timestamp, price_at_signal, signal, session,
           h4_rsi_at_signal, h1_rsi_at_signal, m30_rsi_at_signal,
           h4_adx_at_signal, h1_adx_at_signal, m30_adx_at_signal,
           h4_macd_hist_at_signal, h1_macd_hist_at_signal,
           h1_atr_at_signal, range_position_pct, adr_consumed_pct,
           dxy_bias_at_signal,
           fwd_return_1h, fwd_return_4h, fwd_return_eod,
           fwd_max_up_4h, fwd_max_down_4h
      FROM signals
     WHERE fwd_labeled_at IS NOT NULL
       AND ($1::text IS NULL OR timestamp >= $1)
     ORDER BY timestamp ASC
  `, [since ?? null]);
  return rows;
}

// ── Report ───────────────────────────────────────────────────────────────

const f = (v, dp = 2) => (v == null ? '    n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(dp));

export function report(label, rows, predicate) {
  const h1Band = rollingBand(rows.map(r => r.h1_rsi_at_signal), 14, 1);
  const hit = [], miss = [];
  rows.forEach((row, i) => (predicate(row, { i, h1Band, rows }) ? hit : miss).push(row));

  const base = summarizeGroup(rows);
  const g    = summarizeGroup(hit);
  const lift = computeLift(g, base);

  const disagree = weightingDisagreement(lift);

  console.log(`\n=== ${label} ===`);
  console.log(`window        : ${rows[0]?.timestamp?.slice(0, 10)} .. ${rows[rows.length - 1]?.timestamp?.slice(0, 10)}`);
  console.log(`${''.padEnd(22)}${'fwd+1h'.padStart(10)}${'fwd+4h'.padStart(10)}${'fwd+eod'.padStart(10)}`);
  for (const [w, wl] of [['trade', 'TRADE-weighted'], ['day', 'day-weighted']]) {
    console.log(`  ${(wl + ' base').padEnd(20)}${f(base.fwd1h[w]).padStart(10)}${f(base.fwd4h[w]).padStart(10)}${f(base.fwdEod[w]).padStart(10)}`);
    console.log(`  ${(wl + ' LIFT').padEnd(20)}${f(lift.fwd1h[w]).padStart(10)}${f(lift.fwd4h[w]).padStart(10)}${f(lift.fwdEod[w]).padStart(10)}`);
  }

  console.log(`\nsample: ${g.n} observations across ${g.days} day(s)` +
              `  (median ${g.perDayMedian}/day, max ${g.perDayMax})`);
  console.log(`TRADE-weighted is what you receive taking every signal. Day-weighted removes`);
  console.log(`within-day autocorrelation but assumes firing rate is unrelated to outcome.`);

  if (disagree.length) {
    console.log(`\n  🚩 THE TWO WEIGHTINGS DISAGREE (${disagree.map(d => d.horizon).join(', ')}).`);
    for (const d of disagree) {
      console.log(`     ${d.horizon}: trade ${f(d.trade)} vs day ${f(d.day)}${d.signFlip ? '  — OPPOSITE SIGNS' : ''}`);
    }
    console.log(`     This rule fires at a rate correlated with its own outcome — typically`);
    console.log(`     many times on the days it fails and few on the days it works. Believe`);
    console.log(`     the TRADE-weighted number, and confirm with a trade simulation before`);
    console.log(`     acting. (This exact pattern made the range-position rule look like a`);
    console.log(`     +3.50 edge when it actually loses 1.02 per trade.)`);
  }
  if (g.days < 30) {
    console.log(`\n  ⚠️  ${g.days} days is not a sample. Rows inside one day are overlapping`);
    console.log(`      views of the same move — treat this as a hint, not evidence.`);
  }
  if (base.fwd4h.trade != null && Math.abs(base.fwd4h.trade) > 3) {
    console.log(`\n  ⚠️  base rate is ${f(base.fwd4h.trade)} pts at +4h — the window itself is directional.`);
    console.log(`      Every condition will look good on one side of it. Read the LIFT only.`);
  }
  console.log(`\nForward returns are price POINTS, signed. Negate the lift for a SHORT idea.`);
  console.log(`A positive lift is NOT a P&L estimate — stops and spread typically remove`);
  console.log(`two thirds of it. Simulate before building.`);
  return { base, condition: g, lift, disagree };
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg  = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

  if (argv.includes('--list')) {
    console.log('conditions:\n' + Object.keys(CONDITIONS).map(k => '  ' + k).join('\n'));
    console.log('\nor: --expr "row.h4_adx_at_signal >= 35"');
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

  const name = arg('--condition');
  const expr = arg('--expr');
  if (!name && !expr) { console.error('need --condition <name> or --expr "<js>"  (--list to see names)'); process.exit(1); }
  if (name && !CONDITIONS[name]) { console.error(`unknown condition "${name}" — try --list`); process.exit(1); }

  // eslint-disable-next-line no-new-func -- local CLI only; never HTTP-reachable.
  const predicate = name ? CONDITIONS[name] : new Function('row', 'ctx', `return (${expr});`);

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('sslmode=disable') || url.includes('railway.internal') ? false : { rejectUnauthorized: false },
  });
  try {
    const rows = await loadRows(pool, arg('--since'));
    if (rows.length === 0) { console.log('no labeled signals in range'); return; }
    report(name ?? `expr: ${expr}`, rows, predicate);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
