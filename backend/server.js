import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import twelveData from './twelveData.js';
import database from './database.js';
import outcomeTracker from './outcomeTracker.js';
import { isTradingHours, getNextTradingTime } from './tradingHours.js';

import { decide as mechanicalDecide }    from './deciders/mechanicalDecider.js';
import { decide as claudeOverlayDecide } from './deciders/claudeOverlayDecider.js';
import { decide as claudeSoloDecide }    from './deciders/claudeSoloDecider.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory cache for the current mechanical signal
let currentSignal       = null;
let lastUpdate          = null;
// In-memory cache of last cycle's per-account decisions (for market-snapshot endpoint)
let lastCycleDecisions  = null;

// ── Helper: open a real position for one portfolio ─────────────────────────
function openPosition({ portfolio, decision, signalId, currentPrice, isSignalOwner }) {
  const tradeId = database.saveTrade({
    signal_id:    signalId,
    portfolio_id: portfolio.id,
    timestamp:    new Date().toISOString(),
    direction:    decision.direction,
    entry_price:  decision.entry,
    lot_size:     decision.lots,
    stop_loss:    decision.stop,
    take_profit:  decision.target,
    decider:      portfolio.name,
    tag:          decision.tag,
    reasoning:    decision.reasoning ?? null
  });

  const key = `${portfolio.id}_${signalId}`;
  outcomeTracker.startTracking(key, {
    key,
    portfolioId:    portfolio.id,
    portfolioName:  portfolio.name,
    signalId:       isSignalOwner ? signalId : null,
    tradeId,
    type:           'GREEN',
    direction:      decision.direction,
    lots:           decision.lots,
    startPrice:     currentPrice,
    entryPrice:     decision.entry,
    stopLoss:       decision.stop,
    target:         decision.target,
    tag:            decision.tag       ?? null,
    reasoning:      decision.reasoning ?? null,
    startTime:      new Date(),
    entryTriggered: false,
    outcome:        null,
    maxPrice:       currentPrice,
    minPrice:       currentPrice
  });
}

// ── Helper: open a veto shadow for one portfolio ───────────────────────────
function openVetoShadow({ portfolio, decision, currentPrice }) {
  const shadowId = database.saveVetoShadow({
    portfolioId: portfolio.id,
    direction:   decision.direction,
    entry:       decision.entry,
    stop:        decision.stop,
    target:      decision.target,
    tag:         decision.tag       ?? null,
    reasoning:   decision.reasoning ?? null
  });

  const key = `shadow_${shadowId}`;
  outcomeTracker.startShadow(key, {
    key,
    shadowId,
    portfolioId:    portfolio.id,
    portfolioName:  portfolio.name,
    direction:      decision.direction,
    lots:           decision.lots,
    entryPrice:     decision.entry,
    stopLoss:       decision.stop,
    target:         decision.target,
    tag:            decision.tag       ?? null,
    reasoning:      decision.reasoning ?? null,
    startTime:      new Date(),
    startPrice:     currentPrice,
    entryTriggered: false,
    maxPrice:       currentPrice,
    minPrice:       currentPrice
  });
}

