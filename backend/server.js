import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import twelveData from './twelveData.js';
import database from './database.js';
import outcomeTracker from './outcomeTracker.js';
import { isTradingHours, getNextTradingTime, getSession } from './tradingHours.js';

import { decide as mechanicalDecide }    from './deciders/mechanicalDecider.js';
import { decide as claudeOverlayDecide } from './deciders/claudeOverlayDecider.js';
import { decide as claudeSoloDecide }    from './deciders/claudeSoloDecider.js';
import { VALUE_PER_LOT } from './contractSpec.js';
import { TAG_TAXONOMY } from './tagTaxonomy.js';
import { runAnalysis, formatRulebookPrompt } from './analyst.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory cache for the current mechanical signal
let currentSignal      = null;
let lastUpdate         = null;
let lastKnownPrice     = null;
let lastCycleDecisions = null;
let wasInTradingHours  = false;

// ── Circuit-breaker state (per portfolio ID) ───────────────────────────────
// { [portfolioId]: { halted, haltedOnDate, dayStartBalance } }
const circuitBreakerState = {};
let currentSessionDate    = null;  // UAE date of the last initSessionDay() call

// ── Session range (tracked from 06:00 UAE open, reset daily) ──────────────
let sessionHigh      = null;
let sessionLow       = null;
let sessionRangeDate = null;  // UAE date of last range reset

function updateSessionRange(price) {
  const today = uaeDate();
  if (sessionRangeDate !== today) {
    sessionHigh      = price;
    sessionLow       = price;
    sessionRangeDate = today;
    console.log(`📏 [SESSION RANGE] Reset for ${today} @ $${price.toFixed(2)}`);
  } else {
    if (price > sessionHigh) sessionHigh = price;
    if (price < sessionLow)  sessionLow  = price;
  }
}

function getSessionRangeStr(currentPrice) {
  if (sessionHigh == null || sessionLow == null) return null;
  const spread = sessionHigh - sessionLow;
  if (spread < 0.01) return `Session range: establishing (< $0.01 spread so far)`;
  const pct = ((currentPrice - sessionLow) / spread * 100).toFixed(1);
  return `Session range: ${sessionLow.toFixed(2)}–${sessionHigh.toFixed(2)} | current ${currentPrice.toFixed(2)} (${pct}%)`;
}

// ── Helper: open a real position for one portfolio ─────────────────────────
async function openPosition({ portfolio, decision, signalId, currentPrice, isSignalOwner, session = null }) {
  const tradeId = await database.saveTrade({
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
    reasoning:    decision.reasoning ?? null,
    session
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
    session,
    startTime:      new Date(),
    entryTriggered: false,
    outcome:        null,
    maxPrice:       currentPrice,
    minPrice:       currentPrice
  });
  console.log(`🟢 [OPEN] ${portfolio.name} | ${decision.direction} entry=${decision.entry?.toFixed(2)} stop=${decision.stop?.toFixed(2)} target=${decision.target?.toFixed(2)} lots=${decision.lots}`);
}

// ── Helper: open a veto shadow for one portfolio ───────────────────────────
async function openVetoShadow({ portfolio, decision, currentPrice, session = null }) {
  const shadowId = await database.saveVetoShadow({
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
    session,
    startTime:      new Date(),
    startPrice:     currentPrice,
    entryTriggered: false,
    maxPrice:       currentPrice,
    minPrice:       currentPrice
  });
}

// ── Circuit-breaker helpers ────────────────────────────────────────────────

// Current date in UAE (UTC+4, no DST) as YYYY-MM-DD.
function uaeDate() {
  return new Date(Date.now() + 4 * 3600000).toISOString().split('T')[0];
}

// True if the circuit breaker fired for this portfolio today.
function isHaltedToday(portfolioId) {
  const s = circuitBreakerState[portfolioId];
  return s?.halted === true && s?.haltedOnDate === uaeDate();
}

// Sum of unrealized P&L across all triggered GREEN positions for one portfolio.
function computeUnrealizedPnl(portfolioId, price) {
  if (price == null) return 0;
  let total = 0;
  for (const t of outcomeTracker.activeTracking.values()) {
    if (t.portfolioId !== portfolioId || t.type !== 'GREEN' || !t.entryTriggered) continue;
    const move = t.direction === 'LONG' ? price - t.entryPrice : t.entryPrice - price;
    total += move * VALUE_PER_LOT * (t.lots || 0.01);
  }
  return total;
}

