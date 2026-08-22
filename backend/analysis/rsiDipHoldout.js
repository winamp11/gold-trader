// rsiDipHoldout.js — one preregistered test of the RSI dip rule, on data
// nobody has looked at.
//
// READ-ONLY. Fetches history from Twelve Data and evaluates. Touches no
// database, no trading path, nothing live.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
//
// The rule below was developed and refined against Aug 2024 - Aug 2026. That
// window began as a clean holdout and is no longer one: roughly a dozen
// analyses were run across it, and each of the rule's refinements -- the
// one-entry-per-day cap, the 11:00-16:00 window -- was chosen by looking at
// results on that same data. Every one of them will therefore look good on it
// again. That is not evidence.
//
// So the SPEC AND THE PASS CRITERIA BELOW ARE FROZEN, and this file is
// committed BEFORE the holdout data has been fetched even once. Whatever the
// numbers come back as, they are the answer. No parameter here may be changed
// after seeing them -- if it is, the result is worthless and this file should
// be deleted rather than edited.
//
// Default holdout: 2022-08-01 .. 2024-07-31, which ends the day before the
// existing dataset begins. No overlap.
//
// ── RESULT, 2026-08-22: FAILED ──────────────────────────────────────────
//
// Run once, on 11,729 hourly bars, 2022-08-01 .. 2024-07-31:
//
//   trades      261
//   win rate    42%
//   avg P&L     -0.32 points per trade      (PRIMARY required >= +1.00)
//   total       -83 points
//   quarters    -32 / +73 / -49 / -75       (SUPPORT required 3 of 4 positive)
//
//   gold ROSE : 14 months, -27 pts, profitable 8/14
//   gold FELL : 10 months, -56 pts, profitable 2/10
//
// Development window gave +1.18/trade. The holdout gives -0.32. That gap is
// the overfitting, measured rather than argued about.
//
// Note it lost in RISING months too (-27, 8/14). So this is not only the
// known bull-market dependence -- the rule itself does not carry.
//
// The rule as specified is DEAD. Not "needs tuning": the freeze exists so that
// a failing result cannot be rescued by adjusting the hour window or the daily
// cap until it passes, which is precisely what would have happened otherwise.
// Anyone tempted to edit the spec above and re-run should instead read the
// development-window numbers again and notice they were +2.07, then +1.18, and
// now -0.32 as the data got further from where the parameters were chosen.
//
// What remains true and was never tested here: the RSI band is a legitimate
// self-normalising oversold measure. What failed is the claim that acting on
// it, with this geometry, makes money.
//
// ── THE RULE, AS SPECIFIED (frozen) ─────────────────────────────────────
//
//   indicator   RSI(14), Wilder, on H1 closes
//   band        mean and population stdev of RSI over the last 14 bars,
//               INCLUDING the current bar (faithful to the Pine original;
//               legitimate because the decision is taken at bar close)
//   signal      RSI < mean - 1.0 * stdev
//   side        LONG only (the overbought side tested inconsistently)
//   timing      entry only when UAE hour is in [11, 16)
//   frequency   at most ONE entry per UAE day
//   stop        1.5 x ATR(14) H1, below entry
//   exit        stop, or the close of the 4th bar after entry
//   cost        0.30 points charged per round trip
//   overlap     none; flat before the next entry is considered
//
// ── PASS CRITERIA (frozen, stated before the data was seen) ─────────────
//
//   PRIMARY   trade-weighted mean P&L >= +1.00 points per trade.
//             Half the +2.07 measured on the development window. Anything
//             below this is "not confirmed", not "nearly".
//   SUPPORT   positive in at least 3 of the 4 half-year sub-periods.
//   REPORTED, NOT A CRITERION
//             the up-month / down-month split. The rule is already known to
//             depend on gold rising (13/15 vs 2/7 on the development window);
//             this is measured to size that dependence, not to judge the rule.
//
// A result that passes PRIMARY but fails SUPPORT is a rule carried by one
// period, which is what most of this project's dead ends looked like.
//
// USAGE
//   TWELVE_DATA_API_KEY=... node analysis/rsiDipHoldout.js
//   TWELVE_DATA_API_KEY=... node analysis/rsiDipHoldout.js --from 2022-08-01 --to 2024-07-31
//   node analysis/rsiDipHoldout.js --csv path/to/hourly.csv     (offline, same columns as the 2024-26 pull)

const BASE_URL = 'https://api.twelvedata.com';

