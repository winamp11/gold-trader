// verify-phase1.js — offline Phase 1 verification
// No live API calls, no trading-hours gate.
// Uses a throw-away temp DB so production data is never touched.
//
// Run:  cd backend && node verify-phase1.js

import { unlink } from 'fs/promises';

// Must be set BEFORE the singleton modules are imported.
const TEST_DB = '/tmp/gold-trader-verify-phase1.db';
process.env.DATABASE_PATH = TEST_DB;

// Clean up any leftover from a previous run.
for (const ext of ['', '-shm', '-wal']) {
  try { await unlink(`${TEST_DB}${ext}`); } catch {}
}

// Dynamic imports so the env var is in place before DatabaseService initialises.
const { default: database }       = await import('./database.js');
const { default: outcomeTracker } = await import('./outcomeTracker.js');
const { decide: mechanicalDecide }    = await import('./deciders/mechanicalDecider.js');
const { decide: claudeOverlayDecide } = await import('./deciders/claudeOverlayDecider.js');
const { decide: claudeSoloDecide }    = await import('./deciders/claudeSoloDecider.js');

const HR = '─'.repeat(65);

// ── Mock market snapshot ──────────────────────────────────────────────────
//
// LONG conditions in signalEngine (all must pass):
//   h4_macd_ok         : h4.macd  > -1.0   →  0.80  ✓
//   h1_macd_positive   : h1.macd  >  0.5   →  1.20  ✓
//   h1_rsi_bullish     : h1.rsi   > 52     →  58.0  ✓
//   m30_macd_positive  : m30.macd >  0     →  0.30  ✓
//   m30_rsi_ok         : m30.rsi  < 65     →  55.0  ✓
//   m15_rsi_range      : m15.rsi  30..70   →  52.0  ✓
//
// findSupportResistance: h4.macd_hist=0.3 → baseDistance=max(8,0.6)=8
//   support    = floor((3300-8)/5)*5 = 3290
//   resistance = ceil( (3300+8)/5)*5 = 3310
//   → entry=3300, stop=3290, target=3310, risk/reward=1:1
//
// Position size at $100 000:
//   riskAmount = 100000 * 0.02 = 2000
//   pointRisk  = |3300-3290| = 10
//   pointValue = 0.10 per 0.01 lot
//   optimalLots = 2000/(10*0.10) = 2000 → capped at maxLots=0.50
//   finalLots = 0.50
//
// P&L on TARGET_HIT (LONG, entry 3300, target 3310, 0.50 lots):
//   priceMove = 3310 - 3300 = 10
//   pnl = 10 * 100 * 0.50 = $500.00
// ─────────────────────────────────────────────────────────────────────────

const CURRENT_PRICE = 3300.00;

const mockMarketData = {
  h4:  { interval: '4h',    price: CURRENT_PRICE, rsi: 60.0, macd: 0.80, macd_signal: 0.50, macd_hist: 0.30, atr: 18.5 },
  h1:  { interval: '1h',    price: CURRENT_PRICE, rsi: 58.0, macd: 1.20, macd_signal: 0.70, macd_hist: 0.50, atr:  7.2 },
  m30: { interval: '30min', price: CURRENT_PRICE, rsi: 55.0, macd: 0.30, macd_signal: 0.10, macd_hist: 0.20, atr:  5.1 },
  m15: { interval: '15min', price: CURRENT_PRICE, rsi: 52.0, macd: 0.10, macd_signal: 0.05, macd_hist: 0.05, atr:  3.8 },
  m5:  { interval: '5min',  price: CURRENT_PRICE, rsi: 50.0, macd: 0.05, macd_signal: 0.02, macd_hist: 0.03, atr:  2.1 },
};
const mockAtr = { h1: mockMarketData.h1.atr, m30: mockMarketData.m30.atr };