// Called once per session day (at trading open or server start).
// Snapshots each account's current balance as the day-start baseline.
async function initSessionDay() {
  const today = uaeDate();
  if (currentSessionDate === today) return; // already done for today
  console.log(`🌅 [SESSION] Initializing session day ${today} — snapshotting day-start balances`);
  const portfolios = await database.getAllPortfolios();
  for (const p of portfolios) {
    // Preserve halt state for today (handles server restart mid-session).
    const haltedToday = p.circuit_breaker_date === today;
    const dayStartBalance = haltedToday && p.day_start_balance != null
      ? p.day_start_balance     // keep the balance captured before the breaker fired
      : p.current_balance;      // new day or fresh start

    if (!haltedToday) {
      await database.setDayStartBalance(p.id, dayStartBalance);
      await database.setCircuitBreakerDate(p.id, null);
    }
    circuitBreakerState[p.id] = { halted: haltedToday, haltedOnDate: haltedToday ? today : null, dayStartBalance };
    if (haltedToday) console.log(`🛑 [CIRCUIT BREAKER] ${p.name} still halted (restored)`);
  }
  currentSessionDate = today;
  console.log(`🌅 [SESSION] Day-start balances: ${portfolios.map(p => `${p.name}=$${(circuitBreakerState[p.id].dayStartBalance).toFixed(2)}`).join(', ')}`);
}

// Check and fire circuit breakers. Call on every poller tick and at cycle start.
async function checkCircuitBreakers(currentPrice) {
  if (!isTradingHours()) return;
  const today = uaeDate();
  if (currentSessionDate !== today) {
    await initSessionDay();
    return; // freshly initialized — nothing to close yet this tick
  }

  const portfolios = await database.getAllPortfolios();
  for (const p of portfolios) {
    const state = circuitBreakerState[p.id];
    if (!state || state.halted) continue;

    const realized   = p.current_balance - state.dayStartBalance;
    const unrealized = computeUnrealizedPnl(p.id, currentPrice);
    const dayPnl     = realized + unrealized;
    const threshold  = -(state.dayStartBalance * 0.10);

    if (dayPnl <= threshold) {
      console.log(
        `🛑 [CIRCUIT BREAKER] ${p.name} hit -10% day loss` +
        ` (realized $${realized.toFixed(2)} + unrealized $${unrealized.toFixed(2)} = $${dayPnl.toFixed(2)},` +
        ` threshold $${threshold.toFixed(2)}) — flattened and halted until next session`
      );
      const closed = await outcomeTracker.forceClosePortfolio(p.id, currentPrice);
      state.halted      = true;
      state.haltedOnDate = today;
      await database.setCircuitBreakerDate(p.id, today);
      console.log(`🛑 [CIRCUIT BREAKER] ${p.name} — ${closed} position(s)/shadow(s) closed, halted for session day ${today}`);
    }
  }
}

// ── Session label — UTC-hour based forex session identifier ───────────────
function sessionLabel(ts) {
  if (!ts) return '';
  const d    = new Date(ts);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins < 300)  return 'JP';       // 00:00–05:00 UTC  (Tokyo)
  if (mins < 420)  return 'JP-EUR';   // 05:00–07:00 UTC  (Tokyo/London overlap)
  if (mins < 510)  return 'EUR';      // 07:00–08:30 UTC  (London)
  if (mins < 750)  return 'EUR-US';   // 08:30–12:30 UTC  (trading window: London/NY overlap)
  if (mins < 1020) return 'US';       // 12:30–17:00 UTC  (New York)
  return 'JP';                        // 17:00–00:00 UTC  (overnight)
}

