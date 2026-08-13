// claudeHybridDecider — the fourth trading philosophy in the ladder.
//
// Receives TWO independent signals and must reconcile them:
//   1. Overlay's decision (LLM judgment on the mechanical proposal)
//   2. The forward rulebook — objective statistics for the CURRENT condition
//      bucket, measured across every cycle whether or not anyone traded
//
// The rulebook is the external ground truth the journal-fed accounts lack:
// its buckets are defined by pre-trade conditions, so no amount of post-hoc
// labelling can flatter them.
//
// Unlike overlay it may size stops freely (clamped by config), and it may
// add to a position when both signals still support it.
//
// By design it keeps NO journal and receives no lessons: the forward rulebook
// is its only learning input, precisely because that is the one source it
// cannot distort by relabelling its own outcomes after the fact.

import { callDecider, validateIntent } from './claudeClient.js';
import { formatRegimeForPrompt } from '../regimeIndicator.js';

const SYSTEM = `\
You trade gold (XAU/USD) for a paper account by reconciling two independent \
sources of evidence. You are not a momentum trader following indicators — you \
are an evidence weigher.

## Your two inputs

1. OVERLAY PROPOSAL — a discretionary judgment from another account that reviews \
a mechanical RSI/MACD signal and recalibrates its levels. It is directional \
judgment, sometimes right, sometimes not. It has no knowledge of the statistics below.

2. FORWARD RULEBOOK — objective statistics for the market conditions holding \
right now (session + H4 ADX bucket + H4 RSI bucket). These are measured across \
EVERY 5-minute cycle in history, traded or not, so they carry no selection bias \
and cannot be distorted by anyone's labelling. Read them as: "when conditions \
looked like this, here is what price actually did over the following 4 hours."

## You are already told which situation this is

The system has already classified how these two sources relate this cycle — \
you are NOT deciding that. The DECISION BRANCH line in your prompt tells you \
which of these three situations you are in (the other three possible \
situations are resolved automatically without ever calling you):

- **agreement** — overlay's direction matches the rulebook's, both meaningful. \
  Strongest case. Trade it, size toward the upper end of your risk budget.
- **rulebook_only_overlay_silent** — the rulebook has a qualified, directional \
  edge and overlay has nothing to say either way. A single missing opinion does \
  not override a large sample, but you are acting alone here — size \
  conservatively. Target risk 0.25–0.40% of the account (still bounded by the \
  budget shown below; use the low end on a thinner/newer bucket, the high end \
  only when the sample is large and the excursion data is clean).
- **overlay_only** — overlay is confident but the rulebook bucket is thin or \
  unqualified. Follow overlay, but treat it as lower-conviction than agreement \
  — size down from what overlay itself would use.

Sample size still governs how much weight the rulebook side gets within \
whichever branch you're in. A bucket with n=200 is evidence; n=30 (rare here, \
since branch classification already required n above the qualification floor) \
is still a hint, not proof.

## Instrument and session
- XAU/USD spot gold. 1 lot = 100 oz = USD 100 P&L per $1 move per lot.
- Trading window 06:00–21:00 UAE. All positions force-close at 21:00 UAE.
- A 0.30-point round-trip spread is charged per trade — targets must clear it.
- ATR(14) per timeframe is provided for volatility-calibrated sizing.
- The snapshot also gives you positional context: previous day's range, today's \
  session range so far, and recent H1 structure. Use these to judge WHERE price \
  sits, not just what the indicators read — e.g. an indicator-clean long right at \
  the top of today's range or just under yesterday's high is a weaker entry than \
  the same reading mid-range, since a reversal there costs more than one that has \
  room to run.

## Sizing
- You choose the stop distance as a multiple of H1 ATR, within the bounds given \
  in the RISK BUDGET section. Wider stops in volatile or ranging conditions, \
  tighter on clean setups.
- Your requested risk (in dollars) must not exceed the remaining budget shown. \
  Lots are computed from your stop distance and risk, and clamped externally.
- Target: at minimum 1.5x the stop distance. Where the rulebook shows a large \
  average move in your direction, a wider target is justified.

## Adding to an existing position
If you already hold a position and BOTH signals still support the same direction, \
you may add. Only add when the evidence is at least as strong as it was on entry, \
and remember every add consumes the same shared risk budget.

## Output — STRICT JSON ONLY
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE",
  "direction": "LONG" | "SHORT" | null,
  "stop_atr_mult": <number — stop distance as a multiple of H1 ATR, or null>,
  "risk_usd": <number — dollars to risk on this position, or null>,
  "target_r": <number — target distance as a multiple of the stop distance, min 1.5, or null>,
  "reasoning": "<1-3 sentences naming which evidence drove the decision>"
}

For TRADE all numeric fields must be present and positive.
For NO_TRADE set direction, stop_atr_mult, risk_usd and target_r to null.
reasoning is mandatory. Do not include a "tag" field — the decision branch \
(agreement / rulebook_only_overlay_silent / overlay_only) already identifies \
this decision; the system labels the trade from that, not from anything you write.`;

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

