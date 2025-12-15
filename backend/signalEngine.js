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

    const allPass = Object.values(conditions).every(c => c);
    
    return {
      valid: allPass,
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

    const allPass = Object.values(conditions).every(c => c);
    
    return {
      valid: allPass,
      conditions,
      direction: 'SHORT',
      failedConditions: Object.entries(conditions)
        .filter(([_, passed]) => !passed)
        .map(([name]) => name)
    };
  }

  calculatePositionSize(accountBalance, entryPrice, stopLoss, riskPercent = 2) {
    const riskAmount = accountBalance * (riskPercent / 100);
    const pointRisk = Math.abs(entryPrice - stopLoss);
    const pointValue = 0.10; // Per 0.01 lot
    
    const optimalLots = riskAmount / (pointRisk * pointValue);
    
    // Round to nearest 0.01 lot
    const lots = Math.floor(optimalLots * 100) / 100;
    
    // Cap at maximum safe size for account
    const maxLots = accountBalance < 500 ? 0.10 : 
                    accountBalance < 1000 ? 0.20 : 0.50;
    
    const finalLots = Math.min(lots, maxLots);
    
    return {
      lots: finalLots,
      riskAmount: finalLots * pointRisk * pointValue,
      riskPercent: (finalLots * pointRisk * pointValue / accountBalance) * 100,
      pointRisk,
      potentialProfit: 0  // Will be calculated with target
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
    
    if (longCheck.valid) {
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
        reasoning: 'All timeframes aligned bullish'
      };
    } else if (shortCheck.valid) {
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
        reasoning: 'All timeframes aligned bearish'
      };
    } else {
      // RED signal - explain why
      const reasons = [];
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
    console.log(`H4:  MACD: ${signal.timeframes.h4.macd.toFixed(2)} | RSI: ${signal.timeframes.h4.rsi.toFixed(1)} | MFI: ${signal.timeframes.h4.mfi.toFixed(1)}`);
    console.log(`H1:  MACD: ${signal.timeframes.h1.macd.toFixed(2)} | RSI: ${signal.timeframes.h1.rsi.toFixed(1)} | MFI: ${signal.timeframes.h1.mfi.toFixed(1)}`);
    console.log(`M30: MACD: ${signal.timeframes.m30.macd.toFixed(2)} | RSI: ${signal.timeframes.m30.rsi.toFixed(1)} | MFI: ${signal.timeframes.m30.mfi.toFixed(1)}`);
    console.log(`M15: MACD: ${signal.timeframes.m15.macd.toFixed(2)} | RSI: ${signal.timeframes.m15.rsi.toFixed(1)} | MFI: ${signal.timeframes.m15.mfi.toFixed(1)}`);
    console.log('='.repeat(50) + '\n');
  }
}

export default new SignalEngine();