// ── Helper: classify a decision for experiment tracking ───────────────────
// Maps a decision object to a short label stored in signals.overlay_decision
// / signals.solo_decision. Parse/validation/API failures are stored as
// distinct strings so they're never conflated with genuine NO_TRADE verdicts.
function decisionLabel(decision) {
  const tag = decision?.tag ?? '';
  if (tag.endsWith('_parse_failure'))    return 'PARSE_FAILURE';
  if (tag.endsWith('_validation_error')) return 'VALIDATION_ERROR';
  if (tag.endsWith('_api_error'))        return 'API_ERROR';
  return decision?.action ?? 'NO_TRADE';
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
    const marketData     = await twelveData.getMarketDataBulk();
    const atr            = { h1: marketData.h1.atr, m30: marketData.m30.atr };
    const currentPrice   = marketData.h1.price || marketData.m30.price;
    const currentSession = getSession(new Date());
    lastKnownPrice = currentPrice;
    updateSessionRange(currentPrice);
    marketData.sessionRange = getSessionRangeStr(currentPrice);
    console.log(`📍 [CYCLE] Session: ${currentSession ?? 'none'} | Price: $${currentPrice?.toFixed(2)}`);
    if (marketData.atrCaveat) {
      console.log(`⚠️  [CYCLE] ATR caveat active (H1/H4 ratio understated) — prompts will include caveat`);
    }
    // Load all three portfolios fresh from DB (balances may have changed)
    const mechPortfolio    = await database.getPortfolioByName('mechanical');
    const overlayPortfolio = await database.getPortfolioByName('claude_overlay');
    const soloPortfolio    = await database.getPortfolioByName('claude_solo');

    // Each Claude account reads its own recent lessons; mechanical gets none.
    const overlayLessons = await database.getRecentLessons(overlayPortfolio.id);
    const soloLessons    = await database.getRecentLessons(soloPortfolio.id);

    // ── Mechanical decider — pure market-analysis proposal ─────────────────
    // mechDecision reflects technical analysis ONLY — no position/budget gating.
    // It is ALWAYS passed to the overlay decider unchanged below.
    // Whether mechanical itself executes is determined separately; a full
    // mechanical budget must never blind or block the overlay account.
    const mechDecision = await mechanicalDecide(marketData, atr, mechPortfolio, []);

    // Persist the mechanical signal (backward compat with /api/signal, history)
    const mechSignal = mechDecision._signal;
    mechSignal.marketData.m5 = marketData.m5;
    mechSignal.session = currentSession;
    mechSignal.adx     = { h4: marketData.h4.adx, h1: marketData.h1.adx, m30: marketData.m30.adx };
    mechSignal.sessionHigh      = sessionHigh;
    mechSignal.sessionLow       = sessionLow;
    mechSignal.rangePositionPct = (sessionHigh && sessionLow && sessionHigh !== sessionLow)
      ? ((currentPrice - sessionLow) / (sessionHigh - sessionLow) * 100)
      : null;
    mechSignal.rangeWidthVsH1Atr = (sessionHigh && sessionLow && marketData.h1?.atr)
      ? ((sessionHigh - sessionLow) / marketData.h1.atr)
      : null;
    const signalId = await database.saveSignal(mechSignal);

    // ── Circuit-breaker check — fires before any new positions are opened ────
    // May close existing positions and mark accounts as halted for the day.
    await checkCircuitBreakers(currentPrice);

    // ── Mechanical execution — gated by position cap + circuit breaker ────
    // mechDecision ALWAYS flows to overlay unchanged (decoupling invariant).
    const mechOpenPositions = outcomeTracker.getOpenPositionsForPortfolio(mechPortfolio.id);
    if (mechDecision.action === 'TRADE') {
      if (isHaltedToday(mechPortfolio.id)) {
        console.log(`🛑 [MECHANICAL] Circuit breaker active — no new position this cycle`);
      } else if (mechOpenPositions.length >= 3) {
        console.log(`⏸️  [MECHANICAL] Position cap: ${mechOpenPositions.length}/3 open — no new position this cycle`);
      } else {
        await openPosition({
          portfolio:     mechPortfolio,
          decision:      mechDecision,
          signalId,
          currentPrice,
          isSignalOwner: true,
          session:       currentSession
        });
      }
    } else if (!isHaltedToday(mechPortfolio.id)) {
      // Track RED for missed-opportunity detection only when not halted.
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

    // ── Each Claude account queries its OWN open positions only ──────────
    const overlayOpenPositions = outcomeTracker.getOpenPositionsForPortfolio(overlayPortfolio.id);
    const soloOpenPositions    = outcomeTracker.getOpenPositionsForPortfolio(soloPortfolio.id);

    // ── Claude Overlay decider ────────────────────────────────────────────
    // Always receives mechDecision regardless of mechanical's execution status.
    let overlayDecision;
    if (isHaltedToday(overlayPortfolio.id)) {
      console.log(`🛑 [OVERLAY] Circuit breaker active — skipping Claude call this cycle`);
      overlayDecision = { action: 'NO_TRADE', direction: null, entry: null, stop: null, target: null, lots: null, reasoning: 'circuit breaker halt', tag: 'circuit_breaker_halt' };
    } else {
      overlayDecision = await claudeOverlayDecide(
        marketData, atr, overlayPortfolio, overlayLessons, mechDecision, overlayOpenPositions, currentSession
      );
      if (overlayDecision.action === 'TRADE') {
        await openPosition({ portfolio: overlayPortfolio, decision: overlayDecision, signalId, currentPrice, isSignalOwner: false, session: currentSession });
      } else if (overlayDecision.action === 'VETO') {
        await openVetoShadow({ portfolio: overlayPortfolio, decision: overlayDecision, currentPrice, session: currentSession });
      }
    }

    // ── Claude Solo decider ───────────────────────────────────────────────
    let soloDecision;
    if (isHaltedToday(soloPortfolio.id)) {
      console.log(`🛑 [SOLO] Circuit breaker active — skipping Claude call this cycle`);
      soloDecision = { action: 'NO_TRADE', direction: null, entry: null, stop: null, target: null, lots: null, reasoning: 'circuit breaker halt', tag: 'circuit_breaker_halt' };
    } else {
      soloDecision = await claudeSoloDecide(
        marketData, atr, soloPortfolio, soloLessons, soloOpenPositions, null, currentSession
      );
      if (soloDecision.action === 'TRADE') {
        await openPosition({ portfolio: soloPortfolio, decision: soloDecision, signalId, currentPrice, isSignalOwner: false, session: currentSession });
      } else if (soloDecision.action === 'VETO') {
        await openVetoShadow({ portfolio: soloPortfolio, decision: soloDecision, currentPrice, session: currentSession });
      }
    }

    // Record which decision each Claude account reached (distinguishes
    // parse/API failures from genuine TRADE / VETO / NO_TRADE verdicts).
    await database.updateSignalDecisions(
      signalId,
      decisionLabel(overlayDecision),
      decisionLabel(soloDecision)
    );

    // Cache the mechanical signal for /api/signal
    currentSignal = mechSignal;
    lastUpdate    = Date.now();

    lastCycleDecisions = {
      mechanical: { action: mechDecision.action,    tag: mechDecision.tag    ?? null, reasoning: mechDecision.reasoning ?? null },
      overlay:    { action: overlayDecision.action,  tag: overlayDecision.tag  ?? null, reasoning: overlayDecision.reasoning ?? null },
      solo:       { action: soloDecision.action,     tag: soloDecision.tag     ?? null, reasoning: soloDecision.reasoning ?? null },
    };

    console.log(`✅ [CYCLE] mech=${mechDecision.action}, overlay=${overlayDecision.action}, solo=${soloDecision.action}`);
  } catch (error) {
    console.error('❌ [CYCLE] Error:', error.message);
  }
}

