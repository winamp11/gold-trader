import database from './database.js';
import { isTradingHours } from './tradingHours.js';

class OutcomeTracker {
  constructor() {
    // key → tracking  (real positions, all portfolios)
    // key format: `${portfolioId}_${signalId_or_tradeId}`
    this.activeTracking = new Map();

    // key → shadow  (veto counterfactuals, never touch balances)
    // key format: `shadow_${shadowId}`
    this.shadowTracking = new Map();

    this.monitoringInterval = null;
  }

  // ── Real positions ────────────────────────────────────────────────────────

  // tracking shape:
  //   key, portfolioId, portfolioName,
  //   type: 'GREEN'|'RED',
  //   signalId (nullable — only mechanical updates signals table),
  //   tradeId  (nullable — set when a trade row was created),
  //   direction, lots, startPrice, entryPrice, stopLoss, target,
  //   startTime, entryTriggered, outcome, maxPrice, minPrice
  startTracking(key, tracking) {
    this.activeTracking.set(key, tracking);
    console.log(`📊 Tracking started [${tracking.portfolioName}] key=${key} type=${tracking.type}`);
    if (!this.monitoringInterval) this.startMonitoring();
  }

  // ── Shadow positions (VETO counterfactuals) ───────────────────────────────

  // shadow shape:
  //   key, shadowId, portfolioId, portfolioName,
  //   direction, lots, startPrice, entryPrice, stopLoss, target,
  //   startTime, entryTriggered, maxPrice, minPrice
  startShadow(key, shadow) {
    this.shadowTracking.set(key, shadow);
    console.log(`👻 Shadow tracking started [${shadow.portfolioName}] key=${key}`);
  }

