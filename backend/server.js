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
import { callDecider, getLastCallUsage, todayCallCount } from './deciders/claudeClient.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory cache for the current mechanical signal
let currentSignal = null;
let lastUpdate    = null;

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
    tag:          decision.tag
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
    target:      decision.target
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
    const lessons    = []; // stub; populated by lesson store in later phase

    // Load all three portfolios fresh from DB (balances may have changed)
    const mechPortfolio    = database.getPortfolioByName('mechanical');
    const overlayPortfolio = database.getPortfolioByName('claude_overlay');
    const soloPortfolio    = database.getPortfolioByName('claude_solo');

    // ── Mechanical decider ──────────────────────────────────────────────────
    const mechDecision = await mechanicalDecide(marketData, atr, mechPortfolio, lessons);

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

    // ── Claude Overlay decider (stub: mirrors mechanical) ──────────────────
    const overlayDecision = await claudeOverlayDecide(
      marketData, atr, overlayPortfolio, lessons, mechDecision
    );
    if (overlayDecision.action === 'TRADE') {
      openPosition({ portfolio: overlayPortfolio, decision: overlayDecision, signalId, currentPrice, isSignalOwner: false });
    } else if (overlayDecision.action === 'VETO') {
      openVetoShadow({ portfolio: overlayPortfolio, decision: overlayDecision, currentPrice });
    }

    // ── Claude Solo decider (stub: always NO_TRADE) ────────────────────────
    const soloDecision = await claudeSoloDecide(marketData, atr, soloPortfolio, lessons);
    if (soloDecision.action === 'TRADE') {
      openPosition({ portfolio: soloPortfolio, decision: soloDecision, signalId, currentPrice, isSignalOwner: false });
    } else if (soloDecision.action === 'VETO') {
      openVetoShadow({ portfolio: soloPortfolio, decision: soloDecision, currentPrice });
    }

    // Cache the mechanical signal for /api/signal
    currentSignal = mechSignal;
    lastUpdate    = Date.now();

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

// Three-account summary — balances, daily P&L, open position counts
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = database.getAccountsSummary();
    // Enrich with in-memory open-position counts
    const openByPortfolio = {};
    for (const t of outcomeTracker.activeTracking.values()) {
      openByPortfolio[t.portfolioId] = (openByPortfolio[t.portfolioId] || 0) + 1;
    }
    const result = accounts.map(a => ({
      ...a,
      open_positions: openByPortfolio[a.id] || 0
    }));
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

// ── TODO REMOVE AFTER PHASE 2 VERIFICATION ────────────────────────────────
// Temporary debug endpoint — fires real Claude API calls on demand.
// Guarded by VERIFY_TOKEN query param.  DELETE this block before go-live.
// ─────────────────────────────────────────────────────────────────────────

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vphase2_xk7p3m9r';

const VERIFY_MOCK = {
  h4:  { interval: '4h',    price: 3300, rsi: 60.0, macd: 0.80, macd_signal: 0.50, macd_hist: 0.30, atr: 18.5 },
  h1:  { interval: '1h',    price: 3300, rsi: 58.0, macd: 1.20, macd_signal: 0.70, macd_hist: 0.50, atr:  7.2 },
  m30: { interval: '30min', price: 3300, rsi: 55.0, macd: 0.30, macd_signal: 0.10, macd_hist: 0.20, atr:  5.1 },
  m15: { interval: '15min', price: 3300, rsi: 52.0, macd: 0.10, macd_signal: 0.05, macd_hist: 0.05, atr:  3.8 },
  m5:  { interval: '5min',  price: 3300, rsi: 50.0, macd: 0.05, macd_signal: 0.02, macd_hist: 0.03, atr:  2.1 },
};
const VERIFY_ATR = { h1: 7.2, m30: 5.1 };

app.get('/api/verify-phase2', async (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'forbidden — missing or wrong ?token=' });
  }

  const result = {
    timestamp:          new Date().toISOString(),
    mock_price:         3300,
    mechanical:         null,
    overlay:            null,
    solo:               null,
    safety_malformed:   null,
    safety_lot_clamp:   null,
    claude_calls_today: null,
  };

  try {
    // 1 — Mechanical (no API call, must match Phase 1 exactly)
    const mechPortfolio = database.getPortfolioByName('mechanical');
    const mechDecision  = await mechanicalDecide(VERIFY_MOCK, VERIFY_ATR, mechPortfolio, []);
    result.mechanical   = { action: mechDecision.action, direction: mechDecision.direction,
                            entry: mechDecision.entry, stop: mechDecision.stop,
                            target: mechDecision.target, lots: mechDecision.lots, tag: mechDecision.tag };

    // 2 — Overlay (real API call)
    const overlayPortfolio = database.getPortfolioByName('claude_overlay');
    const overlayDecision  = await claudeOverlayDecide(VERIFY_MOCK, VERIFY_ATR, overlayPortfolio, [], mechDecision);
    result.overlay = { decision: overlayDecision, tokens: getLastCallUsage() };

    // 3 — Solo (real API call, independent — does not see mechDecision)
    const soloPortfolio = database.getPortfolioByName('claude_solo');
    const soloDecision  = await claudeSoloDecide(VERIFY_MOCK, VERIFY_ATR, soloPortfolio, []);
    result.solo = { decision: soloDecision, tokens: getLastCallUsage() };

    // 4 — Safety: malformed response → NO_TRADE (real API call with bad prompt)
    const malformedDecision = await callDecider({
      systemPrompt: 'You are a test assistant. Output ONLY the word "oops" with no JSON.',
      userContent:  'Respond with just the word oops.',
      deciderName:  'verify_malformed',
    });
    result.safety_malformed = {
      returned_action:  malformedDecision.action,
      reasoning_prefix: malformedDecision.reasoning.slice(0, 120),
      tokens:           getLastCallUsage(),
      pass:             malformedDecision.action === 'NO_TRADE',
    };

    // 5 — Safety: lot clamp (real API call asking for 50 lots → clamped to 1.0)
    const clampDecision = await callDecider({
      systemPrompt: 'You are a test assistant. Respond with ONLY this exact JSON, no other text:\n' +
                    '{"action":"TRADE","direction":"LONG","entry":3300,"stop":3290,"target":3310,' +
                    '"lots":50,"reasoning":"lot clamp verification test","tag":"clamp_test"}',
      userContent:  'Output the JSON now.',
      deciderName:  'verify_clamp',
    });
    result.safety_lot_clamp = {
      requested_lots:  50,
      returned_lots:   clampDecision.lots,
      returned_action: clampDecision.action,
      tokens:          getLastCallUsage(),
      pass:            clampDecision.action === 'NO_TRADE' || clampDecision.lots <= 1.0,
    };

  } catch (err) {
    result.error = err.message;
  }

  result.claude_calls_today = todayCallCount();
  res.json(result);
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
  console.log('='.repeat(55));
  // TODO REMOVE AFTER PHASE 2 VERIFICATION
  console.log('⚠️  DEBUG ROUTE ACTIVE: GET /api/verify-phase2?token=<VERIFY_TOKEN>');
  console.log('   Fires real Claude API calls on demand.  DELETE before go-live.');
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