// ── Window-close sweep — fires once at the 20:30 UAE edge ─────────────────
async function runWindowClose() {
  console.log('\n🔔 [WINDOW CLOSE] ─────────────────────────────────────────');
  console.log('🔔 [WINDOW CLOSE] Trading window ended (20:30 UAE) — force-closing all positions');

  // Try to get a fresh final mark price; fall back to the last poller tick
  let price = lastKnownPrice;
  try {
    price = await twelveData.fetchPrice('XAU/USD');
    lastKnownPrice = price;
    console.log(`🔔 [WINDOW CLOSE] Final mark price: $${price.toFixed(2)}`);
  } catch (err) {
    const fallback = price != null ? `$${price.toFixed(2)}` : 'NONE';
    console.warn(`⚠️  [WINDOW CLOSE] Price fetch failed (${err.message}) — using last-known ${fallback}`);
  }

  if (price == null) {
    console.error('❌ [WINDOW CLOSE] Cannot force-close: no price available. Positions left open.');
    return;
  }

  outcomeTracker.forceCloseAll(price);

  // Nightly analyst run — after all positions are closed and P&L booked
  try {
    const analystResult = await runAnalysis(database.pool);
    console.log(`📊 Analyst: nightly run complete — ${analystResult.rulebook_rows_written} rulebook rows, ${analystResult.combination_rows_written} combination rows`);
  } catch (err) {
    console.error('❌ Analyst: nightly run failed —', err.message);
  }

  console.log('🔔 [WINDOW CLOSE] ─────────────────────────────────────────\n');
}

// ── Price poller — 1 API call/minute, gated to trading hours ─────────────
function startPricePoller() {
  console.log('📡 Starting price poller (every 1 minute during trading hours)...');

  setInterval(async () => {
    const nowInHours = isTradingHours();

    // Detect the 20:30 window-close edge: was trading, now not
    if (wasInTradingHours && !nowInHours) {
      wasInTradingHours = false;
      await runWindowClose();
      return; // poller goes dormant until next session
    }
    wasInTradingHours = nowInHours;

    if (!nowInHours) return;

    try {
      const price = await twelveData.fetchPrice('XAU/USD');
      lastKnownPrice = price;
      updateSessionRange(price);
      const total = outcomeTracker.activeTracking.size + outcomeTracker.shadowTracking.size;
      if (total > 0) {
        console.log(`📡 [POLLER] $${price.toFixed(2)} | positions=${outcomeTracker.activeTracking.size}, shadows=${outcomeTracker.shadowTracking.size}`);
        await outcomeTracker.checkOutcomesWithPrice(price);
      }
      // Circuit-breaker check runs every tick (unrealized P&L moves with price).
      await checkCircuitBreakers(price);
    } catch (error) {
      console.error('❌ [POLLER] Price check failed:', error.message);
    }
  }, 60 * 1000);
}

// ── Signal cron ────────────────────────────────────────────────────────────
function startBackgroundSignalGeneration() {
  console.log('🤖 Starting background signal generation (every 5 min)...');
  generateSignalIfTradingHours();
  setInterval(() => generateSignalIfTradingHours(), 5 * 60 * 1000);
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
        message: 'Outside trading hours (06:00–21:00 UAE)',
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

app.get('/api/signals/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ signals: await database.getRecentSignals(limit) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history', message: error.message });
  }
});

