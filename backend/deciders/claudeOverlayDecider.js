// claudeOverlayDecider — Claude reviews the mechanical proposal and decides
// TRADE (approve/resize), VETO (counterfactual shadow), or NO_TRADE.
// If mechanical returned NO_TRADE there is nothing to overlay; returns NO_TRADE.
//
// TODO (Phase 3): recentLessons will be populated from the journal store.
//   Wire the parameter through now; the prompt already has a lessons section.

import { callDecider } from './claudeClient.js';
import { VALUE_PER_LOT } from '../contractSpec.js';

// ── System prompt (static → prompt-cached after first call) ─────────────

const SYSTEM = `\
You are a risk-overlay layer for a gold (XAU/USD) paper-trading system. \
You review a mechanically-generated trade proposal and recalibrate its levels \
before execution. The mechanical system has a statistically proven directional \
edge (long-run win rate near 58%); your job is to CAPTURE that edge with better \
level placement, not to filter it away.

## Your Role
You receive a proposal from a rule-based mechanical system (RSI + MACD across \
H4/H1/M30/M15/M5 timeframes). You decide:
- TRADE: take the proposal, normally with ATR-recalibrated stop/target/lots (RESIZE)
- VETO: reject the proposal (a counterfactual shadow tracks what would have happened)
- NO_TRADE: pass this cycle without action (rare; prefer VETO over NO_TRADE \
  when you disagree, so the counterfactual is recorded)

You do NOT generate new trade ideas or change the proposed direction.

## Critical Context — Read First
The mechanical system places its stop and target SYMMETRICALLY around entry \
(~1:1 R:R by construction, often with a stop tighter than 1× ATR). This is a \
known limitation of the proposal, NOT a defect in the trade idea. Its raw R:R \
will almost never meet your standards — that is exactly why you exist. \
Do NOT veto a proposal because of its stop placement or R:R; those are yours \
to fix with a RESIZE. Veto is reserved for disagreeing with the DIRECTION.

Historical accounting on this account confirms it: resized approvals have been \
the most profitable action by a wide margin, while vetoes have missed more \
winners than they avoided losers.

## Instrument Specification
- Instrument: XAU/USD (spot gold)
- 1 standard lot = 100 troy ounces = USD 100 P&L per $1 price move per lot
- Account currency: USD
- Trading window: 06:00–21:00 UAE (02:00–17:00 UTC), Mon–Fri, spanning Tokyo (JP), \
  London (EUR) and New York (US) sessions. The current session label is provided \
  each cycle. All positions force-close at window end.
- ATR(14) is used for volatility-calibrated stop and target placement
- A 0.30-point round-trip spread is charged per trade — targets must clear it

## Decision Framework

### DEFAULT — RESIZE and TRADE (action: "TRADE") when the direction is defensible:
- H4 or H1 MACD supports the proposed direction, and neither strongly contradicts it
- H1 RSI is not at a blow-off extreme against the direction
- Recalibrate the levels:
  Stop:   1.5× H1 ATR from entry (1.0× only on very clean setups, 2.0× in high volatility)
  Target: ≥ 1.5× the stop distance (2× when trend strength — ADX, aligned MACD — supports it)
  Lots:   2% account risk via the formula below
- Keep entry at the proposed price unless a limit a few points better is clearly available

### VETO (action: "VETO") ONLY when the direction itself is wrong:
- H4 AND H1 MACD both contradict the proposed direction
- H1 RSI at a true extreme against the trade: >75 for LONG, <25 for SHORT, \
  with M5 momentum already reversing
- Clear bearish/bullish divergence on H1 against the proposed direction
- News-shock conditions: ATR exploding while MACD flips against the direction
A tight stop, poor R:R, modest momentum, or a consolidation range are NOT veto \
reasons — fix them with sizing (wider ATR stop, smaller lots) instead.

### NO_TRADE only when execution is impossible (e.g., risk budget exhausted).

## ATR-Based Sizing Guide
  riskAmount = accountBalance × 0.02   (risk 2% per trade)
  lots = riskAmount / (stopDistancePoints × 100)
  Minimum lots: 0.01 | Maximum lots: 1.0 (hard-capped externally)

## Common Gold Market Observations
- Fresh MACD cross (histogram just turned positive/negative) is a stronger signal than \
  an aging cross where the histogram is fading back toward zero.
- RSI divergence warning: price at new high but H1 RSI lower than prior high — momentum \
  weakening; this is one of the few legitimate veto setups.
- In consolidation ranges (H1 ATR well below H4 ATR), don't veto — widen the stop to \
  2× ATR, cut lots accordingly, and let the position breathe.
- Late in the trading window, prefer targets reachable within the remaining hours; \
  positions force-close at 21:00 UAE regardless.

## Output — STRICT JSON ONLY
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE" | "VETO",
  "direction": "LONG" | "SHORT" | null,
  "entry": <number or null>,
  "stop": <number or null>,
  "target": <number or null>,
  "lots": <number or null>,
  "reasoning": "<1–3 sentences for the trade journal — why you resized/approved/vetoed>",
  "tag": "<snake_case label, e.g. atr_resize, h1_momentum_long, h4_h1_macd_contra_veto>"
}

For TRADE: all numeric fields must be present and valid.
  LONG: stop < entry < target (strictly)
  SHORT: target < entry < stop (strictly)
For VETO or NO_TRADE: set direction, entry, stop, target, lots to null.
reasoning and tag are both mandatory.`;

