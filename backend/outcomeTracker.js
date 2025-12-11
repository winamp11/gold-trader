import twelveData from './twelveData.js';
import database from './database.js';
import { isTradingHours } from './tradingHours.js';

class OutcomeTracker {
  constructor() {
    this.activeTracking = new Map(); // signalId -> tracking data
    this.monitoringInterval = null;
  }

  startTracking(signalId, signalData) {
    const { recommendation, signal, currentPrice, timestamp } = signalData;

    if (signal === 'GREEN' && recommendation) {
      // Track GREEN signals: monitor entry/stop/target
      this.activeTracking.set(signalId, {
        signalId,
        type: 'GREEN',
        direction: recommendation.direction,
        startPrice: currentPrice,
        entryPrice: recommendation.entry,
        stopLoss: recommendation.stop,
        target: recommendation.target,
        startTime: new Date(timestamp),
        entryTriggered: false,
        outcome: null,
        maxPrice: currentPrice,
        minPrice: currentPrice
      });
    } else if (signal === 'RED') {
      // Track RED signals: detect missed opportunities
      this.activeTracking.set(signalId, {
        signalId,
        type: 'RED',
        startPrice: currentPrice,
        startTime: new Date(timestamp),
        maxPrice: currentPrice,
        minPrice: currentPrice,
        outcome: null
      });
    }

    console.log(`📊 Started tracking signal ${signalId} (${signal})`);

    // Start monitoring if not already running
    if (!this.monitoringInterval) {
      this.startMonitoring();
    }
  }

  startMonitoring() {
    // Check every 30 minutes for cleanup only (no API calls)
    this.monitoringInterval = setInterval(() => {
      this.checkAllSignals();
    }, 30 * 60 * 1000);

    console.log('👁️  Outcome monitoring started (cleanup checks every 30 minutes)');
  }

  async checkAllSignals() {
    if (this.activeTracking.size === 0) return;

    // Skip if outside trading hours
    if (!isTradingHours()) {
      console.log('⏸️  Outcome tracking paused (outside trading hours)');
      return;
    }

    // NOTE: We don't fetch market data here anymore
    // Outcome tracking now happens when signals are generated
    // This method is kept for cleanup only
    
    const now = new Date();
    
    for (const [signalId, tracking] of this.activeTracking) {
      const ageInHours = (now - tracking.startTime) / (1000 * 60 * 60);
      
      // Expire old signals that haven't been resolved
      if (ageInHours >= 4 && !tracking.outcome) {
        this.finalizeSignal(tracking, 'EXPIRED');
      }
    }
  }

  // New method: Check outcomes using current price from signal generation
  checkOutcomesWithPrice(currentPrice) {
    if (this.activeTracking.size === 0) return;
    
    console.log(`\n🔍 Checking ${this.activeTracking.size} active signals at price ${currentPrice}...`);
    
    const now = new Date();
    
    for (const [signalId, tracking] of this.activeTracking) {
      const ageInHours = (now - tracking.startTime) / (1000 * 60 * 60);

      // Update price ranges
      tracking.maxPrice = Math.max(tracking.maxPrice, currentPrice);
      tracking.minPrice = Math.min(tracking.minPrice, currentPrice);

      if (tracking.type === 'GREEN') {
        this.checkGreenSignal(tracking, currentPrice, ageInHours);
      } else if (tracking.type === 'RED') {
        this.checkRedSignal(tracking, currentPrice, ageInHours);
      }

      // Stop tracking after 4 hours
      if (ageInHours >= 4 && !tracking.outcome) {
        this.finalizeSignal(tracking, 'EXPIRED');
      }
    }
  }

  checkGreenSignal(tracking, currentPrice, ageInHours) {
    const { direction, entryPrice, stopLoss, target, entryTriggered } = tracking;

    // Check if entry was triggered
    if (!entryTriggered) {
      const entryHit = direction === 'LONG' 
        ? currentPrice <= entryPrice 
        : currentPrice >= entryPrice;

      if (entryHit) {
        tracking.entryTriggered = true;
        tracking.entryTime = new Date();
        console.log(`✅ Entry triggered for signal ${tracking.signalId}`);
      } else if (ageInHours >= 2) {
        // Entry not hit within 2 hours
        this.finalizeSignal(tracking, 'NO_ENTRY');
        return;
      } else {
        return; // Keep waiting for entry
      }
    }

    // Entry was triggered, check stop/target
    if (direction === 'LONG') {
      if (currentPrice <= stopLoss) {
        this.finalizeSignal(tracking, 'STOP_HIT', currentPrice);
      } else if (currentPrice >= target) {
        this.finalizeSignal(tracking, 'TARGET_HIT', currentPrice);
      }
    } else { // SHORT
      if (currentPrice >= stopLoss) {
        this.finalizeSignal(tracking, 'STOP_HIT', currentPrice);
      } else if (currentPrice <= target) {
        this.finalizeSignal(tracking, 'TARGET_HIT', currentPrice);
      }
    }
  }

  checkRedSignal(tracking, currentPrice, ageInHours) {
    const { startPrice, maxPrice, minPrice } = tracking;

    const upMove = maxPrice - startPrice;
    const downMove = startPrice - minPrice;
    const biggestMove = Math.max(upMove, downMove);

    // Consider it a missed opportunity if >15 point move
    if (biggestMove >= 15) {
      const direction = upMove > downMove ? 'UP' : 'DOWN';
      this.finalizeSignal(tracking, 'MISSED_OPPORTUNITY', currentPrice, {
        move: biggestMove.toFixed(1),
        direction
      });
    } else if (ageInHours >= 4) {
      // No significant move, RED was correct
      this.finalizeSignal(tracking, 'CORRECT_RED', currentPrice);
    }
  }

  finalizeSignal(tracking, outcome, exitPrice = null, metadata = {}) {
    tracking.outcome = outcome;
    tracking.endTime = new Date();
    tracking.exitPrice = exitPrice;

    // Calculate P&L for GREEN signals
    let pnl = null;
    if (tracking.type === 'GREEN' && outcome === 'TARGET_HIT') {
      const points = Math.abs(tracking.target - tracking.entryPrice);
      pnl = points * 10 * 0.01; // Rough estimate for 0.01 lot
    } else if (tracking.type === 'GREEN' && outcome === 'STOP_HIT') {
      const points = Math.abs(tracking.entryPrice - tracking.stopLoss);
      pnl = -points * 10 * 0.01;
    }

    // Update database
    database.updateSignalOutcome(tracking.signalId, {
      outcome,
      outcome_timestamp: tracking.endTime.toISOString(),
      outcome_price: exitPrice,
      outcome_pnl: pnl,
      metadata: JSON.stringify(metadata)
    });

    console.log(`✅ Signal ${tracking.signalId} finalized: ${outcome}`);
    if (metadata.move) {
      console.log(`   Missed ${metadata.direction} move of ${metadata.move} points`);
    }

    // Remove from active tracking
    this.activeTracking.delete(tracking.signalId);
  }

  getStats() {
    const stats = {
      activeTracking: this.activeTracking.size,
      signals: Array.from(this.activeTracking.values())
    };
    return stats;
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('👁️  Outcome monitoring stopped');
    }
  }
}

export default new OutcomeTracker();