app.post('/api/trades', async (req, res) => {
  try {
    const tradeId = await database.saveTrade({
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

app.put('/api/trades/:id/exit', async (req, res) => {
  try {
    await database.updateTradeExit(req.params.id, {
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

app.get('/api/trades', async (req, res) => {
  try {
    res.json({ trades: await database.getRecentTrades(parseInt(req.query.limit) || 20) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trades', message: error.message });
  }
});

app.get('/api/stats/today', async (req, res) => {
  try {
    res.json(await database.getTodayStats());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats', message: error.message });
  }
});

app.get('/api/stats/performance', async (req, res) => {
  try {
    res.json(await database.getSignalPerformance(parseInt(req.query.days) || 7));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch performance', message: error.message });
  }
});

app.get('/api/export-all', async (req, res) => {
  try {
    const signals = await database.getAllSignals();
    res.json({ count: signals.length, data: signals });
  } catch (error) {
    res.status(500).json({ error: 'Failed to export signals', message: error.message });
  }
});

app.post('/api/account/update', async (req, res) => {
  try {
    const { date, balance, dailyPnl, tradesCount, winRate } = req.body;
    await database.updateAccountSnapshot(
      date || new Date().toISOString().split('T')[0],
      balance, dailyPnl || 0, tradesCount || 0, winRate || 0
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update account', message: error.message });
  }
});

app.get('/api/account/history', async (req, res) => {
  try {
    res.json({ history: await database.getAccountHistory(parseInt(req.query.days) || 30) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history', message: error.message });
  }
});

// Three-account summary — balances, win rate, daily P&L, open positions;
// overlay additionally shows veto stats.
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await database.getAccountsSummary();

    const openByPortfolio = {};
    for (const t of outcomeTracker.activeTracking.values()) {
      if (t.type === 'GREEN') {
        openByPortfolio[t.portfolioId] = (openByPortfolio[t.portfolioId] || 0) + 1;
      }
    }

    const overlayPortfolio = await database.getPortfolioByName('claude_overlay');

    const result = [];
    for (const a of accounts) {
      const base = { ...a, open_positions: openByPortfolio[a.id] || 0 };
      if (a.id === overlayPortfolio?.id) {
        base.veto_stats = await database.getVetoStats(a.id);
      }
      result.push(base);
    }

    res.json({ accounts: result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch accounts', message: error.message });
  }
});

// ── Dashboard endpoints ────────────────────────────────────────────────────

// Current market state: signal, 5-timeframe snapshot, last-cycle decisions, missed count.
app.get('/api/market-snapshot', async (req, res) => {
  try {
    res.json({
      tradingHours:            isTradingHours(),
      nextTradingTime:         isTradingHours() ? null : getNextTradingTime(),
      signal:                  currentSignal      || null,
      lastCycleDecisions:      lastCycleDecisions || null,
      missedOpportunitiesToday: await database.getMissedOpportunitiesToday(),
      timestamp:               new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Daily equity curve — one balance point per trading day per account.
// Past days: closing balance derived from account_pnl_daily cumulative PnL.
// Today: current_balance (in-progress / partial day).
app.get('/api/equity', async (req, res) => {
  try {
    const portfolios = await database.getAllPortfolios();
    const equity = {};
    for (const p of portfolios) {
      equity[p.name] = await database.getDailyEquity(p.id);
    }
    res.json({ equity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Open GREEN positions — live unrealized P&L from lastKnownPrice.
app.get('/api/positions', (req, res) => {
  try {
    const positions = [];
    for (const t of outcomeTracker.activeTracking.values()) {
      if (t.type !== 'GREEN') continue;
      let unrealizedPnl = null;
      if (t.entryTriggered && lastKnownPrice != null) {
        const move = t.direction === 'LONG'
          ? lastKnownPrice - t.entryPrice
          : t.entryPrice - lastKnownPrice;
        unrealizedPnl = Math.round(move * 100 * (t.lots || 0.01) * 100) / 100;
      }
      positions.push({
        key:            t.key,
        portfolioName:  t.portfolioName,
        direction:      t.direction,
        entryPrice:     t.entryPrice,
        stopLoss:       t.stopLoss,
        target:         t.target,
        lots:           t.lots,
        startTime:      t.startTime,
        entryTriggered: t.entryTriggered,
        currentPrice:   lastKnownPrice,
        unrealizedPnl,
        tag:            t.tag,
      });
    }
    res.json({ positions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent closed trades — optionally filtered by account name.
app.get('/api/trades/recent', async (req, res) => {
  try {
    const limit     = Math.min(Math.max(parseInt(req.query.limit)  || 20, 1), 100);
    const offset    = Math.max(parseInt(req.query.offset) || 0, 0);
    const account   = req.query.account;
    let portfolioId = null;
    if (account) {
      const p = await database.getPortfolioByName(account);
      if (!p) return res.json({ trades: [] });
      portfolioId = p.id;
    }
    res.json({ trades: await database.getRecentClosedTrades(limit, portfolioId, offset) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Journal entries — optionally filtered by account name.
app.get('/api/journal', async (req, res) => {
  try {
    const limit     = Math.min(Math.max(parseInt(req.query.limit)  || 20, 1), 100);
    const offset    = Math.max(parseInt(req.query.offset) || 0, 0);
    const account   = req.query.account;
    let portfolioId = null;
    if (account) {
      const p = await database.getPortfolioByName(account);
      if (!p) return res.json({ entries: [] });
      portfolioId = p.id;
    }
    res.json({ entries: await database.getJournalEntries(limit, portfolioId, offset) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Missed-opportunity detail — RED signals that crossed the 15-pt threshold.
app.get('/api/missed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const missed = (await database.getMissedOpportunitiesRecent(limit)).map(r => {
      let meta = {};
      try { meta = JSON.parse(r.outcome_metadata || '{}'); } catch {}
      return {
        id:               r.id,
        timestamp:        r.timestamp,
        outcomeTimestamp: r.outcome_timestamp,
        outcomePrice:     r.outcome_price,
        direction:        meta.direction ?? null,
        movePts:          meta.move != null ? parseFloat(meta.move) : null,
      };
    });
    res.json({ missed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Balance reconciliation diagnostic ────────────────────────────────────
// The balance only moves on realized closes; unrealized is NOT in the balance.
// Accounting check: actual == starting + sum_closed_pnl  (within rounding).
// Unrealized is shown separately — a non-zero value with open positions is normal.

app.get('/api/reconcile', async (req, res) => {
  try {
    const rows = await database.getReconciliationData();
    const result = rows.map(row => {
      const portfolioId  = row.id;
      const unrealized   = lastKnownPrice != null ? computeUnrealizedPnl(portfolioId, lastKnownPrice) : 0;
      const sumClosedPnl = parseFloat(row.sum_closed_pnl);
      const starting     = parseFloat(row.starting_balance);
      const actual       = parseFloat(row.current_balance);
      // Real accounting check: has the balance drifted from starting + realized?
      const balanceCheck = starting + sumClosedPnl;
      const balanceDiff  = Math.round((actual - balanceCheck) * 100) / 100;
      return {
        account:           row.name,
        starting_balance:  starting,
        sum_closed_pnl:    Math.round(sumClosedPnl * 100) / 100,
        actual_balance:    actual,
        balance_diff:      balanceDiff,   // should be ~0; non-zero = accounting error
        reconciled:        Math.abs(balanceDiff) < 1.00,
        unrealized_pnl:    Math.round(unrealized * 100) / 100,  // informational only
        open_positions:    parseInt(row.orphan_trades),
        total_trades_db:   parseInt(row.total_trades),
        closed_trades_db:  parseInt(row.closed_trades),
      };
    });
    res.json({ reconciliation: result, price_used: lastKnownPrice, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Autochartist endpoints (unchanged) ────────────────────────────────────

app.get('/api/autochartist/patterns', async (req, res) => {
  try {
    res.json({ patterns: await database.getAutochartistPatterns(parseInt(req.query.limit) || 100) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch patterns', message: error.message });
  }
});

app.post('/api/autochartist/patterns', async (req, res) => {
  try {
    const { patternType, timeframe, timeIdentified, entryPrice, stopLoss, target, successProbability } = req.body;
    const currentPrice = currentSignal?.currentPrice || currentSignal?.marketData?.m15?.price || null;
    const ourSignal    = currentSignal?.signal || null;
    const patternId    = await database.saveAutochartistPattern({
      patternType, timeframe, timeIdentified, entryPrice, stopLoss, target,
      successProbability, currentPrice, ourSignal
    });
    res.json({ success: true, patternId, message: 'Pattern logged successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log pattern', message: error.message });
  }
});

// ── Analyst endpoints ─────────────────────────────────────────────────────

app.post('/api/analyst/run', async (req, res) => {
  try {
    const result = await runAnalysis(database.pool);
    console.log(`📊 Analyst: run complete — ${result.rulebook_rows_written} rulebook rows, ${result.combination_rows_written} combination rows`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analyst/rulebook', async (req, res) => {
  try {
    const pool = database.pool;
    const account = req.query.account;  // 'solo' | 'overlay' | undefined

    let portfolioFilter = '';
    const params = [];
    if (account === 'solo') {
      params.push(3); portfolioFilter = ` AND r.portfolio_id = $${params.length}`;
    } else if (account === 'overlay') {
      params.push(2); portfolioFilter = ` AND r.portfolio_id = $${params.length}`;
    }

    const { rows: rulebook } = await pool.query(
      `SELECT * FROM analyst_rulebook r WHERE 1=1${portfolioFilter}
       ORDER BY r.portfolio_id, r.win_rate DESC, r.n_total DESC`,
      params
    );

    const comboParams = [...params];
    const comboFilter = portfolioFilter.replace(/r\./g, 'c.');
    const { rows: combinations } = await pool.query(
      `SELECT * FROM analyst_combinations c WHERE 1=1${comboFilter}
       ORDER BY c.portfolio_id, c.win_rate DESC, c.n_total DESC`,
      comboParams
    );

    const sufficient = rulebook.filter(r => r.sample_confidence === 'sufficient');
    const topWr = rulebook.slice().sort((a, b) => b.win_rate - a.win_rate)[0];
    const topExp = rulebook.filter(r => r.expectancy != null).sort((a, b) => b.expectancy - a.expectancy)[0];

    res.json({
      summary: {
        total_patterns:     rulebook.length,
        sufficient_patterns: sufficient.length,
        top_win_rate:       topWr  ? { tag: topWr.tag,  account: topWr.account_name,  win_rate: topWr.win_rate,   n_total: topWr.n_total }  : null,
        highest_expectancy: topExp ? { tag: topExp.tag, account: topExp.account_name, expectancy: topExp.expectancy, n_total: topExp.n_total } : null,
      },
      rulebook,
      combinations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analyst/rulebook/prompt', async (req, res) => {
  try {
    const pool = database.pool;
    const account = req.query.account;
    const includeInsufficient = req.query.include_insufficient === 'true';

    let portfolioFilter = '';
    const params = [];
    if (account === 'solo') {
      params.push(3); portfolioFilter = ` AND r.portfolio_id = $${params.length}`;
    } else if (account === 'overlay') {
      params.push(2); portfolioFilter = ` AND r.portfolio_id = $${params.length}`;
    }

    let confidenceFilter = '';
    if (!includeInsufficient) {
      confidenceFilter = ` AND r.sample_confidence != 'insufficient'`;
    }

    const { rows: rulebook } = await pool.query(
      `SELECT * FROM analyst_rulebook r WHERE 1=1${portfolioFilter}${confidenceFilter}
       ORDER BY r.portfolio_id, r.win_rate DESC, r.n_total DESC`,
      params
    );

    const comboParams = [...params];
    const comboFilter = portfolioFilter.replace(/r\./g, 'c.');
    const { rows: combinations } = await pool.query(
      `SELECT * FROM analyst_combinations c WHERE 1=1${comboFilter}
       ORDER BY c.win_rate DESC, c.n_total DESC LIMIT 5`,
      comboParams
    );

    const text = formatRulebookPrompt(rulebook, combinations);
    res.type('text/plain').send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pinned-lessons', async (req, res) => {
  try {
    const account = req.query.account;
    let portfolioId = null;
    if (account === 'overlay') portfolioId = 2;
    else if (account === 'solo') portfolioId = 3;

    const params = [];
    let filter = '';
    if (portfolioId) { params.push(portfolioId); filter = ` AND pl.portfolio_id = $1`; }

    const { rows } = await database.pool.query(`
      SELECT pl.id, pl.portfolio_id, p.name AS account_name,
             pl.tag, pl.tag_loss_count, pl.tag_total_count,
             pl.pin_reason, pl.pinned_at, pl.active,
             j.lesson_text
      FROM pinned_lessons pl
      JOIN portfolios p ON p.id = pl.portfolio_id
      JOIN journal j ON j.id = pl.journal_id
      WHERE 1=1${filter}
      ORDER BY pl.portfolio_id, pl.active DESC, pl.tag_loss_count DESC
    `, params);
    res.json({ pinned: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────

// Top-level await: must connect to PostgreSQL before accepting requests.
await database.init();

// Restore circuit-breaker state from DB (handles server restarts mid-session).
{
  const portfolios = await database.getAllPortfolios();
  const today      = uaeDate();
  for (const p of portfolios) {
    const haltedToday    = p.circuit_breaker_date === today;
    const dayStartBalance = (haltedToday && p.day_start_balance != null)
      ? p.day_start_balance
      : (p.day_start_balance ?? p.current_balance);
    circuitBreakerState[p.id] = { halted: haltedToday, haltedOnDate: haltedToday ? today : null, dayStartBalance };
    if (haltedToday) console.log(`🛑 [CIRCUIT BREAKER] ${p.name} halted today — restored from DB`);
  }
  // currentSessionDate stays null → initSessionDay() fires on first trading cycle.
}

// Restore open positions from DB (handles server restarts while trades are live).
{
  const openTrades = await database.getOpenTrades();
  if (openTrades.length > 0) {
    console.log(`🔄 [RESTORE] Restoring ${openTrades.length} open position(s) from DB after restart...`);
    for (const t of openTrades) {
      const key = `${t.portfolio_id}_${t.signal_id ?? t.id}`;
      outcomeTracker.startTracking(key, {
        key,
        portfolioId:    t.portfolio_id,
        portfolioName:  t.portfolio_name,
        signalId:       t.signal_id,
        tradeId:        t.id,
        type:           'GREEN',
        direction:      t.direction,
        lots:           t.lot_size,
        startPrice:     t.entry_price,
        entryPrice:     t.entry_price,
        stopLoss:       t.stop_loss,
        target:         t.take_profit,
        tag:            t.tag      ?? null,
        reasoning:      t.reasoning ?? null,
        session:        t.session   ?? null,
        startTime:      new Date(),
        entryTriggered: true,
        outcome:        null,
        maxPrice:       t.entry_price,
        minPrice:       t.entry_price,
      });
      console.log(`🔄 [RESTORE] ${t.portfolio_name} | ${t.direction} entry=${t.entry_price?.toFixed(2)} stop=${t.stop_loss?.toFixed(2)} target=${t.take_profit?.toFixed(2)}`);
    }
  }
}

app.get('/api/diag/queries', async (req, res) => {
  try {
    const pool = database.pool;
    const [q1, q2, q3, q4] = await Promise.all([
      pool.query(`
        SELECT p.name AS account, COUNT(*) AS total_closed,
          SUM(CASE WHEN t.exit_reason = 'WINDOW_CLOSE'    THEN 1 ELSE 0 END) AS window_close_count,
          ROUND((SUM(CASE WHEN t.exit_reason = 'WINDOW_CLOSE' THEN 1 ELSE 0 END)*100.0/COUNT(*))::numeric,1) AS window_close_pct,
          SUM(CASE WHEN t.exit_reason = 'TARGET_HIT'      THEN 1 ELSE 0 END) AS target_hit,
          SUM(CASE WHEN t.exit_reason = 'STOP_HIT'        THEN 1 ELSE 0 END) AS stop_hit,
          SUM(CASE WHEN t.exit_reason = 'CIRCUIT_BREAKER' THEN 1 ELSE 0 END) AS circuit_breaker,
          SUM(CASE WHEN t.exit_reason = 'NO_ENTRY'        THEN 1 ELSE 0 END) AS no_entry,
          SUM(CASE WHEN t.exit_reason = 'EXPIRED'         THEN 1 ELSE 0 END) AS expired
        FROM trades t JOIN portfolios p ON p.id = t.portfolio_id
        WHERE t.exit_reason IS NOT NULL GROUP BY p.name, p.id ORDER BY p.id`),
      pool.query(`
        SELECT p.name AS account, p.circuit_breaker_date, p.day_start_balance, p.current_balance,
          ROUND((p.current_balance - p.day_start_balance)::numeric, 2) AS day_pnl
        FROM portfolios p WHERE p.circuit_breaker_date IS NOT NULL ORDER BY p.id`),
      pool.query(`
        SELECT p.name AS account, COUNT(*) AS total_cycles_with_open_positions,
          MAX(open_count) AS max_concurrent_open
        FROM (
          SELECT t.portfolio_id, DATE(t.timestamp) AS trade_date, COUNT(*) AS open_count
          FROM trades t
          WHERE t.exit_reason IS NULL OR t.timestamp > t.exit_timestamp
          GROUP BY t.portfolio_id, DATE(t.timestamp)
        ) sub JOIN portfolios p ON p.id = sub.portfolio_id
        GROUP BY p.name, p.id ORDER BY p.id`),
      pool.query(`
        SELECT p.name AS account, COUNT(*) AS total_trades,
          SUM(CASE WHEN t.exit_reason = 'NO_ENTRY' THEN 1 ELSE 0 END) AS no_entry_count,
          ROUND((SUM(CASE WHEN t.exit_reason = 'NO_ENTRY' THEN 1 ELSE 0 END)*100.0/COUNT(*))::numeric,1) AS no_entry_pct,
          SUM(CASE WHEN t.exit_reason = 'EXPIRED' THEN 1 ELSE 0 END) AS expired_count
        FROM trades t JOIN portfolios p ON p.id = t.portfolio_id
        WHERE t.exit_reason IS NOT NULL GROUP BY p.name, p.id ORDER BY p.id`),
    ]);
    res.json({
      q1_window_close_by_account: q1.rows,
      q2_circuit_breaker_history: q2.rows,
      q3_risk_budget_utilization: q3.rows,
      q4_no_entry_rate:           q4.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(55));
  console.log('🚀 GOLD TRADER BACKEND STARTED');
  console.log('='.repeat(55));
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔑 TwelveData key: ${process.env.TWELVE_DATA_API_KEY ? 'YES' : 'NO'}`);
  console.log(`🤖 Claude key:     ${process.env.CLAUDE_API_KEY    ? 'YES' : 'NO'}`);
  console.log(`⏰ Trading window: 06:00–21:00 UAE (15 h, Mon–Fri)`);
  console.log(`🔄 Signal cron:  every 5 min  → ~180 cycles × 1 call = ~180 calls/day`);
  console.log(`📡 Price poller: every 1 min  → ~900 checks × 1 call = ~900 calls/day`);
  console.log(`📊 Projected daily total: ~1080 calls  (bulk plan budget: 800/min)`);
  console.log(`📍 Sessions: JP(06-10) | JP-EUR(10-11) | EUR(11-16) | EUR-US(16-19) | US(19-21) UAE`);
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