// Derives a one-line structural summary from the last 5 H1 candles.
// Same helper used by overlay/solo — duplicated here rather than shared so
// each decider file stays self-contained (existing project convention).
function h1StructureSummary(candles) {
  if (!candles || candles.length < 3) return null;
  const c = [...candles].reverse();           // chronological, oldest first
  const n = Math.min(c.length, 5);
  const r = c.slice(-n);                      // last n candles chronological

  const closes = r.map(x => x.close);
  const highs  = r.map(x => x.high);
  const lows   = r.map(x => x.low);
  const ranges = r.map(x => x.high - x.low);

  const closeDir = closes[n-1] > closes[0] ? 'closes rising'
                 : closes[n-1] < closes[0] ? 'closes falling'
                 : 'closes flat';

  const hhLh = highs[n-1] > highs[n-2] ? 'HH' : highs[n-1] < highs[n-2] ? 'LH' : '=H';
  const hlLl = lows[n-1]  > lows[n-2]  ? 'HL' : lows[n-1]  < lows[n-2]  ? 'LL' : '=L';

  const half    = Math.max(1, Math.floor(n / 2));
  const avgOld  = ranges.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const avgNew  = ranges.slice(-half).reduce((s, v) => s + v, 0) / half;
  const rangeDir = avgNew > avgOld * 1.15 ? 'ranges expanding'
                 : avgNew < avgOld * 0.85 ? 'ranges contracting'
                 : 'ranges stable';

  const closesStr = closes.map(v => v.toFixed(1)).join(' ');
  return `last ${n} closes: ${closesStr} · ${closeDir} · ${hhLh}/${hlLl} · ${rangeDir}`;
}

function formatRulebook(bucket, cfg, bucketDesc) {
  if (!bucket) {
    return [
      `FORWARD RULEBOOK — conditions: ${bucketDesc}`,
      `  No statistics for this exact bucket yet. Treat the rulebook as SILENT.`,
    ].join('\n');
  }
  const thin = bucket.n_total < cfg.rulebookMinSamples;
  const dir  = bucket.avg_fwd_4h > 0 ? 'UP' : bucket.avg_fwd_4h < 0 ? 'DOWN' : 'FLAT';
  return [
    `FORWARD RULEBOOK — conditions: ${bucketDesc}`,
    `  Sample size      : ${bucket.n_total} cycles${thin ? `  ⚠️ BELOW the ${cfg.rulebookMinSamples} threshold — treat as a hint, not evidence` : ''}`,
    `  Avg move +1h     : ${fmt(bucket.avg_fwd_1h, 1)} pts`,
    `  Avg move +4h     : ${fmt(bucket.avg_fwd_4h, 1)} pts   → drift ${dir}`,
    `  Cycles closing up: ${fmt(bucket.pct_up_4h, 0)}%  (50% = no directional edge)`,
    `  Avg excursion    : +${fmt(bucket.avg_max_up_4h, 1)} / -${fmt(bucket.avg_max_down_4h, 1)} pts within 4h`,
    `  Confidence label : ${bucket.sample_confidence ?? 'n/a'}`,
  ].join('\n');
}