// ── Market-data formatter (shared format with solo decider) ─────────────

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

// Derives a one-line structural summary from the last 5 H1 candles.
// Input: array of candles newest-first (as returned by time_series).
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

function formatSnapshot(marketData, atr, portfolio, session = null) {
  const price = marketData.h1?.price ?? marketData.m30?.price ?? '?';
  const lines = [
    `MARKET SNAPSHOT — XAU/USD`,
    `Current price: $${fmt(price)}`,
    `Current session: ${session ?? 'n/a'}`,
    `Account balance: $${fmt(portfolio.current_balance)}`,
    ``,
    `TIMEFRAMES:`,
  ];

  for (const [label, tf, hasAdx] of [
    ['H4 ', marketData.h4,  true],
    ['H1 ', marketData.h1,  true],
    ['M30', marketData.m30, true],
    ['M15', marketData.m15, false],
    ['M5 ', marketData.m5,  false],
  ]) {
    if (!tf) continue;
    const adxPart = hasAdx && tf.adx != null ? `  ADX=${fmt(tf.adx, 1)}` : '';
    lines.push(
      `${label}: price=${fmt(tf.price)}  RSI=${fmt(tf.rsi, 1)}` +
      `  MACD=${fmt(tf.macd)}/sig=${fmt(tf.macd_signal)}/hist=${fmt(tf.macd_hist)}` +
      `  ATR=${fmt(tf.atr, 1)}${adxPart}`
    );
  }

  lines.push(``, `PRIMARY ATR: H1=${fmt(atr?.h1, 1)}  M30=${fmt(atr?.m30, 1)}`);

  // H1 candle structure
  const candles = marketData.h1Candles;
  if (Array.isArray(candles) && candles.length > 0) {
    lines.push(``, `H1 CANDLES (last ${candles.length}, newest first):`);
    for (const cv of candles) {
      const rng = (cv.high - cv.low).toFixed(2);
      lines.push(`  ${cv.datetime}  O:${cv.open.toFixed(2)}  H:${cv.high.toFixed(2)}  L:${cv.low.toFixed(2)}  C:${cv.close.toFixed(2)}  rng:${rng}`);
    }
    const summary = h1StructureSummary(candles);
    if (summary) lines.push(`H1 structure: ${summary}`);
  }

  // Session range
  if (marketData.sessionRange) {
    lines.push(``, marketData.sessionRange);
  }

  // DXY (US Dollar Index) bias
  const dxy = marketData.dxyBias;
  if (dxy) {
    lines.push(
      ``,
      `DXY (US Dollar Index):`,
      `- Current bias: ${dxy.bias}`,
      dxy.dxy_price    != null ? `- Price: ${dxy.dxy_price.toFixed(3)}`                                 : `- Price: n/a`,
      dxy.dxy_change_pct != null ? `- Change (3H): ${dxy.dxy_change_pct >= 0 ? '+' : ''}${dxy.dxy_change_pct.toFixed(3)}%` : `- Change (3H): n/a`,
      `- Note: Gold and DXY are inversely correlated. Rising DXY = headwind for gold longs, tailwind for gold shorts.`,
    );
  }

  if (marketData.atrCaveat) {
    lines.push(
      ``,
      `⚠️  Note: short-timeframe ATR (esp. H1) appears understated — the volatility lookback is still normalizing after a market closure. RSI/MACD are unaffected; only treat ATR-based stop sizing with caution and consider using H4 ATR as the volatility reference until H1 normalizes.`
    );
  }

  return lines.join('\n');
}