export const SPEC = Object.freeze({
  rsiPeriod: 14, bandWindow: 14, bandMult: 1.0,
  hourFrom: 11, hourTo: 16,          // UAE, half-open
  maxEntriesPerDay: 1,
  stopAtrMult: 1.5, atrPeriod: 14,
  holdBars: 4,
  spreadPoints: 0.30,
});

export const PASS = Object.freeze({ minAvgPoints: 1.00, minPositiveHalves: 3 });

// ── Indicators (Wilder, matching what the live system fetches) ──────────

export function wilderRsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const c = closes[i] - closes[i - 1]; g += Math.max(c, 0); l += Math.max(-c, 0); }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(c, 0)) / n;
    al = (al * (n - 1) + Math.max(-c, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function wilderAtr(high, low, close, n = 14) {
  const out = new Array(close.length).fill(null);
  const tr = new Array(close.length).fill(null);
  for (let i = 1; i < close.length; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  if (close.length <= n) return out;
  let s = 0;
  for (let i = 1; i <= n; i++) s += tr[i];
  out[n] = s / n;
  for (let i = n + 1; i < close.length; i++) out[i] = (out[i - 1] * (n - 1) + tr[i]) / n;
  return out;
}

/** Signal at bar close: RSI below its own rolling mean minus one stdev. */
export function signalAt(rsi, i, { bandWindow, bandMult }) {
  if (i < bandWindow) return false;
  const w = [];
  for (let j = i - bandWindow + 1; j <= i; j++) { if (rsi[j] == null) return false; w.push(rsi[j]); }
  const mu = w.reduce((s, x) => s + x, 0) / w.length;
  const sd = Math.sqrt(w.reduce((s, x) => s + (x - mu) ** 2, 0) / w.length);
  return sd > 0 && rsi[i] < mu - bandMult * sd;
}

// ── The simulation ──────────────────────────────────────────────────────

/** bars: [{ datetime_uae, open, high, low, close }] ascending. */
export function simulate(bars, spec = SPEC) {
  const close = bars.map(b => +b.close), high = bars.map(b => +b.high), low = bars.map(b => +b.low);
  const rsi = wilderRsi(close, spec.rsiPeriod);
  const atr = wilderAtr(high, low, close, spec.atrPeriod);
  const perDay = new Map();
  const trades = [];
  let i = Math.max(spec.rsiPeriod, spec.atrPeriod) + spec.bandWindow;

  while (i < bars.length - spec.holdBars) {
    const [d, t] = String(bars[i].datetime_uae).split(' ');
    const hour = parseInt(t.slice(0, 2), 10);
    const inWindow = hour >= spec.hourFrom && hour < spec.hourTo;
    const taken = perDay.get(d) ?? 0;

    if (inWindow && taken < spec.maxEntriesPerDay && atr[i] && signalAt(rsi, i, spec)) {
      const entry = close[i], stop = entry - spec.stopAtrMult * atr[i];
      let exit = null;
      for (let k = 1; k <= spec.holdBars; k++) { if (low[i + k] <= stop) { exit = stop; break; } }
      if (exit == null) exit = close[i + spec.holdBars];
      trades.push({ date: d, pnl: exit - entry - spec.spreadPoints });
      perDay.set(d, taken + 1);
      i += spec.holdBars;
    } else i += 1;
  }
  return trades;
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function evaluate(trades, bars) {
  const pnl = trades.map(t => t.pnl);
  const avg = mean(pnl), total = pnl.reduce((s, x) => s + x, 0);
  const wins = pnl.filter(x => x > 0).length;

  // Four equal calendar quarters of the span, so "halves" are not chosen to flatter.
  const dates = trades.map(t => t.date).sort();
  const halves = [];
  if (dates.length) {
    const a = new Date(dates[0]).getTime(), b = new Date(dates[dates.length - 1]).getTime();
    for (let q = 0; q < 4; q++) {
      const lo = new Date(a + (b - a) * q / 4).toISOString().slice(0, 10);
      const hi = new Date(a + (b - a) * (q + 1) / 4).toISOString().slice(0, 10);
      const g = trades.filter(t => t.date >= lo && (q === 3 ? t.date <= hi : t.date < hi)).map(t => t.pnl);
      halves.push({ lo, hi, n: g.length, total: g.reduce((s, x) => s + x, 0), avg: mean(g) });
    }
  }

  // Monthly gold direction, from the bars themselves.
  const byMonth = new Map();
  for (const b of bars) {
    const m = String(b.datetime_uae).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(+b.close);
  }
  const tradesByMonth = new Map();
  for (const t of trades) {
    const m = t.date.slice(0, 7);
    tradesByMonth.set(m, (tradesByMonth.get(m) ?? []).concat(t.pnl));
  }
  let up = [], dn = [];
  for (const [m, v] of tradesByMonth) {
    const px = byMonth.get(m);
    if (!px) continue;
    (px[px.length - 1] - px[0] > 0 ? up : dn).push(v.reduce((s, x) => s + x, 0));
  }

  const positiveHalves = halves.filter(h => h.total > 0).length;
  return {
    n: pnl.length, avg, total, winRate: pnl.length ? wins / pnl.length * 100 : null,
    halves, positiveHalves,
    upMonths: up.length, upTotal: up.reduce((s, x) => s + x, 0), upProfitable: up.filter(x => x > 0).length,
    dnMonths: dn.length, dnTotal: dn.reduce((s, x) => s + x, 0), dnProfitable: dn.filter(x => x > 0).length,
    passPrimary: avg != null && avg >= PASS.minAvgPoints,
    passSupport: positiveHalves >= PASS.minPositiveHalves,
  };
}

// ── Data ────────────────────────────────────────────────────────────────

async function fetchHourly(apiKey, from, to) {
  const out = new Map();
  let cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T23:59:59Z`);
  while (cur < end) {
    const nxt = new Date(Math.min(cur.getTime() + 180 * 864e5, end.getTime()));
    const q = new URLSearchParams({
      apikey: apiKey, symbol: 'XAU/USD', interval: '1h', timezone: 'Asia/Dubai',
      start_date: cur.toISOString().slice(0, 10), end_date: nxt.toISOString().slice(0, 10),
      outputsize: '5000', order: 'ASC',
    });
    const r = await fetch(`${BASE_URL}/time_series?${q}`);
    const d = await r.json();
    if (d.status === 'error') throw new Error(d.message || 'time_series error');
    for (const v of d.values ?? []) out.set(v.datetime, v);
    console.log(`  fetched ${cur.toISOString().slice(0, 10)}..${nxt.toISOString().slice(0, 10)}: ${(d.values ?? []).length} bars (${out.size} unique)`);
    cur = nxt;
    await new Promise(r2 => setTimeout(r2, 1000));
  }
  return [...out.values()].sort((a, b) => a.datetime.localeCompare(b.datetime))
    .map(v => ({ datetime_uae: v.datetime, open: v.open, high: v.high, low: v.low, close: v.close }));
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const from = arg('--from') ?? '2022-08-01';
  const to   = arg('--to')   ?? '2024-07-31';

  let bars;
  const csv = arg('--csv');
  if (csv) {
    // \r must be stripped from BOTH keys and values. A CRLF file otherwise
    // yields a "close\r" column, b.close is undefined, every price parses as
    // NaN, and the run completes with zero trades — which the verdict block
    // below would have reported as the rule failing. It is not a result.
    const text = (await import('node:fs')).readFileSync(csv, 'utf8').trim().split(/\r?\n/);
    const head = text[0].split(',').map(h => h.trim());
    bars = text.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v.trim()])))
      .filter(b => b.datetime_uae >= from && b.datetime_uae <= `${to} 23:59:59`);
  } else {
    const key = process.env.TWELVE_DATA_API_KEY;
    if (!key) { console.error('TWELVE_DATA_API_KEY is not set (or pass --csv)'); process.exit(1); }
    console.log(`fetching XAU/USD 1h, ${from} .. ${to}`);
    bars = await fetchHourly(key, from, to);
  }
  if (bars.length < 500) { console.error(`only ${bars.length} bars — refusing to judge on this`); process.exit(1); }

  // A verdict must never be printed over broken input. Every failure below is
  // a SETUP problem, not evidence about the rule, and they are indistinguishable
  // from a genuine "no signals" run once the summary is printed.
  const badPrice = bars.findIndex(b => ![b.open, b.high, b.low, b.close].every(v => Number.isFinite(+v)));
  if (badPrice >= 0) {
    console.error(`bar ${badPrice} has unparseable prices: ${JSON.stringify(bars[badPrice])}`);
    console.error(`columns seen: ${Object.keys(bars[badPrice]).join(', ')}`);
    console.error(`(a CRLF file produces a "close\\r" column and NaN prices — check line endings)`);
    process.exit(1);
  }
  const badTime = bars.findIndex(b => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(b.datetime_uae)));
  if (badTime >= 0) {
    console.error(`bar ${badTime} has an unexpected datetime: ${JSON.stringify(bars[badTime].datetime_uae)}`);
    console.error(`expected "YYYY-MM-DD HH:mm:ss" in UAE time`);
    process.exit(1);
  }

  const trades = simulate(bars);
  if (trades.length === 0) {
    console.error(`\nZERO TRADES over ${bars.length} bars. This is a SETUP FAILURE, not a result —`);
    console.error(`the rule fires several times a week on comparable data. Check the hour window`);
    console.error(`(${SPEC.hourFrom}-${SPEC.hourTo} UAE) against the timezone of this file before reading anything into it.`);
    process.exit(1);
  }
  const r = evaluate(trades, bars);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`PREREGISTERED HOLDOUT — RSI dip rule`);
  console.log(`${'='.repeat(64)}`);
  console.log(`bars      : ${bars.length}   ${bars[0].datetime_uae} .. ${bars[bars.length - 1].datetime_uae}`);
  console.log(`spec      : RSI(14) < mean-1sd over 14 bars · LONG · 11-16 UAE · 1/day`);
  console.log(`            stop 1.5xATR · hold 4 bars · ${SPEC.spreadPoints} spread\n`);
  console.log(`trades    : ${r.n}`);
  console.log(`win rate  : ${r.winRate == null ? 'n/a' : r.winRate.toFixed(0) + '%'}`);
  console.log(`avg P&L   : ${r.avg == null ? 'n/a' : (r.avg >= 0 ? '+' : '') + r.avg.toFixed(2)} points per trade`);
  console.log(`total     : ${(r.total >= 0 ? '+' : '') + r.total.toFixed(0)} points\n`);
  console.log(`quarters of the span:`);
  for (const h of r.halves) console.log(`  ${h.lo} .. ${h.hi}   n=${String(h.n).padStart(4)}   ${(h.total >= 0 ? '+' : '') + h.total.toFixed(0)} pts`);
  console.log(`\ngold direction (reported, not a criterion):`);
  console.log(`  months gold ROSE : ${r.upMonths}  total ${(r.upTotal >= 0 ? '+' : '') + r.upTotal.toFixed(0)}  profitable ${r.upProfitable}/${r.upMonths}`);
  console.log(`  months gold FELL : ${r.dnMonths}  total ${(r.dnTotal >= 0 ? '+' : '') + r.dnTotal.toFixed(0)}  profitable ${r.dnProfitable}/${r.dnMonths}`);
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`PRIMARY  avg >= +${PASS.minAvgPoints.toFixed(2)} pts/trade   ${r.passPrimary ? 'PASS' : 'FAIL'}   (got ${r.avg == null ? 'n/a' : r.avg.toFixed(2)})`);
  console.log(`SUPPORT  >= ${PASS.minPositiveHalves}/4 quarters positive    ${r.passSupport ? 'PASS' : 'FAIL'}   (got ${r.positiveHalves}/4)`);
  console.log(`${'-'.repeat(64)}`);
  // The rule was developed against 2024-08 .. 2026-08. A run overlapping that
  // window is a rehearsal, not a test, and must never print a verdict that
  // reads as confirmation — which is exactly what it did on the first run.
  const DEV_FROM = '2024-08-01', DEV_TO = '2026-08-31';
  const overlapsDev = bars[0].datetime_uae.slice(0, 10) <= DEV_TO &&
                      bars[bars.length - 1].datetime_uae.slice(0, 10) >= DEV_FROM;

  if (overlapsDev) {
    console.log(`\n⚠️  THIS RANGE OVERLAPS THE DEVELOPMENT WINDOW (${DEV_FROM} .. ${DEV_TO}).`);
    console.log(`    The rule's parameters — the one-per-day cap and the ${SPEC.hourFrom}-${SPEC.hourTo} window —`);
    console.log(`    were chosen by looking at results on this data. It will pass. That is not`);
    console.log(`    evidence of anything. Run it on a range that ends before ${DEV_FROM}.`);
    return;
  }
  console.log(r.passPrimary && r.passSupport
    ? `\nCONFIRMED on data it was not developed against.`
    : `\nNOT CONFIRMED. The rule does not reproduce outside its development window.\nDo not adjust the parameters to make this pass — that is what the freeze is for.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
