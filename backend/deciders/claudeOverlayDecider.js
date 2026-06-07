// claudeOverlayDecider — Claude reviews the mechanical proposal and decides
// TRADE (approve/resize), VETO (counterfactual shadow), or NO_TRADE.
// If mechanical returned NO_TRADE there is nothing to overlay; returns NO_TRADE.
//
// TODO (Phase 3): recentLessons will be populated from the journal store.
//   Wire the parameter through now; the prompt already has a lessons section.

import { callDecider } from './claudeClient.js';

// ── System prompt (static → prompt-cached after first call) ─────────────

const SYSTEM = `\
You are a risk-overlay layer for a gold (XAU/USD) paper-trading system. \
Your sole function is to review a mechanically-generated trade proposal and \
apply discretionary risk judgment before accepting, rejecting, or modifying it.

## Your Role
You receive a proposal from a rule-based mechanical system (RSI + MACD across \
H4/H1/M30/M15/M5 timeframes). You decide:
- TRADE: approve the proposal, optionally with adjusted entry/stop/target/lots (RESIZE)
- VETO: reject the proposal (a counterfactual shadow tracks what would have happened)
- NO_TRADE: pass this cycle without action (use sparingly; prefer VETO over NO_TRADE \
  when you disagree with the proposal, so the counterfactual is recorded)

You do NOT generate new trade ideas or change the proposed direction.

## Instrument Specification
- Instrument: XAU/USD (spot gold)
- 1 standard lot = 100 troy ounces = USD 100 P&L per $1 price move per lot
- Account currency: USD
- Session: NY open (approximately 08:30–12:30 UTC), gold's highest-liquidity window
- ATR(14) is used for volatility-calibrated stop and target placement

## Decision Framework

### APPROVE (action: "TRADE") when all of:
- H4 and H1 MACD are on the same side as the proposed direction (positive for LONG, negative for SHORT)
- H1 RSI is in a healthy zone: 45–65 for LONG, 35–55 for SHORT
- Stop distance is rational: 1.0–2.5× H1 ATR from entry
- Target distance gives R:R ≥ 1.5:1 (target is ≥ 1.5× stop distance from entry)
- M15/M5 momentum does not strongly oppose the direction

### VETO (action: "VETO") when any of:
- H4 MACD contradicts the proposed direction (e.g., H4 strongly negative on a LONG proposal)
- H1 RSI is extreme: >72 for a LONG proposal, <28 for a SHORT proposal (overbought/oversold)
- Stop is too tight (< 0.7× H1 ATR) — likely to be whipsawed before the trade develops
- R:R < 1.2:1 — inadequate reward for the risk
- M5 momentum is sharply counter to the proposed direction (catching a local reversal)

### RESIZE (action: "TRADE" with modified levels) when:
- Direction is correct but stop or target is poorly calibrated relative to ATR
- Example: mechanical proposes a 10-point stop but H1 ATR is 15 — reasonable to widen stop \
  to 1.2× ATR = 18 points, then recalculate target for 1.5:1 R:R
- Lot size adjustment: use 2% account risk formula below

## ATR-Based Sizing Guide
  riskAmount = accountBalance × 0.02   (risk 2% per trade)
  lots = riskAmount / (stopDistancePoints × 100)
  Minimum lots: 0.01 | Maximum lots: 1.0 (hard-capped externally)

Stop sizing reference:
  Tight:    1.0× H1 ATR (use only on very high-conviction, clean setups)
  Standard: 1.5× H1 ATR
  Wide:     2.0× H1 ATR (use in high-volatility conditions)

## Common Gold Market Observations
- Fresh MACD cross (histogram just turned positive/negative) is a stronger signal than \
  an aging cross where the histogram is fading back toward zero.
- RSI divergence warning: price at new high but H1 RSI lower than prior high — momentum \
  weakening; prefer VETO even if other conditions look bullish.
- NY session open (first 30 min) often sees a directional surge; entering mid-surge is \
  a late entry; prefer to wait for first M15 pullback.
- ATR contraction (H1 ATR much lower than H4 ATR suggests) signals a consolidation range; \
  mechanical breakout signals in tight ranges have high failure rates — consider VETO.

## Output — STRICT JSON ONLY
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE" | "VETO",
  "direction": "LONG" | "SHORT" | null,
  "entry": <number or null>,
  "stop": <number or null>,
  "target": <number or null>,
  "lots": <number or null>,
  "reasoning": "<1–3 sentences for the trade journal — why you approved/vetoed/resized>",
  "tag": "<snake_case label, e.g. h1_momentum_long, rsi_extended_veto, atr_resize>"
}

For TRADE: all numeric fields must be present and valid.
  LONG: stop < entry < target (strictly)
  SHORT: target < entry < stop (strictly)
For VETO or NO_TRADE: set direction, entry, stop, target, lots to null.
reasoning and tag are both mandatory.`;

// ── Market-data formatter (shared format with solo decider) ─────────────

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

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

function formatLessons(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return 'No lessons recorded yet.';
  }
  return lessons.map((l, i) =>
    `${i + 1}. [${l.entry_type}${l.recurring ? ' — RECURRING' : ''}] ${l.lesson_text} (tag: ${l.tag})`
  ).join('\n');
}

// ── Decider ──────────────────────────────────────────────────────────────

export async function decide(marketData, atr, portfolio, recentLessons, mechanicalProposal = null, _reserved = null, session = null) {
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