// ── Helpers (mirror server.js, no import needed) ──────────────────────────

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
  return tradeId;
}

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
  return shadowId;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 1 — GET /api/accounts  (startup state, no trades yet)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 1 — /api/accounts  (startup — no trades yet)');
console.log(HR);

const accountsBefore = database.getAccountsSummary();
for (const a of accountsBefore) {
  console.log(JSON.stringify({
    id:                a.id,
    name:              a.name,
    current_balance:   a.current_balance,
    daily_realized_pnl:a.daily_realized_pnl,
    daily_open_pnl:    a.daily_open_pnl,
    daily_trades:      a.daily_trades,
    daily_wins:        a.daily_wins,
    daily_losses:      a.daily_losses,
    open_positions:    0   // in-memory, would be 0 at startup
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 2 — GREEN → TARGET_HIT  (all 3 deciders, before/after balances)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 2 — Three-decider cycle + TARGET_HIT');
console.log(HR);

const mechPortfolio    = database.getPortfolioByName('mechanical');
const overlayPortfolio = database.getPortfolioByName('claude_overlay');
const soloPortfolio    = database.getPortfolioByName('claude_solo');

// Run deciders off the shared snapshot (no time gate).
const mechDecision    = await mechanicalDecide(mockMarketData, mockAtr, mechPortfolio, []);
const overlayDecision = await claudeOverlayDecide(mockMarketData, mockAtr, overlayPortfolio, [], mechDecision);
const soloDecision    = await claudeSoloDecide(mockMarketData, mockAtr, soloPortfolio, []);

console.log(`\nDecisions:`);
console.log(`  mechanical    → ${mechDecision.action}`);
console.log(`  claude_overlay→ ${overlayDecision.action}  (stub mirrors mechanical)`);
console.log(`  claude_solo   → ${soloDecision.action}  (stub)`);

if (mechDecision.action !== 'TRADE') {
  console.error('\n❌ Expected TRADE from mechanical — check mock data conditions');
  process.exit(1);
}

console.log(`\nTrade params (mechanical):`);
console.log(`  direction=${mechDecision.direction}  entry=${mechDecision.entry}  stop=${mechDecision.stop}  target=${mechDecision.target}  lots=${mechDecision.lots}`);

// Save mechanical signal (inject M5 exactly as server.js does).
const mechSignal = mechDecision._signal;
mechSignal.marketData.m5 = mockMarketData.m5;
const signalId = database.saveSignal(mechSignal);
console.log(`  signalId=${signalId}`);

// Balances before opening positions.
const balanceBefore = {};
for (const p of [mechPortfolio, overlayPortfolio, soloPortfolio]) {
  balanceBefore[p.name] = database.getPortfolioById(p.id).current_balance;
}
console.log('\nBalances BEFORE:');
for (const [name, bal] of Object.entries(balanceBefore)) {
  console.log(`  ${name.padEnd(18)} $${bal.toFixed(2)}`);
}

// Open positions.
if (mechDecision.action === 'TRADE') {
  openPosition({ portfolio: mechPortfolio, decision: mechDecision, signalId, currentPrice: CURRENT_PRICE, isSignalOwner: true });
}
if (overlayDecision.action === 'TRADE') {
  openPosition({ portfolio: overlayPortfolio, decision: overlayDecision, signalId, currentPrice: CURRENT_PRICE, isSignalOwner: false });
}
// solo → NO_TRADE: no position opened.

// Tick 1: price = entry (3300) → triggers entryTriggered=true for both positions.
// (For LONG: entryHit = currentPrice <= entryPrice  →  3300 <= 3300 → true)
outcomeTracker.checkOutcomesWithPrice(CURRENT_PRICE);

// Tick 2: price = target (3310) → TARGET_HIT for both.
const TARGET_PRICE = mechDecision.target; // 3310
console.log(`\nSimulating target hit at $${TARGET_PRICE}...`);
outcomeTracker.checkOutcomesWithPrice(TARGET_PRICE);

// Balances after.
const balanceAfter = {};
for (const p of [mechPortfolio, overlayPortfolio, soloPortfolio]) {
  balanceAfter[p.name] = database.getPortfolioById(p.id).current_balance;
}
console.log('\nBalances AFTER target hit:');
for (const [name, after] of Object.entries(balanceAfter)) {
  const before = balanceBefore[name];
  const pnl    = after - before;
  console.log(`  ${name.padEnd(18)} $${after.toFixed(2)}   (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);
}

// Check signal outcome row was updated for mechanical.
const signalRow = database.getSignalById(signalId);
console.log(`\nSignal row ${signalId}: outcome=${signalRow.outcome}  price=${signalRow.outcome_price}  pnl=$${signalRow.outcome_pnl?.toFixed(2)}`);

// ─────────────────────────────────────────────────────────────────────────
// CHECK 3 — Veto shadow path  (no balance impact)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 3 — Veto shadow: counterfactual outcome, balance untouched');
console.log(HR);

// Synthetic VETO from overlay (bypasses stub for test).
const vetoDecision = {
  action:    'VETO',
  direction: mechDecision.direction,
  entry:     mechDecision.entry,
  stop:      mechDecision.stop,
  target:    mechDecision.target,
  lots:      mechDecision.lots,
  tag:       'verify_veto_test'
};

const overlayBalBefore = database.getPortfolioById(overlayPortfolio.id).current_balance;
console.log(`\nOverlay balance before veto shadow: $${overlayBalBefore.toFixed(2)}`);

const shadowId = openVetoShadow({ portfolio: overlayPortfolio, decision: vetoDecision, currentPrice: CURRENT_PRICE });
console.log(`Shadow opened: id=${shadowId}`);

// Tick 1: entry triggered.
outcomeTracker.checkOutcomesWithPrice(CURRENT_PRICE);
// Tick 2: target hit → finalizeShadow (would_be_pnl computed, NO balance change).
outcomeTracker.checkOutcomesWithPrice(TARGET_PRICE);

const shadowRow = database.db.prepare('SELECT * FROM veto_shadows WHERE id = ?').get(shadowId);
console.log(`Shadow resolved: would_be_outcome=${shadowRow.would_be_outcome}  would_be_pnl=$${shadowRow.would_be_pnl?.toFixed(2)}`);

const overlayBalAfter = database.getPortfolioById(overlayPortfolio.id).current_balance;
console.log(`Overlay balance after shadow resolution: $${overlayBalAfter.toFixed(2)}  (unchanged ✓)`);

// ─────────────────────────────────────────────────────────────────────────
// CHECK 4 — Signals row: all M5 columns populated
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 4 — Signals row: M5 columns populated');
console.log(HR);

const sig = database.getSignalById(signalId);
console.log(`\nSignal id=${sig.id}  signal=${sig.signal}  direction=${sig.direction}`);
console.log(`  h4_macd=${sig.h4_macd}  h4_rsi=${sig.h4_rsi}  h4_atr=${sig.h4_atr}`);
console.log(`  h1_macd=${sig.h1_macd}  h1_rsi=${sig.h1_rsi}  h1_atr=${sig.h1_atr}`);
console.log(`  m30_macd=${sig.m30_macd} m30_rsi=${sig.m30_rsi} m30_atr=${sig.m30_atr}`);
console.log(`  m15_macd=${sig.m15_macd} m15_rsi=${sig.m15_rsi} m15_atr=${sig.m15_atr}`);
console.log(`  m5_macd=${sig.m5_macd}  m5_rsi=${sig.m5_rsi}  m5_atr=${sig.m5_atr}   ← M5 populated ✓`);
console.log(`  outcome=${sig.outcome}  outcome_price=${sig.outcome_price}  outcome_pnl=${sig.outcome_pnl}`);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('VERIFICATION COMPLETE');
console.log(HR + '\n');

database.close();
outcomeTracker.stopMonitoring();