// ── Signal generation cycle ────────────────────────────────────────────────
async function generateSignalIfTradingHours() {
  if (!isTradingHours()) {
    console.log('⏸️  Outside trading hours - skipping signal generation');
    return;
  }

  try {
    console.log('\n🔄 [CYCLE] Starting three-decider cycle...');

    // ONE shared fetch — all three accounts read the same snapshot
    const marketData = await twelveData.getMarketDataStaggered();
    const atr        = { h1: marketData.h1.atr, m30: marketData.m30.atr };
    const currentPrice = marketData.h1.price || marketData.m30.price;
    // Load all three portfolios fresh from DB (balances may have changed)
    const mechPortfolio    = database.getPortfolioByName('mechanical');
    const overlayPortfolio = database.getPortfolioByName('claude_overlay');
    const soloPortfolio    = database.getPortfolioByName('claude_solo');

    // Each Claude account reads its own recent lessons; mechanical gets none.
    const overlayLessons = database.getRecentLessons(overlayPortfolio.id);
    const soloLessons    = database.getRecentLessons(soloPortfolio.id);

    // ── Mechanical decider ──────────────────────────────────────────────────
    const mechDecision = await mechanicalDecide(marketData, atr, mechPortfolio, []);

    // Persist the mechanical signal (backward compat with /api/signal, history)
    const mechSignal = mechDecision._signal;
    mechSignal.marketData.m5 = marketData.m5;
    const signalId = database.saveSignal(mechSignal);

    if (mechDecision.action === 'TRADE') {
      openPosition({
        portfolio:     mechPortfolio,
        decision:      mechDecision,
        signalId,
        currentPrice,
        isSignalOwner: true   // updates signals table on close
      });
    } else {
      // Track RED signal for missed-opportunity detection
      const key = `${mechPortfolio.id}_${signalId}`;
      outcomeTracker.startTracking(key, {
        key,
        portfolioId:   mechPortfolio.id,
        portfolioName: 'mechanical',
        signalId,
        tradeId:       null,
        type:          'RED',
        startPrice:    currentPrice,
        startTime:     new Date(),
        outcome:       null,
        maxPrice:      currentPrice,
        minPrice:      currentPrice
      });
    }

    // Check outcomes against fresh price before opening new positions
    outcomeTracker.checkOutcomesWithPrice(currentPrice);

    // ── Claude Overlay decider ────────────────────────────────────────────
    const overlayDecision = await claudeOverlayDecide(
      marketData, atr, overlayPortfolio, overlayLessons, mechDecision
    );
    if (overlayDecision.action === 'TRADE') {
      openPosition({ portfolio: overlayPortfolio, decision: overlayDecision, signalId, currentPrice, isSignalOwner: false });
    } else if (overlayDecision.action === 'VETO') {
      openVetoShadow({ portfolio: overlayPortfolio, decision: overlayDecision, currentPrice });
    }

    // ── Claude Solo decider ───────────────────────────────────────────────
    const soloDecision = await claudeSoloDecide(marketData, atr, soloPortfolio, soloLessons);
    if (soloDecision.action === 'TRADE') {
      openPosition({ portfolio: soloPortfolio, decision: soloDecision, signalId, currentPrice, isSignalOwner: false });
    } else if (soloDecision.action === 'VETO') {
      openVetoShadow({ portfolio: soloPortfolio, decision: soloDecision, currentPrice });
    }

    // Cache the mechanical signal for /api/signal
    currentSignal = mechSignal;
    lastUpdate    = Date.now();

    // Cache per-account decisions for /api/market-snapshot
    lastCycleDecisions = {
      timestamp:  new Date().toISOString(),
      mechanical: { action: mechDecision.action,    reasoning: mechDecision.reasoning,    tag: mechDecision.tag    },
      overlay:    { action: overlayDecision.action, reasoning: overlayDecision.reasoning, tag: overlayDecision.tag },
      solo:       { action: soloDecision.action,    reasoning: soloDecision.reasoning,    tag: soloDecision.tag    },
    };

    console.log(`✅ [CYCLE] mech=${mechDecision.action}, overlay=${overlayDecision.action}, solo=${soloDecision.action}`);
  } catch (error) {
    console.error('❌ [CYCLE] Error:', error.message);
  }
}

// ── Price poller — 1 API call/minute, gated to trading hours ─────────────
function startPricePoller() {
  console.log('📡 Starting price poller (every 1 minute during trading hours)...');

  setInterval(async () => {
    if (!isTradingHours()) return;
    const total = outcomeTracker.activeTracking.size + outcomeTracker.shadowTracking.size;
    if (total === 0) return;

    try {
      const price = await twelveData.fetchPrice('XAU/USD');
      console.log(`📡 [POLLER] $${price.toFixed(2)} | positions=${outcomeTracker.activeTracking.size}, shadows=${outcomeTracker.shadowTracking.size}`);
      outcomeTracker.checkOutcomesWithPrice(price);
    } catch (error) {
      console.error('❌ [POLLER] Price check failed:', error.message);
    }
  }, 60 * 1000);
}

// ── Signal cron ────────────────────────────────────────────────────────────
function startBackgroundSignalGeneration() {
  console.log('🤖 Starting background signal generation (every 8 min)...');
  generateSignalIfTradingHours();
  setInterval(() => generateSignalIfTradingHours(), 8 * 60 * 1000);
}

