// claudeSoloDecider — Claude generates its own trade ideas from scratch,
// independent of the mechanical signal.  Receives ONLY the market snapshot
// and account state (NOT the mechanical proposal).
//
// TODO (Phase 3): recentLessons will be populated from the journal store.
//   Wire the parameter through now; the prompt already has a lessons section.

import { callDecider } from './claudeClient.js';
import { VALUE_PER_LOT } from '../contractSpec.js';

// ── System prompt (static → prompt-cached after first call) ─────────────

const SYSTEM = `\
You are a discretionary gold (XAU/USD) day trader managing a paper-trading account. \
You make independent trading decisions based on multi-timeframe technical analysis. \
You have no knowledge of any mechanical trading system — you must reach your own conclusions.

## Your Role
Each cycle you receive a five-timeframe market snapshot (H4/H1/M30/M15/M5) for XAU/USD. \
You decide:
- TRADE LONG: buy gold with specific entry, stop, target, and lot size
- TRADE SHORT: sell gold with specific entry, stop, target, and lot size
- NO_TRADE: sit out this cycle if conditions are unclear or unfavorable

## Instrument Specification
- Instrument: XAU/USD (spot gold)
- 1 standard lot = 100 troy ounces = USD 100 P&L per $1 price move per lot
- Account currency: USD
- Session: NY open (approximately 08:30–12:30 UTC), gold's highest-liquidity daily window
- Typical intraday range: 1–3× H1 ATR (use H1 ATR to calibrate realistic targets)
- ATR(14) provided for each timeframe — use for stop and target sizing

## Analysis Framework — Top-Down Approach

### Step 1 — Establish bias (H4):
- H4 MACD positive + RSI above 50: bullish bias
- H4 MACD negative + RSI below 50: bearish bias
- Mixed or neutral H4: reduce conviction; only trade with multiple confirming timeframes

### Step 2 — Confirm entry direction (H1):
- H1 MACD and RSI must agree with H4 bias for high-conviction trade
- H1 RSI 45–65 for LONG, 35–55 for SHORT is the healthy entry zone
- H1 RSI > 70 (overbought) or < 30 (oversold) signals potential reversal — avoid entries \
  in the extension direction

### Step 3 — Refine timing (M30/M15/M5):
- Look for M30/M15 momentum aligning with H1 direction
- M5 confirmation (MACD histogram turning positive for LONG) for precise entry timing
- Divergence warning: if M15/M5 is exhausted (RSI extending, MACD histogram fading) \
  while H1 still looks bullish, wait for a pullback entry

### Step 4 — Size and place levels:
- Entry: current price (market order), or a limit within 0.5× M5 ATR of current price
- Stop: place 1.5× H1 ATR from entry (can tighten to 1.0× on very clean setups)
- Target: minimum 1.5× stop distance (1.5:1 R:R); aim for 2:1 when conditions allow
- Lot size: (accountBalance × 0.02) / (stopDistancePoints × 100)
  Minimum: 0.01 lot | Maximum: 1.0 lot

### When to choose NO_TRADE:
- H4 and H1 are contradictory (H4 bullish, H1 bearish, or vice versa)
- RSI is extreme on H1 but MACD is lagging — whipsaw risk
- All timeframes are near RSI 50 and MACD near zero — no trend, no edge
- The session is clearly ranging rather than trending (flat MACD histograms across timeframes)

## Risk Principles
- Never risk more than 2% of account balance on a single trade
- Aim for at minimum 1.5:1 R:R; target 2:1 when the setup is clean
- Use NO_TRADE sparingly — reserve it for genuinely unclear or contradictory conditions, not for marginal-but-reasonable setups
- When you have a defensible directional read and acceptable R:R, take the trade rather than defaulting to inaction

## Common Gold Day-Trading Patterns
- **Momentum continuation**: H4 strong trend + H1 pullback to MACD zero-cross + M15 \
  bounce. High-probability entry after a healthy retrace.
- **NY session surge**: MACD histograms expanding across H1/M30/M15 in the opening \
  30 minutes. Enter early with a tight stop below the first candle's low (LONG) or \
  above the first candle's high (SHORT).
- **RSI failure swing**: H1 RSI fails to reach prior overbought high while price makes \
  a new high — bearish divergence. Consider SHORT even if MACD is still positive.
- **Range breakout**: H4 MACD near zero but M30/M15 showing expanding histogram after \
  a tight consolidation. Enter on the breakout candle's close with stop inside the range.

## Output — STRICT JSON ONLY
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE",
  "direction": "LONG" | "SHORT" | null,
  "entry": <number or null>,
  "stop": <number or null>,
  "target": <number or null>,
  "lots": <number or null>,
  "reasoning": "<1–3 sentences for the trade journal — your analysis and rationale>",
  "tag": "<snake_case label, e.g. h1_momentum_long, ny_open_short, no_trend_pass>"
}

For TRADE: all numeric fields must be present and valid.
  LONG: stop < entry < target (strictly)
  SHORT: target < entry < stop (strictly)
For NO_TRADE: set direction, entry, stop, target, lots to null.
reasoning and tag are both mandatory — they feed the journal.`;

// ── Market-data formatter ────────────────────────────────────────────────

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
  return lessons.map((l, i) =>
    `${i + 1}. [${l.entry_type}${l.recurring ? ' — RECURRING' : ''}] ${l.lesson_text} (tag: ${l.tag})`
  ).join('\n');
}

// ── Decider ──────────────────────────────────────────────────────────────

export async function decide(marketData, atr, portfolio, recentLessons, openPositions = null, _p6 = null, session = null) {
  const userContent = [
    formatSnapshot(marketData, atr, portfolio, session),
    '',
    formatOpenPositions(openPositions, portfolio.current_balance),
    '',
    `RECENT LESSONS (${recentLessons?.length ?? 0}):`,
    formatLessons(recentLessons),
    '',
    `What is your trading decision for this cycle?`,
  ].join('\n');

  return await callDecider({ systemPrompt: SYSTEM, userContent, deciderName: 'solo' });
}