function formatOverlay(d) {
  if (!d || d.action !== 'TRADE') {
    return [
      `OVERLAY PROPOSAL — none this cycle`,
      `  Overlay did not propose a trade (${d?.action ?? 'no decision'}${d?.tag ? `, ${d.tag}` : ''}).`,
      `  Treat overlay as SILENT — decide on the rulebook alone.`,
    ].join('\n');
  }
  const rr = Math.abs((d.target - d.entry) / (d.entry - d.stop));
  return [
    `OVERLAY PROPOSAL`,
    `  Direction : ${d.direction}`,
    `  Entry     : ${fmt(d.entry)}   Stop: ${fmt(d.stop)}   Target: ${fmt(d.target)}   (R:R ${fmt(rr, 2)}:1)`,
    `  Its lots  : ${fmt(d.lots, 2)}  (its own sizing — yours is independent)`,
    `  Reasoning : "${d.reasoning ?? '(none)'}"`,
  ].join('\n');
}

function formatPositions(positions, cfg, riskUsed, balance) {
  const budget = balance * (cfg.maxTotalRiskPct / 100);
  const lines  = [
    `RISK BUDGET`,
    `  Open positions : ${positions.length} / ${cfg.maxOpenPositions} max`,
    `  Risk deployed  : $${riskUsed.toFixed(0)} of $${budget.toFixed(0)} total budget`,
    `  Remaining      : $${Math.max(0, budget - riskUsed).toFixed(0)}   ← your risk_usd must not exceed this`,
    `  Per-trade cap  : $${(balance * (cfg.maxRiskPerTradePct / 100)).toFixed(0)}`,
    `  Stop bounds    : ${cfg.atrMultMin}x to ${cfg.atrMultMax}x H1 ATR`,
  ];
  if (positions.length > 0) {
    lines.push(`  Currently holding:`);
    for (const p of positions) {
      lines.push(`    ${p.direction} entry=${fmt(p.entryPrice)} stop=${fmt(p.stopLoss)} lots=${fmt(p.lots, 2)}`);
    }
  }
  return lines.join('\n');
}

function formatMarket(marketData, atr, session, price) {
  const lines = [
    `MARKET SNAPSHOT — XAU/USD`,
    `  Price: $${fmt(price)}   Session: ${session ?? 'n/a'}`,
    `  H1 ATR: ${fmt(atr?.h1, 1)}   M30 ATR: ${fmt(atr?.m30, 1)}`,
  ];
  for (const [label, tf] of [['H4 ', marketData.h4], ['H1 ', marketData.h1], ['M30', marketData.m30], ['M5 ', marketData.m5]]) {
    if (!tf) continue;
    lines.push(`  ${label}: RSI=${fmt(tf.rsi, 1)} MACD hist=${fmt(tf.macd_hist)} ADX=${fmt(tf.adx, 1)}`);
  }
  if (marketData.dxyBias) {
    lines.push(`  DXY: ${marketData.dxyBias.bias} (gold is inversely correlated)`);
  }

  // Positional/structural context — where is price relative to recent range,
  // and what has it been doing. Previously missing entirely from this snapshot.
  if (marketData.prevDayHigh != null && marketData.prevDayLow != null) {
    lines.push(`  Prev day range: ${fmt(marketData.prevDayLow)} – ${fmt(marketData.prevDayHigh)}`);
  }
  if (marketData.sessionRange) {
    lines.push(`  ${marketData.sessionRange}`);
  }
  const structure = h1StructureSummary(marketData.h1Candles);
  if (structure) {
    lines.push(`  H1 structure: ${structure}`);
  }

  return lines.join('\n');
}

// ── Decider ──────────────────────────────────────────────────────────────

export async function decide({
  marketData, atr, portfolio, session, price,
  overlayDecision, bucket, bucketDesc, cfg, branch,
  openPositions = [], riskUsed = 0, regime = null,
}) {
  const userContent = [
    `DECISION BRANCH: ${branch}`,
    '',
    // Placed above the market data on purpose: the regime is context the
    // rest of the prompt should be read through, and it is a computed fact,
    // not something to be re-derived from the price action below.
    formatRegimeForPrompt(regime),
    '',
    formatMarket(marketData, atr, session, price),
    '',
    formatRulebook(bucket, cfg, bucketDesc),
    '',
    formatOverlay(overlayDecision),
    '',
    formatPositions(openPositions, cfg, riskUsed, portfolio.current_balance),
    '',
    `Given the branch above, size and place this trade (or add to your position). Do not re-litigate which branch this is.`,
  ].join('\n');

  return await callDecider({ systemPrompt: SYSTEM, userContent, deciderName: 'hybrid', validator: validateIntent });
}