  // ── Cleanup interval (no API calls) ──────────────────────────────────────

  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.expireStale();
    }, 30 * 60 * 1000);
    console.log('👁️  Outcome monitoring started (stale-check every 30 minutes)');
  }

  expireStale() {
    if (!isTradingHours()) return;
    const now = new Date();
    for (const [key, tracking] of this.activeTracking) {
      const ageHours = (now - tracking.startTime) / 3600000;
      if (ageHours >= 4 && !tracking.outcome) {
        this.finalizePosition(tracking, 'EXPIRED');
      }
    }
    for (const [key, shadow] of this.shadowTracking) {
      const ageHours = (now - shadow.startTime) / 3600000;
      if (ageHours >= 4) {
        this.finalizeShadow(shadow, 'EXPIRED', null);
      }
    }
  }

  // ── Price-tick evaluation (called by the 1-min poller) ───────────────────

  checkOutcomesWithPrice(currentPrice) {
    const total = this.activeTracking.size + this.shadowTracking.size;
    if (total === 0) return;
    console.log(`\n🔍 Price tick $${currentPrice.toFixed(2)} — ${this.activeTracking.size} positions, ${this.shadowTracking.size} shadows`);

    const now = new Date();

    for (const [, tracking] of this.activeTracking) {
      tracking.maxPrice = Math.max(tracking.maxPrice, currentPrice);
      tracking.minPrice = Math.min(tracking.minPrice, currentPrice);
      const ageHours = (now - tracking.startTime) / 3600000;

      if (tracking.type === 'GREEN') {
        this.checkGreenPosition(tracking, currentPrice, ageHours);
      } else if (tracking.type === 'RED') {
        this.checkRedPosition(tracking, currentPrice, ageHours);
      }
      if (ageHours >= 4 && !tracking.outcome) {
        this.finalizePosition(tracking, 'EXPIRED');
      }
    }

    for (const [, shadow] of this.shadowTracking) {
      shadow.maxPrice = Math.max(shadow.maxPrice, currentPrice);
      shadow.minPrice = Math.min(shadow.minPrice, currentPrice);
      const ageHours = (now - shadow.startTime) / 3600000;
      this.checkShadowPosition(shadow, currentPrice, ageHours);
    }
  }

  // ── GREEN position logic ──────────────────────────────────────────────────

  checkGreenPosition(tracking, currentPrice, ageHours) {
    const { direction, entryPrice, stopLoss, target, entryTriggered } = tracking;

    if (!entryTriggered) {
      const entryHit = direction === 'LONG' ? currentPrice <= entryPrice : currentPrice >= entryPrice;
      if (entryHit) {
        tracking.entryTriggered = true;
        tracking.entryTime = new Date();
        console.log(`✅ Entry triggered [${tracking.portfolioName}] key=${tracking.key}`);
      } else if (ageHours >= 2) {
        this.finalizePosition(tracking, 'NO_ENTRY');
      }
      return;
    }

    if (direction === 'LONG') {
      if (currentPrice <= stopLoss)  this.finalizePosition(tracking, 'STOP_HIT',   currentPrice);
      else if (currentPrice >= target) this.finalizePosition(tracking, 'TARGET_HIT', currentPrice);
    } else {
      if (currentPrice >= stopLoss)  this.finalizePosition(tracking, 'STOP_HIT',   currentPrice);
      else if (currentPrice <= target) this.finalizePosition(tracking, 'TARGET_HIT', currentPrice);
    }
  }

  checkRedPosition(tracking, currentPrice, ageHours) {
    const { startPrice, maxPrice, minPrice } = tracking;
    const biggestMove = Math.max(maxPrice - startPrice, startPrice - minPrice);
    if (biggestMove >= 15) {
      const direction = (maxPrice - startPrice) > (startPrice - minPrice) ? 'UP' : 'DOWN';
      this.finalizePosition(tracking, 'MISSED_OPPORTUNITY', currentPrice, { move: biggestMove.toFixed(1), direction });
    } else if (ageHours >= 4) {
      this.finalizePosition(tracking, 'CORRECT_RED', currentPrice);
    }
  }

  // ── Shadow position logic ─────────────────────────────────────────────────

  checkShadowPosition(shadow, currentPrice, ageHours) {
    const { direction, entryPrice, stopLoss, target, entryTriggered } = shadow;

    if (!entryTriggered) {
      const entryHit = direction === 'LONG' ? currentPrice <= entryPrice : currentPrice >= entryPrice;
      if (entryHit) {
        shadow.entryTriggered = true;
      } else if (ageHours >= 2) {
        this.finalizeShadow(shadow, 'NO_ENTRY', null);
      }
      return;
    }

    if (direction === 'LONG') {
      if (currentPrice <= stopLoss)  this.finalizeShadow(shadow, 'STOP_HIT',   currentPrice);
      else if (currentPrice >= target) this.finalizeShadow(shadow, 'TARGET_HIT', currentPrice);
    } else {
      if (currentPrice >= stopLoss)  this.finalizeShadow(shadow, 'STOP_HIT',   currentPrice);
      else if (currentPrice <= target) this.finalizeShadow(shadow, 'TARGET_HIT', currentPrice);
    }
    if (ageHours >= 4) this.finalizeShadow(shadow, 'EXPIRED', null);
  }

  // ── Finalization ──────────────────────────────────────────────────────────

  finalizePosition(tracking, outcome, exitPrice = null, metadata = {}) {
    tracking.outcome = outcome;
    tracking.endTime = new Date();

    let pnl = null;
    let fillPrice = exitPrice;
    if (outcome === 'TARGET_HIT') fillPrice = tracking.target;
    else if (outcome === 'STOP_HIT') fillPrice = tracking.stopLoss;

    if (tracking.type === 'GREEN' && (outcome === 'TARGET_HIT' || outcome === 'STOP_HIT')) {
      const lots = tracking.lots || 0.01;
      const priceMove = tracking.direction === 'LONG'
        ? fillPrice - tracking.entryPrice
        : tracking.entryPrice - fillPrice;
      pnl = priceMove * 100 * lots;

      const portfolio = database.getPortfolioById(tracking.portfolioId);
      if (portfolio) {
        database.updatePortfolioBalance(portfolio.id, pnl);
        const today = new Date().toISOString().split('T')[0];
        database.upsertDailyPnl(today, portfolio.id, pnl, pnl > 0);
        const newBalance = portfolio.current_balance + pnl;
        console.log(`💰 [${portfolio.name}] P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} → $${newBalance.toFixed(2)}`);
      }
    }

    // Update the signals table for mechanical (signalId is set), not for others
    if (tracking.signalId) {
      database.updateSignalOutcome(tracking.signalId, {
        outcome,
        outcome_timestamp: tracking.endTime.toISOString(),
        outcome_price: fillPrice,
        outcome_pnl: pnl,
        metadata: JSON.stringify(metadata)
      });
    }

    // Update the trade row for any account that has one
    if (tracking.tradeId && (outcome === 'TARGET_HIT' || outcome === 'STOP_HIT')) {
      database.updateTradeExit(tracking.tradeId, {
        exit_price: fillPrice,
        exit_timestamp: tracking.endTime.toISOString(),
        exit_reason: outcome,
        pnl
      });
    }

    console.log(`✅ Position finalized [${tracking.portfolioName}] ${outcome}${metadata.move ? ` (${metadata.direction} ${metadata.move} pts)` : ''}`);
    this.activeTracking.delete(tracking.key);
  }

  finalizeShadow(shadow, wouldBeOutcome, exitPrice) {
    let pnl = null;
    let fillPrice = exitPrice;
    if (wouldBeOutcome === 'TARGET_HIT') fillPrice = shadow.target;
    else if (wouldBeOutcome === 'STOP_HIT') fillPrice = shadow.stopLoss;

    if (shadow.entryTriggered && (wouldBeOutcome === 'TARGET_HIT' || wouldBeOutcome === 'STOP_HIT')) {
      const lots = shadow.lots || 0.01;
      const priceMove = shadow.direction === 'LONG'
        ? fillPrice - shadow.entryPrice
        : shadow.entryPrice - fillPrice;
      pnl = priceMove * 100 * lots;
    }

    database.updateVetoShadow(shadow.shadowId, wouldBeOutcome, pnl);
    console.log(`👻 Shadow resolved [${shadow.portfolioName}] ${wouldBeOutcome}, would_be_pnl=${pnl !== null ? `$${pnl.toFixed(2)}` : 'n/a'}`);
    this.shadowTracking.delete(shadow.key);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  getStats() {
    return {
      activePositions: this.activeTracking.size,
      shadowPositions: this.shadowTracking.size,
      positions: Array.from(this.activeTracking.values()).map(t => ({
        key: t.key, portfolio: t.portfolioName, type: t.type, direction: t.direction
      }))
    };
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