function formatProposal(proposal) {
  const rr = (proposal.target - proposal.entry) / (proposal.entry - proposal.stop);
  return [
    `MECHANICAL PROPOSAL:`,
    `  direction : ${proposal.direction}`,
    `  entry     : ${fmt(proposal.entry)}`,
    `  stop      : ${fmt(proposal.stop)}  (${fmt(Math.abs(proposal.entry - proposal.stop), 1)} pts from entry)`,
    `  target    : ${fmt(proposal.target)}  (${fmt(Math.abs(proposal.target - proposal.entry), 1)} pts from entry)`,
    `  R:R       : ${fmt(Math.abs(rr), 2)}:1`,
    `  lots      : ${proposal.lots}`,
  ].join('\n');
}

function formatOpenPositions(positions, accountBalance) {
  const maxRisk = accountBalance * 0.10;
  let usedRisk = 0;
  const posLines = [];

  for (const p of positions) {
    const posRisk = Math.abs(p.entryPrice - p.stopLoss) * (p.lots || 0.01) * VALUE_PER_LOT;
    usedRisk += posRisk;
    const status = p.entryTriggered ? 'active' : 'pending fill';
    posLines.push(
      `  ${p.direction}  entry=${fmt(p.entryPrice)}  stop=${fmt(p.stopLoss)}` +
      `  target=${fmt(p.target)}  lots=${fmt(p.lots, 2)}` +
      `  risk=$${posRisk.toFixed(0)}  [${status}]`
    );
  }

  const usedPct    = (usedRisk / accountBalance * 100).toFixed(1);
  const remainPct  = Math.max(0, 10.0 - usedRisk / accountBalance * 100).toFixed(1);
  const budgetLine = `RISK BUDGET: $${usedRisk.toFixed(0)} used / $${maxRisk.toFixed(0)} limit` +
                     ` (${usedPct}% used, ${remainPct}% of 10% remaining)`;

  if (positions.length === 0) return `OPEN POSITIONS: none\n${budgetLine}`;
  return [`OPEN POSITIONS (${positions.length}):`, ...posLines, budgetLine].join('\n');
}

function formatLessons(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return 'No lessons recorded yet.';
  }
  return lessons.map((l, i) => {
    const flags = [
      l.pinned    ? 'PINNED'    : null,
      l.recurring ? 'RECURRING' : null,
    ].filter(Boolean);
    const flagStr = flags.length ? ` — ${flags.join(' & ')}` : '';
    return `${i + 1}. [${l.entry_type}${flagStr}] ${l.lesson_text} (tag: ${l.tag})`;
  }).join('\n');
}

// ── Decider ──────────────────────────────────────────────────────────────

export async function decide(marketData, atr, portfolio, recentLessons, mechanicalProposal = null, openPositions = null, session = null) {
  // Nothing to overlay when mechanical did not produce a trade.
  if (!mechanicalProposal || mechanicalProposal.action !== 'TRADE') {
    return {
      action:    'NO_TRADE',
      direction: null,
      entry:     null,
      stop:      null,
      target:    null,
      lots:      null,
      reasoning: 'no mechanical trade proposal this cycle — nothing to overlay',
      tag:       'overlay_no_proposal'
    };
  }

  const userContent = [
    formatSnapshot(marketData, atr, portfolio, session),
    '',
    formatOpenPositions(openPositions, portfolio.current_balance),
    '',
    formatProposal(mechanicalProposal),
    '',
    `RECENT LESSONS (${recentLessons?.length ?? 0}):`,
    formatLessons(recentLessons),
    '',
    `Review the proposal above. Approve (TRADE), resize (TRADE with adjusted levels), or reject (VETO)?`,
  ].join('\n');

  const decision = await callDecider({ systemPrompt: SYSTEM, userContent, deciderName: 'overlay' });

  // For VETO: backfill mechanical params so the shadow has a trade to track.
  if (decision.action === 'VETO') {
    decision.direction = decision.direction ?? mechanicalProposal.direction;
    decision.entry     = decision.entry     ?? mechanicalProposal.entry;
    decision.stop      = decision.stop      ?? mechanicalProposal.stop;
    decision.target    = decision.target    ?? mechanicalProposal.target;
    decision.lots      = decision.lots      ?? mechanicalProposal.lots;
  }

  return decision;
}