// ── REST API ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'gold-trader-backend', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/signal', (req, res) => {
  try {
    if (!isTradingHours()) {
      return res.json({
        signal: 'CLOSED',
        message: 'Outside trading hours (16:30–20:30 UAE)',
        nextTradingTime: getNextTradingTime(),
        timestamp: new Date().toISOString()
      });
    }
    if (currentSignal && lastUpdate) {
      return res.json({ ...currentSignal, cached: true, age: Math.floor((Date.now() - lastUpdate) / 1000) });
    }
    return res.json({ signal: 'PENDING', message: 'Waiting for first signal generation...', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/signals/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ signals: database.getRecentSignals(limit) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history', message: error.message });
  }
});

app.post('/api/trades', (req, res) => {
  try {
    const tradeId = database.saveTrade({
      signal_id:    req.body.signal_id,
      portfolio_id: req.body.portfolio_id,
      timestamp:    req.body.timestamp || new Date().toISOString(),
      direction:    req.body.direction,
      entry_price:  req.body.entry_price,
      lot_size:     req.body.lot_size,
      stop_loss:    req.body.stop_loss,
      take_profit:  req.body.take_profit,
      notes:        req.body.notes,
      decider:      req.body.decider,
      tag:          req.body.tag
    });
    res.json({ success: true, tradeId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save trade', message: error.message });
  }
});

app.put('/api/trades/:id/exit', (req, res) => {
  try {
    database.updateTradeExit(req.params.id, {
      exit_price:     req.body.exit_price,
      exit_timestamp: req.body.exit_timestamp || new Date().toISOString(),
      exit_reason:    req.body.exit_reason,
      pnl:            req.body.pnl
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update trade', message: error.message });
  }
});

app.get('/api/trades', (req, res) => {
  try {
    res.json({ trades: database.getRecentTrades(parseInt(req.query.limit) || 20) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trades', message: error.message });
  }
});

app.get('/api/stats/today', (req, res) => {
  try {
    res.json(database.getTodayStats());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats', message: error.message });
  }
});

app.get('/api/stats/performance', (req, res) => {
  try {
    res.json(database.getSignalPerformance(parseInt(req.query.days) || 7));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch performance', message: error.message });
  }
});

app.get('/api/export-all', (req, res) => {
  try {
    const signals = database.getAllSignals();
    res.json({ count: signals.length, data: signals });
  } catch (error) {
    res.status(500).json({ error: 'Failed to export signals', message: error.message });
  }
});

app.post('/api/account/update', (req, res) => {
  try {
    const { date, balance, dailyPnl, tradesCount, winRate } = req.body;
    database.updateAccountSnapshot(
      date || new Date().toISOString().split('T')[0],
      balance, dailyPnl || 0, tradesCount || 0, winRate || 0
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update account', message: error.message });
  }
});

app.get('/api/account/history', (req, res) => {
  try {
    res.json({ history: database.getAccountHistory(parseInt(req.query.days) || 30) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history', message: error.message });
  }
});

// Three-account summary — balances, win rate, daily P&L, open positions;
// overlay additionally shows veto stats.
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = database.getAccountsSummary();

    // In-memory open-position counts — GREEN only.
    // RED entries in activeTracking are missed-opportunity monitors (no trade,
    // no capital at risk) and must not appear as open positions on the dashboard.
    const openByPortfolio = {};
    for (const t of outcomeTracker.activeTracking.values()) {
      if (t.type === 'GREEN') {
        openByPortfolio[t.portfolioId] = (openByPortfolio[t.portfolioId] || 0) + 1;
      }
    }

    const overlayPortfolio = database.getPortfolioByName('claude_overlay');

    const result = accounts.map(a => {
      const base = { ...a, open_positions: openByPortfolio[a.id] || 0 };
      if (a.id === overlayPortfolio?.id) {
        base.veto_stats = database.getVetoStats(a.id);
      }
      return base;
    });

    res.json({ accounts: result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch accounts', message: error.message });
  }
});

// ── Autochartist endpoints (unchanged) ────────────────────────────────────

app.get('/api/autochartist/patterns', (req, res) => {
  try {
    res.json({ patterns: database.getAutochartistPatterns(parseInt(req.query.limit) || 100) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch patterns', message: error.message });
  }
});

app.post('/api/autochartist/patterns', (req, res) => {
  try {
    const { patternType, timeframe, timeIdentified, entryPrice, stopLoss, target, successProbability } = req.body;
    const currentPrice = currentSignal?.currentPrice || currentSignal?.marketData?.m15?.price || null;
    const ourSignal    = currentSignal?.signal || null;
    const patternId    = database.saveAutochartistPattern({
      patternType, timeframe, timeIdentified, entryPrice, stopLoss, target,
      successProbability, currentPrice, ourSignal
    });
    res.json({ success: true, patternId, message: 'Pattern logged successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log pattern', message: error.message });
  }
});


// ── Dashboard endpoints ───────────────────────────────────────────────────

// Recent journal entries across both Claude accounts, newest-first.
app.get('/api/journal', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const entries = database.db.prepare(`
      SELECT j.id, j.portfolio_id, p.name AS portfolio_name,
             j.timestamp, j.entry_type, j.lesson_text, j.tag
      FROM journal j
      JOIN portfolios p ON p.id = j.portfolio_id
      ORDER BY j.timestamp DESC
      LIMIT ?
    `).all(limit);
    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Current market state: signal, 5-timeframe snapshot, per-account last-cycle
// decisions, today's missed-opportunity count.
app.get('/api/market-snapshot', (req, res) => {
  try {
    const tradingHours = isTradingHours();
    const today = new Date().toISOString().split('T')[0];
    const missedOpportunitiesToday = database.db.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE date(timestamp) = ? AND outcome = 'MISSED_OPPORTUNITY'`
    ).get(today).n;

    res.json({
      tradingHours,
      nextTradingTime:         tradingHours ? null : getNextTradingTime(),
      signal:                  currentSignal   || null,
      lastCycleDecisions:      lastCycleDecisions || null,
      missedOpportunitiesToday,
      timestamp:               new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Per-portfolio equity curve: [{ t, b }] points from closed trades.
// Flat at starting_balance when no trades exist — chart still renders.
app.get('/api/equity', (req, res) => {
  try {
    const portfolios = database.getAllPortfolios();
    const equity = {};
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    for (const p of portfolios) {
      const trades = database.db.prepare(`
        SELECT exit_timestamp AS t, pnl
        FROM trades
        WHERE portfolio_id = ? AND exit_reason IS NOT NULL AND pnl IS NOT NULL
        ORDER BY exit_timestamp ASC
      `).all(p.id);

      const points = [{ t: dayStart.toISOString(), b: p.starting_balance }];
      let running = p.starting_balance;
      for (const tr of trades) {
        running = Math.round((running + tr.pnl) * 100) / 100;
        points.push({ t: tr.t, b: running });
      }
      // Ensure the most recent balance is reflected even if we have open P&L
      if (points[points.length - 1].b !== p.current_balance) {
        points.push({ t: new Date().toISOString(), b: p.current_balance });
      }
      equity[p.name] = points;
    }

    res.json({ equity, startingBalance: 100000 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(55));
  console.log('🚀 GOLD TRADER BACKEND STARTED');
  console.log('='.repeat(55));
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔑 TwelveData key: ${process.env.TWELVE_DATA_API_KEY ? 'YES' : 'NO'}`);
  console.log(`🤖 Claude key:     ${process.env.CLAUDE_API_KEY    ? 'YES' : 'NO'}`);
  console.log(`⏰ Trading window: 16:30–20:30 UAE (4 h, NY session, Mon–Fri)`);
  console.log(`🔄 Signal cron:  every 8 min  → ~30 cycles × 17 calls = ~510 calls/day`);
  console.log(`📡 Price poller: every 1 min  → ~240 checks × 1 call  = ~240 calls/day`);
  console.log(`📊 Projected daily total: ~750 calls  (budget: 800, margin: ~50)`);
  console.log(`⚡ Max calls/60s window: 7  (Batch B 6 + poller 1)`);
  console.log(`🏦 Accounts: mechanical | claude_overlay | claude_solo`);
  console.log('='.repeat(55) + '\n');

  startBackgroundSignalGeneration();
  startPricePoller();
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  outcomeTracker.stopMonitoring();
  database.close();
  process.exit(0);
});
