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
import { reflect, reflectVeto }          from './deciders/reflector.js';

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

    // In-memory open-position counts
    const openByPortfolio = {};
    for (const t of outcomeTracker.activeTracking.values()) {
      openByPortfolio[t.portfolioId] = (openByPortfolio[t.portfolioId] || 0) + 1;
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


// TODO REMOVE AFTER PHASE 3 VERIFICATION
// Runs checks 6-8 from verify-phase3.js against the live DB and real Claude API.
// Guarded by VERIFY_TOKEN env var; 403 on wrong / missing token.
app.get('/api/verify-phase3', async (req, res) => {
  const expectedToken = process.env.VERIFY_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const soloPortfolio    = database.getPortfolioByName('claude_solo');
    const overlayPortfolio = database.getPortfolioByName('claude_overlay');

    // ── Check 6: solo STOP_HIT → real reflect() call → journal entry ─────
    const cntSoloBefore    = database.db.prepare('SELECT COUNT(*) AS n FROM journal WHERE portfolio_id = ?').get(soloPortfolio.id).n;
    const cntOverlayBefore = database.db.prepare('SELECT COUNT(*) AS n FROM journal WHERE portfolio_id = ?').get(overlayPortfolio.id).n;

    await reflect({
      portfolioName: 'claude_solo',
      portfolioId:   soloPortfolio.id,
      direction:     'LONG',
      entryPrice:    3300.00,
      stopLoss:      3290.00,
      target:        3320.00,
      lots:          0.10,
      tag:           'h1_momentum_pullback_entry',
      reasoning:     'H1 MACD crossed above signal; RSI 56; support at 3290 ATR-confirmed.',
      tradeId:       null,
      maxPrice:      3305.00,
      minPrice:      3290.00,
    }, 'STOP_HIT', -100);

    const newestSoloLoss = database.db.prepare(
      'SELECT * FROM journal WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1'
    ).get(soloPortfolio.id);

    // Lesson block exactly as it will be assembled for the next solo decision prompt
    const recentLessons = database.getRecentLessons(soloPortfolio.id);
    const lessonsBlock = recentLessons.length === 0
      ? 'No lessons recorded yet.'
      : recentLessons.map((l, i) =>
          `${i + 1}. [${l.entry_type}${l.recurring ? ' — RECURRING' : ''}] ${l.lesson_text} (tag: ${l.tag})`
        ).join('\n');

    // ── Check 7: veto shadow → real reflectVeto() call → journal entry ────
    await reflectVeto({
      portfolioName: 'claude_solo',
      portfolioId:   soloPortfolio.id,
      direction:     'SHORT',
      entryPrice:    3320.00,
      stopLoss:      3330.00,
      target:        3300.00,
      lots:          0.10,
      tag:           'overbought_rejection_veto',
      reasoning:     'H1 RSI 72, overbought; mechanical was late; vetoed on risk of snap-back.',
      shadowId:      null,
    }, 'STOP_HIT', -100);

    const newestVetoEntry = database.db.prepare(
      `SELECT * FROM journal WHERE portfolio_id = ? AND entry_type = 'veto' ORDER BY id DESC LIMIT 1`
    ).get(soloPortfolio.id);

    // ── Check 8: journal counts (overlay must be untouched) ───────────────
    const cntSoloAfter    = database.db.prepare('SELECT COUNT(*) AS n FROM journal WHERE portfolio_id = ?').get(soloPortfolio.id).n;
    const cntOverlayAfter = database.db.prepare('SELECT COUNT(*) AS n FROM journal WHERE portfolio_id = ?').get(overlayPortfolio.id).n;

    // ── Full /api/accounts payload ─────────────────────────────────────────
    const accounts = database.getAccountsSummary();
    const openByPortfolio = {};
    for (const t of outcomeTracker.activeTracking.values()) {
      openByPortfolio[t.portfolioId] = (openByPortfolio[t.portfolioId] || 0) + 1;
    }
    const accountsResult = accounts.map(a => {
      const base = { ...a, open_positions: openByPortfolio[a.id] || 0 };
      if (a.id === overlayPortfolio?.id) base.veto_stats = database.getVetoStats(a.id);
      return base;
    });

    res.json({
      check6_solo_loss_reflection: {
        simulated:     { direction: 'LONG', entry: 3300, stop: 3290, target: 3320, outcome: 'STOP_HIT', pnl: -100 },
        journal_entry: newestSoloLoss,
      },
      check6_lesson_block_for_next_prompt: {
        count:     recentLessons.length,
        formatted: lessonsBlock,
      },
      check7_veto_reflection: {
        simulated:     { direction: 'SHORT', would_be_outcome: 'STOP_HIT', would_be_pnl: -100 },
        journal_entry: newestVetoEntry,
      },
      journal_counts: {
        solo_before:       cntSoloBefore,
        solo_after:        cntSoloAfter,
        overlay_before:    cntOverlayBefore,
        overlay_after:     cntOverlayAfter,
        overlay_untouched: cntOverlayAfter === cntOverlayBefore,
      },
      accounts: accountsResult,
    });
  } catch (error) {
    console.error('❌ /api/verify-phase3 error:', error.message);
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
  console.log('='.repeat(55));
  if (process.env.VERIFY_TOKEN) {
    console.log('⚠️  DEBUG ROUTE ACTIVE — TODO REMOVE AFTER PHASE 3 VERIFICATION');
    console.log('   GET /api/verify-phase3?token=<VERIFY_TOKEN>');
  }
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
