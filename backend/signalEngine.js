import { VALUE_PER_LOT } from './contractSpec.js';

// ── Stops and targets (24 Sep 2026) ──────────────────────────────────────
// Set a priori, not fitted: 1.5x H1 ATR is roughly double the old median
// stop (0.82x ATR, i.e. inside one hour's noise), and 1.5R is the planned
// R:R Overlay already runs at. Mechanical proposals feed Overlay and Hybrid,
// so they see these levels too. Confounded with the 22 Sep gate change
// (4 -> 5): both alter mechanical, and results from here can't separate them.
export const STOP_ATR_MULT = 1.5;
export const TARGET_R      = 1.5;
export const ROUND_STEP    = 5;    // $5 levels
export const ROUND_BUFFER  = 1.5;  // keep stops at least $1.50 off a $5 level

// ── Entry gate: score, not unanimity ─────────────────────────────────────
//
// The six directional conditions were previously an AND gate — all six had to
// be true in the same 5-minute cycle. That made the engine wait for perfect
// alignment, which in a stair-step trend arrives only after the move. Measured
// over 7-11 Sep, 593 signals were blocked while gold fell steadily:
//
//   h1_rsi_bearish      418  (70%)   ← H1 RSI popped back above 48 on bounces
//   m30_macd_negative   412  (69%)   ← M30 MACD flipped positive on bounces
//   h1_macd_negative    329  (55%)
//   m30_rsi_ok           97  (16%)
//   m15_rsi_range        61  (10%)
//   h4_macd_ok            0   (0%)   ← never once the blocker
//
// Notably H4 was never the constraint, despite being the suspected cause. The
// binding conditions were H1 and M30 confirmation, and every retracement broke
// them. Requiring 4 of 6 rather than 6 of 6 lets the engine fire during a move
// instead of only at the moment everything agrees.
//
// Env-overridable so the threshold can be tightened back toward 6 without a
// code change if frequency proves too high.
// Default raised 4 -> 5 on 22 Sep after ten days of live results. Mechanical's
// trades since the gate went in, split by the score that produced them:
//
//   4/6   n=42   net -19,141   avg -456   WR 36%
//   5/6   n=70   net +10,155   avg +145   WR 59%
//   6/6   n=48   net -21,347   avg -445   WR 33%
//
// Both ends lose and only 5 makes money, which also means reverting to the
// original six-of-six gate would NOT have saved the period -- it lost 21,347
// over the same window, just on fewer trades. The plausible mechanism: at 4 the
// signal fires before confirmation, at 6 every timeframe has aligned and the
// move is already extended, so the entry lands near exhaustion. 5 is the band
// with confirmation and room left.
//
// Honest status: fitted to ten days. The win-rate spread (36/59/33) is wide
// enough to look real, but this is a choice between three directly observed
// options rather than a demonstrated edge. Env-overridable precisely so it can
// be moved again without a deploy.
export const SIGNAL_MIN_SCORE = Math.min(6, Math.max(1, Number(process.env.SIGNAL_MIN_SCORE ?? 5)));

// Two of the six conditions are direction-agnostic and can be true for LONG
// and SHORT simultaneously: h4_macd_ok (long wants > -1.0, short wants < 1.0 —
// both hold between them) and m15_rsi_range (identical text in both). Under the
// old AND gate that was harmless, since all six could not pass both ways. With
// a threshold of 4 they can, so the winning direction must also strictly beat
// the other. A tie means the timeframes genuinely disagree — no trade.
export function pickDirection(longCheck, shortCheck, minScore = SIGNAL_MIN_SCORE) {
  const l = longCheck.score, s = shortCheck.score;
  if (l >= minScore && l > s) return 'LONG';
  if (s >= minScore && s > l) return 'SHORT';
  return null;
}

class SignalEngine {
  constructor() {
    this.lastSignal = null;
  }

