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

import { callDecider, validateIntent } from './claudeClient.js';

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

## How to weigh them

- BOTH AGREE (overlay's direction matches the rulebook's drift, with a decent \
  sample) — strongest case. Trade it, and size toward the upper end of your budget.
- RULEBOOK STRONG, OVERLAY SILENT OR OPPOSED — the statistics describe what the \
  market does; a single judgment call does not override a large sample. You may \
  trade the rulebook direction, but size conservatively.
- OVERLAY CONFIDENT, RULEBOOK THIN OR ABSENT (low sample, or no qualified bucket) \
  — you may follow overlay, but treat it as a lower-conviction trade and size down.
- THEY CONTRADICT AND BOTH ARE STRONG — this is genuine ambiguity. NO_TRADE is \
  the correct answer. You are not paid to have an opinion every cycle.
- NEITHER SUPPORTS A TRADE — NO_TRADE.

Sample size governs confidence. A bucket with n=200 is evidence; n=30 is a hint. \
Never treat a small sample as though it were a large one.

## Instrument and session
- XAU/USD spot gold. 1 lot = 100 oz = USD 100 P&L per $1 move per lot.
- Trading window 06:00–21:00 UAE. All positions force-close at 21:00 UAE.
- A 0.30-point round-trip spread is charged per trade — targets must clear it.
- ATR(14) per timeframe is provided for volatility-calibrated sizing.

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
  "reasoning": "<1-3 sentences naming which evidence drove the decision>",
  "tag": "<snake_case label, e.g. both_agree_long, rulebook_only_short, contradiction_pass>"
}

For TRADE all numeric fields must be present and positive.
For NO_TRADE set direction, stop_atr_mult, risk_usd and target_r to null.
reasoning and tag are mandatory.`;

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

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
  return lines.join('\n');
}

// ── Decider ──────────────────────────────────────────────────────────────

export async function decide({
  marketData, atr, portfolio, session, price,
  overlayDecision, bucket, bucketDesc, cfg,
  openPositions = [], riskUsed = 0, recentLessons = [],
}) {
  const userContent = [
    formatMarket(marketData, atr, session, price),
    '',
    formatRulebook(bucket, cfg, bucketDesc),
    '',
    formatOverlay(overlayDecision),
    '',
    formatPositions(openPositions, cfg, riskUsed, portfolio.current_balance),
    '',
    recentLessons.length
      ? `RECENT LESSONS:\n${recentLessons.slice(0, 5).map((l, i) => `${i + 1}. [${l.entry_type}] ${l.lesson_text} (tag: ${l.tag})`).join('\n')}`
      : `RECENT LESSONS: none yet.`,
    '',
    `Weigh the two sources of evidence above. Trade, add to your position, or pass?`,
  ].join('\n');

  return await callDecider({ systemPrompt: SYSTEM, userContent, deciderName: 'hybrid', validator: validateIntent });
}
