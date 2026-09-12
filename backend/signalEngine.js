import { VALUE_PER_LOT } from './contractSpec.js';

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
export const SIGNAL_MIN_SCORE = Math.min(6, Math.max(1, Number(process.env.SIGNAL_MIN_SCORE ?? 4)));

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

  findSupportResistance(h4Data, h1Data, currentPrice) {
    // Simple support/resistance based on recent price action
    // In production, this would analyze price structure more thoroughly
    
    const volatility = Math.abs(h4Data.macd_hist) * 2;
    const baseDistance = Math.max(8, volatility);
    
    return {
      support: Math.floor((currentPrice - baseDistance) / 5) * 5,
      resistance: Math.ceil((currentPrice + baseDistance) / 5) * 5
    };
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
      const stop = support;
      const target = resistance;
      const positionSize = this.calculatePositionSize(accountBalance, entry, stop);
      
      positionSize.potentialProfit = (target - entry) * positionSize.lots * 10;
      
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
      const stop = resistance;
      const target = support;
      const positionSize = this.calculatePositionSize(accountBalance, entry, stop);
      
      positionSize.potentialProfit = (entry - target) * positionSize.lots * 10;
      
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