  analyzeTimeframe(data, timeframe) {
    const { rsi, macd, macd_signal } = data;
    
    // Determine trend direction
    const macdPositive = macd > 0;
    const macdBullish = macd > macd_signal;
    const rsiBullish = rsi > 50;
    const rsiBearish = rsi < 50;
    const rsiOverbought = rsi > 70;
    const rsiOversold = rsi < 30;
    
    return {
      timeframe,
      rsi,
      macd,
      macd_signal,
      macdPositive,
      macdBullish,
      rsiBullish,
      rsiBearish,
      rsiOverbought,
      rsiOversold,
      trend: macdPositive && rsiBullish ? 'bullish' : 
             !macdPositive && rsiBearish ? 'bearish' : 'neutral'
    };
  }

  checkLongConditions(h4, h1, m30, m15, currentPrice) {
    const conditions = {
      h4_macd_ok: h4.macd > -1.0,  // Not strongly bearish
      h1_macd_positive: h1.macd > 0.5,  // Strong bullish
      h1_rsi_bullish: h1.rsi > 52,
      m30_macd_positive: m30.macd > 0,
      m30_rsi_ok: m30.rsi < 65,  // Not overbought
      m15_rsi_range: m15.rsi > 30 && m15.rsi < 70  // Not extreme
    };

    const score = Object.values(conditions).filter(c => c).length;

    return {
      // Retained for callers that only ask "was this unanimous?" — the score
      // is what the gate now uses.
      valid: score === Object.keys(conditions).length,
      score,
      conditions,
      direction: 'LONG',
      failedConditions: Object.entries(conditions)
        .filter(([_, passed]) => !passed)
        .map(([name]) => name)
    };
  }

  checkShortConditions(h4, h1, m30, m15, currentPrice) {
    const conditions = {
      h4_macd_ok: h4.macd < 1.0,  // Not strongly bullish
      h1_macd_negative: h1.macd < -0.5,  // Strong bearish
      h1_rsi_bearish: h1.rsi < 48,
      m30_macd_negative: m30.macd < 0,
      m30_rsi_ok: m30.rsi > 35,  // Not oversold
      m15_rsi_range: m15.rsi > 30 && m15.rsi < 70  // Not extreme
    };

    const score = Object.values(conditions).filter(c => c).length;

    return {
      // Retained for callers that only ask "was this unanimous?" — the score
      // is what the gate now uses.
      valid: score === Object.keys(conditions).length,
      score,
      conditions,
      direction: 'SHORT',
      failedConditions: Object.entries(conditions)
        .filter(([_, passed]) => !passed)
        .map(([name]) => name)
    };
  }

  calculatePositionSize(accountBalance, entryPrice, stopLoss, riskPercent = 2) {
    const riskAmount = accountBalance * (riskPercent / 100);
    const pointRisk  = Math.abs(entryPrice - stopLoss);

    // lots = riskAmount / (stopDistance × VALUE_PER_LOT)
    // e.g. $100k account, 2% risk = $2,000, 20pt stop:
    //   lots = 2000 / (20 × 100) = 1.0 lot → risk verified = 1.0×20×100 = $2,000 ✓
    const rawLots   = riskAmount / (pointRisk * VALUE_PER_LOT);
    const finalLots = Math.max(0.01, Math.min(Math.floor(rawLots * 100) / 100, 1.0));

    const actualRisk = finalLots * pointRisk * VALUE_PER_LOT;
    return {
      lots:           finalLots,
      riskAmount:     actualRisk,
      riskPercent:    (actualRisk / accountBalance) * 100,
      pointRisk,
      potentialProfit: 0  // filled in by caller with target
    };
  }

  // Old placeholder, kept only as the fallback distance when H1 ATR is missing.
  // It sized stops off H4 MACD histogram (not a volatility measure) and
  // rounded both levels outward to $5, so every one of 964 mechanical stops
  // sat on an exact $5 level and targets mirrored stops (median planned R:R
  // 0.99). Stops were a median 0.82x H1 ATR — inside one hour's normal noise.
  findSupportResistance(h4Data, h1Data, currentPrice) {
    const volatility = Math.abs(h4Data.macd_hist) * 2;
    const baseDistance = Math.max(8, volatility);
    return {
      support: Math.floor((currentPrice - baseDistance) / 5) * 5,
      resistance: Math.ceil((currentPrice + baseDistance) / 5) * 5
    };
  }

