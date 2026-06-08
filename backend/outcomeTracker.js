import database from './database.js';
import { isTradingHours } from './tradingHours.js';
import { reflect, reflectVeto } from './deciders/reflector.js';
import { VALUE_PER_LOT } from './contractSpec.js';

class OutcomeTracker {
  constructor() {
    // key → tracking  (real positions, all portfolios)
    this.activeTracking = new Map();

    // key → shadow  (veto counterfactuals, never touch balances)
    this.shadowTracking = new Map();

    this.monitoringInterval = null;
  }

  // ── Real positions ────────────────────────────────────────────────────────

  startTracking(key, tracking) {
    this.activeTracking.set(key, tracking);
    console.log(`📊 Tracking started [${tracking.portfolioName}] key=${key} type=${tracking.type}`);
    if (!this.monitoringInterval) this.startMonitoring();
  }

  // ── Shadow positions (VETO counterfactuals) ───────────────────────────────

  startShadow(key, shadow) {
    this.shadowTracking.set(key, shadow);
    console.log(`👻 Shadow tracking started [${shadow.portfolioName}] key=${key}`);
  }

  // ── Cleanup interval ──────────────────────────────────────────────────────

  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.expireStale().catch(err => console.error('expireStale error:', err));
    }, 30 * 60 * 1000);
    console.log('👁️  Outcome monitoring started (stale-check every 30 minutes)');
  }

  async expireStale() {
    if (!isTradingHours()) return;
    const now = new Date();
    for (const [, tracking] of this.activeTracking) {
      const ageHours = (now - tracking.startTime) / 3600000;
      if (ageHours >= 4 && !tracking.outcome) {
        await this.finalizePosition(tracking, 'EXPIRED');
      }
    }
    for (const [, shadow] of this.shadowTracking) {
      const ageHours = (now - shadow.startTime) / 3600000;
      if (ageHours >= 4) {
        await this.finalizeShadow(shadow, 'EXPIRED', null);
      }
    }
  }

  // ── Own-account position query ───────────────────────────────────────────
  // Returns active GREEN positions for ONE portfolio only.
  // Used to give each Claude account visibility into its own book without
  // leaking another account's positions into the prompt.

  getOpenPositionsForPortfolio(portfolioId) {
    const out = [];
    for (const [, t] of this.activeTracking) {
      if (t.portfolioId === portfolioId && t.type === 'GREEN') out.push(t);
    }
    return out;
  }

  // ── Price-tick evaluation (called by the 1-min poller) ───────────────────

  async checkOutcomesWithPrice(currentPrice) {
    const total = this.activeTracking.size + this.shadowTracking.size;
    if (total === 0) return;
    console.log(`\n🔍 Price tick $${currentPrice.toFixed(2)} — ${this.activeTracking.size} positions, ${this.shadowTracking.size} shadows`);

    const now = new Date();

    for (const [, tracking] of this.activeTracking) {
      tracking.maxPrice = Math.max(tracking.maxPrice, currentPrice);
      tracking.minPrice = Math.min(tracking.minPrice, currentPrice);
      const ageHours = (now - tracking.startTime) / 3600000;

      if (tracking.type === 'GREEN') {
        await this.checkGreenPosition(tracking, currentPrice, ageHours);
      } else if (tracking.type === 'RED') {
        await this.checkRedPosition(tracking, currentPrice, ageHours);
      }
      if (ageHours >= 4 && !tracking.outcome) {
        await this.finalizePosition(tracking, 'EXPIRED');
      }
    }

    for (const [, shadow] of this.shadowTracking) {
      shadow.maxPrice = Math.max(shadow.maxPrice, currentPrice);
      shadow.minPrice = Math.min(shadow.minPrice, currentPrice);
      const ageHours = (now - shadow.startTime) / 3600000;
      await this.checkShadowPosition(shadow, currentPrice, ageHours);
    }
  }

  // ── GREEN position logic ──────────────────────────────────────────────────

  async checkGreenPosition(tracking, currentPrice, ageHours) {
    const { direction, entryPrice, stopLoss, target, entryTriggered } = tracking;

    if (!entryTriggered) {
      const entryHit = direction === 'LONG' ? currentPrice <= entryPrice : currentPrice >= entryPrice;
      if (entryHit) {
        tracking.entryTriggered = true;
        tracking.entryTime = new Date();
        console.log(`✅ Entry triggered [${tracking.portfolioName}] key=${tracking.key}`);
      } else if (ageHours >= 2) {
        await this.finalizePosition(tracking, 'NO_ENTRY');
      }
      return;
    }

    if (direction === 'LONG') {
      if (currentPrice <= stopLoss)    await this.finalizePosition(tracking, 'STOP_HIT',   currentPrice);
      else if (currentPrice >= target) await this.finalizePosition(tracking, 'TARGET_HIT', currentPrice);
    } else {
      if (currentPrice >= stopLoss)    await this.finalizePosition(tracking, 'STOP_HIT',   currentPrice);
      else if (currentPrice <= target) await this.finalizePosition(tracking, 'TARGET_HIT', currentPrice);
    }
  }

  async checkRedPosition(tracking, currentPrice, ageHours) {
    const { startPrice, maxPrice, minPrice } = tracking;
    const biggestMove = Math.max(maxPrice - startPrice, startPrice - minPrice);
    if (biggestMove >= 15) {
      const direction = (maxPrice - startPrice) > (startPrice - minPrice) ? 'UP' : 'DOWN';
      await this.finalizePosition(tracking, 'MISSED_OPPORTUNITY', currentPrice, { move: biggestMove.toFixed(1), direction });
    } else if (ageHours >= 4) {
      await this.finalizePosition(tracking, 'CORRECT_RED', currentPrice);
    }
  }

  // ── Shadow position logic ─────────────────────────────────────────────────

  async checkShadowPosition(shadow, currentPrice, ageHours) {
    const { direction, entryPrice, stopLoss, target, entryTriggered } = shadow;

    if (!entryTriggered) {
      const entryHit = direction === 'LONG' ? currentPrice <= entryPrice : currentPrice >= entryPrice;
      if (entryHit) {
        shadow.entryTriggered = true;
      } else if (ageHours >= 2) {
        await this.finalizeShadow(shadow, 'NO_ENTRY', null);
      }
      return;
    }

    if (direction === 'LONG') {
      if (currentPrice <= stopLoss)    await this.finalizeShadow(shadow, 'STOP_HIT',   currentPrice);
      else if (currentPrice >= target) await this.finalizeShadow(shadow, 'TARGET_HIT', currentPrice);
    } else {
      if (currentPrice >= stopLoss)    await this.finalizeShadow(shadow, 'STOP_HIT',   currentPrice);
      else if (currentPrice <= target) await this.finalizeShadow(shadow, 'TARGET_HIT', currentPrice);
    }
    if (ageHours >= 4) await this.finalizeShadow(shadow, 'EXPIRED', null);
  }

  // ── Finalization ──────────────────────────────────────────────────────────

  async finalizePosition(tracking, outcome, exitPrice = null, metadata = {}) {
    tracking.outcome = outcome;
    tracking.endTime = new Date();

    let pnl = null;
    let fillPrice = exitPrice;
    if (outcome === 'TARGET_HIT') fillPrice = tracking.target;
    else if (outcome === 'STOP_HIT') fillPrice = tracking.stopLoss;

    if (tracking.type === 'GREEN' &&
        (outcome === 'TARGET_HIT' || outcome === 'STOP_HIT' ||
         ((outcome === 'WINDOW_CLOSE' || outcome === 'CIRCUIT_BREAKER') && tracking.entryTriggered))) {
      const lots = tracking.lots || 0.01;
      const priceMove = tracking.direction === 'LONG'
        ? fillPrice - tracking.entryPrice
        : tracking.entryPrice - fillPrice;
      pnl = priceMove * VALUE_PER_LOT * lots;

      const portfolio = await database.getPortfolioById(tracking.portfolioId);
      if (portfolio) {
        await database.updatePortfolioBalance(portfolio.id, pnl);
        const today = new Date().toISOString().split('T')[0];
        await database.upsertDailyPnl(today, portfolio.id, pnl, pnl > 0);
        const newBalance = portfolio.current_balance + pnl;
        console.log(`💰 [${portfolio.name}] P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} → $${newBalance.toFixed(2)}`);
      }
    }

    if (tracking.signalId) {
      await database.updateSignalOutcome(tracking.signalId, {
        outcome,
        outcome_timestamp: tracking.endTime.toISOString(),
        outcome_price: fillPrice,
        outcome_pnl: pnl,
        metadata: JSON.stringify(metadata),
      });
    }

    if (tracking.tradeId) {
      await database.updateTradeExit(tracking.tradeId, {
        exit_price:     fillPrice,
        exit_timestamp: tracking.endTime.toISOString(),
        exit_reason:    outcome,
        pnl,
      });
    }

    if (tracking.type === 'GREEN') {
      const exitStr = fillPrice != null ? ` @ $${fillPrice.toFixed(2)}` : '';
      const pnlStr  = pnl      != null ? ` · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
      if (outcome === 'WINDOW_CLOSE') {
        console.log(`🔔 [WINDOW CLOSE] ${tracking.portfolioName} | ${tracking.direction} closed${exitStr}${pnlStr} · WINDOW_CLOSE`);
      } else if (outcome === 'CIRCUIT_BREAKER') {
        console.log(`🛑 [CIRCUIT BREAKER] ${tracking.portfolioName} | ${tracking.direction} closed${exitStr}${pnlStr} · CIRCUIT_BREAKER`);
      } else {
        console.log(`🔴 [CLOSE] ${tracking.portfolioName} | ${outcome}${exitStr}${pnlStr}`);
      }
    } else {
      console.log(`✅ Position finalized [${tracking.portfolioName}] ${outcome}${metadata.move ? ` (${metadata.direction} ${metadata.move} pts)` : ''}`);
    }
    this.activeTracking.delete(tracking.key);

    reflect(tracking, outcome, pnl)
      .catch(err => console.error('reflect fire-and-forget error:', err.message));
  }

  async finalizeShadow(shadow, wouldBeOutcome, exitPrice) {
    let pnl = null;
    let fillPrice = exitPrice;
    if (wouldBeOutcome === 'TARGET_HIT') fillPrice = shadow.target;
    else if (wouldBeOutcome === 'STOP_HIT') fillPrice = shadow.stopLoss;

    if (shadow.entryTriggered && (wouldBeOutcome === 'TARGET_HIT' || wouldBeOutcome === 'STOP_HIT' || wouldBeOutcome === 'WINDOW_CLOSE')) {
      const lots = shadow.lots || 0.01;
      const priceMove = shadow.direction === 'LONG'
        ? fillPrice - shadow.entryPrice
        : shadow.entryPrice - fillPrice;
      pnl = priceMove * VALUE_PER_LOT * lots;
    }

    await database.updateVetoShadow(shadow.shadowId, wouldBeOutcome, pnl);
    if (wouldBeOutcome === 'WINDOW_CLOSE') {
      const priceStr = exitPrice != null ? ` @ $${exitPrice.toFixed(2)}` : '';
      const pnlDisp  = pnl       != null ? ` · would_be_pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
      console.log(`🔔 [WINDOW CLOSE] ${shadow.portfolioName} shadow | ${shadow.direction} closed${priceStr}${pnlDisp} · WINDOW_CLOSE`);
    } else {
      console.log(`👻 Shadow resolved [${shadow.portfolioName}] ${wouldBeOutcome}, would_be_pnl=${pnl !== null ? `$${pnl.toFixed(2)}` : 'n/a'}`);
    }
    this.shadowTracking.delete(shadow.key);

    reflectVeto(shadow, wouldBeOutcome, pnl)
      .catch(err => console.error('reflectVeto fire-and-forget error:', err.message));
  }

  // ── Circuit-breaker sweep — one portfolio only ────────────────────────────

  async forceClosePortfolio(portfolioId, price) {
    const positions = Array.from(this.activeTracking.values())
      .filter(t => t.portfolioId === portfolioId && t.type === 'GREEN');
    const shadows = Array.from(this.shadowTracking.values())
      .filter(s => s.portfolioId === portfolioId);

    for (const t of positions) {
      await this.finalizePosition(t, t.entryTriggered ? 'CIRCUIT_BREAKER' : 'NO_ENTRY', price);
    }
    for (const s of shadows) {
      await this.finalizeShadow(s, 'CIRCUIT_BREAKER', price);
    }
    return positions.length + shadows.length;
  }

  // ── Window-close sweep ───────────────────────────────────────────────────

  async forceCloseAll(price) {
    const greenPositions = Array.from(this.activeTracking.values()).filter(t => t.type === 'GREEN');
    const redMonitors    = Array.from(this.activeTracking.values()).filter(t => t.type === 'RED');
    const shadows        = Array.from(this.shadowTracking.values());

    const total = greenPositions.length + redMonitors.length + shadows.length;
    if (total === 0) {
      console.log('🔔 [WINDOW CLOSE] No open positions to close.');
      return;
    }

    console.log(`🔔 [WINDOW CLOSE] Closing ${greenPositions.length} position(s), ${shadows.length} shadow(s), clearing ${redMonitors.length} RED monitor(s) @ $${price.toFixed(2)}`);

    for (const t of greenPositions) {
      if (t.entryTriggered) {
        await this.finalizePosition(t, 'WINDOW_CLOSE', price);
      } else {
        await this.finalizePosition(t, 'NO_ENTRY', null);
      }
    }

    for (const t of redMonitors) {
      await this.finalizePosition(t, 'CORRECT_RED', price);
    }

    for (const s of shadows) {
      await this.finalizeShadow(s, 'WINDOW_CLOSE', price);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  getStats() {
    return {
      activePositions: this.activeTracking.size,
      shadowPositions: this.shadowTracking.size,
      positions: Array.from(this.activeTracking.values()).map(t => ({
        key: t.key, portfolio: t.portfolioName, type: t.type, direction: t.direction,
      })),
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