  // Stop and target for a chosen direction (24 Sep 2026).
  //   stop:   STOP_ATR_MULT x H1 ATR from entry, then pushed past any $5 round
  //           level it lands within ROUND_BUFFER of — round numbers are where
  //           stops cluster and get swept.
  //   target: TARGET_R x the final stop distance, so R:R is fixed by design.
  // Position size still comes from 2% risk on the stop distance, so a wider
  // stop means fewer lots, not more dollars at risk.
  placeStopTarget(direction, entry, h1Atr, fallbackDistance) {
    const sign = direction === 'LONG' ? -1 : 1;           // stop side
    const dist = Number.isFinite(h1Atr) && h1Atr > 0 ? STOP_ATR_MULT * h1Atr : fallbackDistance;
    let stop = entry + sign * dist;
    const round = Math.round(stop / ROUND_STEP) * ROUND_STEP;
    if (Math.abs(stop - round) < ROUND_BUFFER) stop = round + sign * ROUND_BUFFER;
    const risk = Math.abs(entry - stop);
    const target = entry - sign * TARGET_R * risk;
    const r2 = v => Math.round(v * 100) / 100;
    return { stop: r2(stop), target: r2(target), usedAtr: dist !== fallbackDistance };
  }

  generateSignal(marketData, accountBalance = 400) {
    console.log('\n🔍 ANALYZING MARKET CONDITIONS...\n');
    
    const { h4, h1, m30, m15 } = marketData;
    const currentPrice = h1.price || m30.price;
    
    // Analyze each timeframe
    const h4Analysis = this.analyzeTimeframe(h4, 'H4');
    const h1Analysis = this.analyzeTimeframe(h1, 'H1');
    const m30Analysis = this.analyzeTimeframe(m30, 'M30');
    const m15Analysis = this.analyzeTimeframe(m15, 'M15');
    
    // Check both long and short conditions
    const longCheck = this.checkLongConditions(h4Analysis, h1Analysis, m30Analysis, m15Analysis, currentPrice);
    const shortCheck = this.checkShortConditions(h4Analysis, h1Analysis, m30Analysis, m15Analysis, currentPrice);
    
    // Find support/resistance for stops and targets
    const { support, resistance } = this.findSupportResistance(h4, h1, currentPrice);
    
    let signal = {
      timestamp: new Date().toISOString(),
      signal: 'RED',
      currentPrice,
      accountBalance,
      timeframes: {
        h4: h4Analysis,
        h1: h1Analysis,
        m30: m30Analysis,
        m15: m15Analysis
      },
      marketData: { h4, h1, m30, m15 }
    };
    
    const chosen = pickDirection(longCheck, shortCheck);
    signal.long_score  = longCheck.score;
    signal.short_score = shortCheck.score;
    signal.min_score   = SIGNAL_MIN_SCORE;

    if (chosen === 'LONG') {
      const entry = currentPrice;
      const { stop, target } = this.placeStopTarget('LONG', entry, h1.atr, entry - support);
      const positionSize = this.calculatePositionSize(accountBalance, entry, stop);

      // Was `* 10`, which understated profit (and R:R) 10x against VALUE_PER_LOT.
      positionSize.potentialProfit = (target - entry) * positionSize.lots * VALUE_PER_LOT;
      
      signal.signal = 'GREEN';
      signal.recommendation = {
        direction: 'LONG',
        entry: entry,
        stop: stop,
        target: target,
        positionSize: positionSize.lots,
        riskAmount: positionSize.riskAmount,
        riskPercent: positionSize.riskPercent,
        potentialProfit: positionSize.potentialProfit,
        riskReward: positionSize.potentialProfit / positionSize.riskAmount,
        confidence: 'HIGH',
        reasoning: `long score ${longCheck.score}/6 (min ${SIGNAL_MIN_SCORE}) vs short ${shortCheck.score}/6`
      };
    } else if (chosen === 'SHORT') {
      const entry = currentPrice;
      const { stop, target } = this.placeStopTarget('SHORT', entry, h1.atr, resistance - entry);
      const positionSize = this.calculatePositionSize(accountBalance, entry, stop);

      positionSize.potentialProfit = (entry - target) * positionSize.lots * VALUE_PER_LOT;
      
      signal.signal = 'GREEN';
      signal.recommendation = {
        direction: 'SHORT',
        entry: entry,
        stop: stop,
        target: target,
        positionSize: positionSize.lots,
        riskAmount: positionSize.riskAmount,
        riskPercent: positionSize.riskPercent,
        potentialProfit: positionSize.potentialProfit,
        riskReward: positionSize.potentialProfit / positionSize.riskAmount,
        confidence: 'HIGH',
        reasoning: `short score ${shortCheck.score}/6 (min ${SIGNAL_MIN_SCORE}) vs long ${longCheck.score}/6`
      };
    } else {
      // RED signal - explain why
      const reasons = [`scores L${longCheck.score}/S${shortCheck.score} (min ${SIGNAL_MIN_SCORE}, strict winner required)`];
      if (longCheck.failedConditions.length > 0) {
        reasons.push(`Long failed: ${longCheck.failedConditions.join(', ')}`);
      }
      if (shortCheck.failedConditions.length > 0) {
        reasons.push(`Short failed: ${shortCheck.failedConditions.join(', ')}`);
      }
      
      signal.reason = reasons.join(' | ');
    }
    
    this.lastSignal = signal;
    
    this.printSignalSummary(signal);
    
    return signal;
  }

  printSignalSummary(signal) {
    console.log('\n' + '='.repeat(50));
    console.log(`🚦 SIGNAL: ${signal.signal === 'GREEN' ? '🟢 GREEN LIGHT' : '🔴 RED LIGHT'}`);
    console.log('='.repeat(50));
    
    if (signal.signal === 'GREEN') {
      const rec = signal.recommendation;
      console.log(`\n📈 DIRECTION: ${rec.direction}`);
      console.log(`💰 ENTRY: ${rec.entry.toFixed(2)}`);
      console.log(`🛑 STOP: ${rec.stop.toFixed(2)} (${Math.abs(rec.entry - rec.stop).toFixed(1)} points)`);
      console.log(`🎯 TARGET: ${rec.target.toFixed(2)} (${Math.abs(rec.target - rec.entry).toFixed(1)} points)`);
      console.log(`\n📊 POSITION: ${rec.positionSize} lot`);
      console.log(`⚠️  RISK: $${rec.riskAmount.toFixed(2)} (${rec.riskPercent.toFixed(2)}%)`);
      console.log(`💵 POTENTIAL: $${rec.potentialProfit.toFixed(2)}`);
      console.log(`📊 R:R: ${rec.riskReward.toFixed(2)}:1`);
      console.log(`⭐ CONFIDENCE: ${rec.confidence}`);
    } else {
      console.log(`\n❌ REASON: ${signal.reason}`);
    }
    
    console.log('\n📊 TIMEFRAMES:');
    console.log(`H4:  MACD: ${signal.timeframes.h4.macd.toFixed(2)} | RSI: ${signal.timeframes.h4.rsi.toFixed(1)}`);
    console.log(`H1:  MACD: ${signal.timeframes.h1.macd.toFixed(2)} | RSI: ${signal.timeframes.h1.rsi.toFixed(1)}`);
    console.log(`M30: MACD: ${signal.timeframes.m30.macd.toFixed(2)} | RSI: ${signal.timeframes.m30.rsi.toFixed(1)}`);
    console.log(`M15: MACD: ${signal.timeframes.m15.macd.toFixed(2)} | RSI: ${signal.timeframes.m15.rsi.toFixed(1)}`);
    console.log('='.repeat(50) + '\n');
  }
}

export default new SignalEngine();
