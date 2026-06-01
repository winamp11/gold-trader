/**
 * verify-window-close.js — offline mock test for the window-close force-close sweep.
 *
 * Simulates a session end with three accounts:
 *   mechanical  — SHORT @ 3300 (entry triggered), bell price 3289.50 → profitable
 *   claude_solo — LONG  @ 3250 (entry triggered), bell price 3289.50 → profitable
 *   overlay     — veto shadow SHORT @ 3300 (entry triggered)         → would-be profitable
 *
 * Expected after forceCloseAll(BELL_PRICE):
 *   ✓ Both positions closed with exit_reason = WINDOW_CLOSE
 *   ✓ P&L computed at bell price using standard contract math ($100/$1/lot)
 *   ✓ Balances debited/credited on both accounts
 *   ✓ Daily P&L rows created with correct win counts
 *   ✓ Shadow resolved with would_be_outcome = WINDOW_CLOSE
 *   ✓ No positions remain in the in-memory tracker
 */

import { tmpdir }    from 'os';
import { join }      from 'path';
import { unlinkSync } from 'fs';

// DATABASE_PATH must be set before any module imports the DB singleton
const testDbPath = join(tmpdir(), `gold-trader-wc-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: database }       = await import('./database.js');
const { default: outcomeTracker } = await import('./outcomeTracker.js');

// ── Constants ──────────────────────────────────────────────────────────────
const BELL_PRICE    = 3289.50;
const MECH_ENTRY    = 3300.00;  // SHORT → profit when bell < entry
const SOLO_ENTRY    = 3250.00;  // LONG  → profit when bell > entry
const LOT_SIZE      = 0.01;
const TICKS_PER_PT  = 100;      // $100/$1/lot

const mechExpectedPnl   = Math.round((MECH_ENTRY - BELL_PRICE) * TICKS_PER_PT * LOT_SIZE * 100) / 100;
const soloExpectedPnl   = Math.round((BELL_PRICE - SOLO_ENTRY) * TICKS_PER_PT * LOT_SIZE * 100) / 100;
const shadowExpectedPnl = Math.round((MECH_ENTRY - BELL_PRICE) * TICKS_PER_PT * LOT_SIZE * 100) / 100;

// ── Get seeded portfolios ──────────────────────────────────────────────────
const mechPortfolio    = database.getPortfolioByName('mechanical');
const overlayPortfolio = database.getPortfolioByName('claude_overlay');
const soloPortfolio    = database.getPortfolioByName('claude_solo');

// ── Seed a fake mechanical signal ─────────────────────────────────────────
const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
const mechSignalId = database.db.prepare(
  `INSERT INTO signals (timestamp, signal, direction, entry_price) VALUES (?, 'GREEN', 'SHORT', ?)`
).run(openedAt, MECH_ENTRY).lastInsertRowid;

// ── Create trade rows (as server.js would on openPosition) ─────────────────
const mechTradeId = database.saveTrade({
  signal_id:    mechSignalId,
  portfolio_id: mechPortfolio.id,
  timestamp:    openedAt,
  direction:    'SHORT',
  entry_price:  MECH_ENTRY,
  lot_size:     LOT_SIZE,
  stop_loss:    3320.00,
  take_profit:  3275.00,
  decider:      'mechanical',
  tag:          'wc_test',
});

const soloTradeId = database.saveTrade({
  signal_id:    null,
  portfolio_id: soloPortfolio.id,
  timestamp:    openedAt,
  direction:    'LONG',
  entry_price:  SOLO_ENTRY,
  lot_size:     LOT_SIZE,
  stop_loss:    3230.00,
  take_profit:  3280.00,
  decider:      'claude_solo',
  tag:          'wc_test',
});

// ── Create overlay veto shadow ─────────────────────────────────────────────
const shadowId = database.saveVetoShadow({
  portfolioId: overlayPortfolio.id,
  direction:   'SHORT',
  entry:       MECH_ENTRY,
  stop:        3320.00,
  target:      3275.00,
  tag:         'wc_test',
});

// ── Populate in-memory tracker ─────────────────────────────────────────────
const mechKey   = `${mechPortfolio.id}_${mechSignalId}`;
const soloKey   = `${soloPortfolio.id}_solo_wc_test`;
const shadowKey = `shadow_${shadowId}`;

outcomeTracker.startTracking(mechKey, {
  key: mechKey, portfolioId: mechPortfolio.id, portfolioName: 'mechanical',
  signalId: mechSignalId, tradeId: mechTradeId, type: 'GREEN',
  direction: 'SHORT', lots: LOT_SIZE,
  startPrice: 3301, entryPrice: MECH_ENTRY, stopLoss: 3320, target: 3275,
  tag: 'wc_test', startTime: new Date(Date.now() - 3600_000),
  entryTriggered: true, outcome: null, maxPrice: 3305, minPrice: 3285,
});

outcomeTracker.startTracking(soloKey, {
  key: soloKey, portfolioId: soloPortfolio.id, portfolioName: 'claude_solo',
  signalId: null, tradeId: soloTradeId, type: 'GREEN',
  direction: 'LONG', lots: LOT_SIZE,
  startPrice: 3248, entryPrice: SOLO_ENTRY, stopLoss: 3230, target: 3280,
  tag: 'wc_test', startTime: new Date(Date.now() - 3600_000),
  entryTriggered: true, outcome: null, maxPrice: 3295, minPrice: 3248,
});

outcomeTracker.startShadow(shadowKey, {
  key: shadowKey, shadowId, portfolioId: overlayPortfolio.id, portfolioName: 'claude_overlay',
  direction: 'SHORT', lots: LOT_SIZE,
  startPrice: 3301, entryPrice: MECH_ENTRY, stopLoss: 3320, target: 3275,
  tag: 'wc_test', startTime: new Date(Date.now() - 3600_000),
  entryTriggered: true, maxPrice: 3305, minPrice: 3285,
});

// ── Capture BEFORE state ───────────────────────────────────────────────────
const mechBefore = database.getPortfolioByName('mechanical');
const soloBefore = database.getPortfolioByName('claude_solo');

console.log('\n' + '═'.repeat(62));
console.log('  verify-window-close.js — offline simulation');
console.log('═'.repeat(62));
console.log('\n── BEFORE ──────────────────────────────────────────────────');
console.log(`  Mechanical balance:  $${mechBefore.current_balance.toFixed(2)}`);
console.log(`  Solo balance:        $${soloBefore.current_balance.toFixed(2)}`);
console.log(`  Active tracking:     ${outcomeTracker.activeTracking.size} (mech SHORT, solo LONG)`);
console.log(`  Shadow tracking:     ${outcomeTracker.shadowTracking.size} (overlay SHORT shadow)`);
console.log(`  Bell price:          $${BELL_PRICE}`);
console.log(`  Expected mech P&L:   ${mechExpectedPnl >= 0 ? '+' : ''}$${mechExpectedPnl.toFixed(2)}  (${MECH_ENTRY} - ${BELL_PRICE}) × ${TICKS_PER_PT} × ${LOT_SIZE}`);
console.log(`  Expected solo P&L:   ${soloExpectedPnl >= 0 ? '+' : ''}$${soloExpectedPnl.toFixed(2)}  (${BELL_PRICE} - ${SOLO_ENTRY}) × ${TICKS_PER_PT} × ${LOT_SIZE}`);

// ── Run force-close ────────────────────────────────────────────────────────
console.log('\n── forceCloseAll($' + BELL_PRICE + ') ─────────────────────────────');
outcomeTracker.forceCloseAll(BELL_PRICE);

// ── Capture AFTER state ────────────────────────────────────────────────────
const mechAfter   = database.getPortfolioByName('mechanical');
const soloAfter   = database.getPortfolioByName('claude_solo');
const mechTrade   = database.db.prepare('SELECT * FROM trades WHERE id = ?').get(mechTradeId);
const soloTrade   = database.db.prepare('SELECT * FROM trades WHERE id = ?').get(soloTradeId);
const shadow      = database.db.prepare('SELECT * FROM veto_shadows WHERE id = ?').get(shadowId);
const today       = new Date().toISOString().split('T')[0];
const mechDaily   = database.db.prepare('SELECT * FROM account_pnl_daily WHERE portfolio_id = ? AND date = ?').get(mechPortfolio.id, today);
const soloDaily   = database.db.prepare('SELECT * FROM account_pnl_daily WHERE portfolio_id = ? AND date = ?').get(soloPortfolio.id, today);

console.log('\n── AFTER ───────────────────────────────────────────────────');
console.log(`  Mechanical balance:  $${mechAfter.current_balance.toFixed(2)}  (expected $${(100000 + mechExpectedPnl).toFixed(2)})`);
console.log(`  Solo balance:        $${soloAfter.current_balance.toFixed(2)}  (expected $${(100000 + soloExpectedPnl).toFixed(2)})`);
console.log(`  Active tracking:     ${outcomeTracker.activeTracking.size}  (expected 0)`);
console.log(`  Shadow tracking:     ${outcomeTracker.shadowTracking.size}  (expected 0)`);
console.log('\n  Mechanical trade:');
console.log(`    exit_reason = ${mechTrade.exit_reason}  (expected WINDOW_CLOSE)`);
console.log(`    exit_price  = $${mechTrade.exit_price?.toFixed(2)}  (expected $${BELL_PRICE})`);
console.log(`    pnl         = ${mechTrade.pnl >= 0 ? '+' : ''}$${mechTrade.pnl?.toFixed(2)}  (expected +$${mechExpectedPnl.toFixed(2)})`);
console.log('\n  Solo trade:');
console.log(`    exit_reason = ${soloTrade.exit_reason}  (expected WINDOW_CLOSE)`);
console.log(`    exit_price  = $${soloTrade.exit_price?.toFixed(2)}  (expected $${BELL_PRICE})`);
console.log(`    pnl         = ${soloTrade.pnl >= 0 ? '+' : ''}$${soloTrade.pnl?.toFixed(2)}  (expected +$${soloExpectedPnl.toFixed(2)})`);
console.log('\n  Overlay shadow:');
console.log(`    would_be_outcome = ${shadow.would_be_outcome}  (expected WINDOW_CLOSE)`);
console.log(`    would_be_pnl     = ${shadow.would_be_pnl >= 0 ? '+' : ''}$${shadow.would_be_pnl?.toFixed(2)}  (expected +$${shadowExpectedPnl.toFixed(2)})`);
console.log('\n  Daily P&L rows:');
console.log(`    Mechanical: trades=${mechDaily?.trades_count}, wins=${mechDaily?.wins}, losses=${mechDaily?.losses}, realized_pnl=$${mechDaily?.realized_pnl?.toFixed(2)}`);
console.log(`    Solo:       trades=${soloDaily?.trades_count}, wins=${soloDaily?.wins}, losses=${soloDaily?.losses}, realized_pnl=$${soloDaily?.realized_pnl?.toFixed(2)}`);

// ── Assertions ─────────────────────────────────────────────────────────────
console.log('\n── ASSERTIONS ──────────────────────────────────────────────');
let pass = true;
function assert(condition, msg) {
  if (!condition) { console.error('  ❌ FAIL:', msg); pass = false; }
  else             console.log('  ✅      ', msg);
}

const ε = 0.005;

assert(outcomeTracker.activeTracking.size === 0,
  'No positions remain in tracker');
assert(outcomeTracker.shadowTracking.size === 0,
  'No shadows remain in tracker');

assert(mechTrade.exit_reason === 'WINDOW_CLOSE',
  `Mechanical exit_reason = WINDOW_CLOSE (got ${mechTrade.exit_reason})`);
assert(soloTrade.exit_reason === 'WINDOW_CLOSE',
  `Solo exit_reason = WINDOW_CLOSE (got ${soloTrade.exit_reason})`);

assert(Math.abs(mechTrade.exit_price - BELL_PRICE) < ε,
  `Mechanical exit_price = $${BELL_PRICE}`);
assert(Math.abs(soloTrade.exit_price - BELL_PRICE) < ε,
  `Solo exit_price = $${BELL_PRICE}`);

assert(Math.abs(mechTrade.pnl - mechExpectedPnl) < ε,
  `Mechanical P&L = +$${mechExpectedPnl.toFixed(2)}`);
assert(Math.abs(soloTrade.pnl - soloExpectedPnl) < ε,
  `Solo P&L = +$${soloExpectedPnl.toFixed(2)}`);

assert(Math.abs(mechAfter.current_balance - (100000 + mechExpectedPnl)) < ε,
  `Mechanical balance = $${(100000 + mechExpectedPnl).toFixed(2)}`);
assert(Math.abs(soloAfter.current_balance - (100000 + soloExpectedPnl)) < ε,
  `Solo balance = $${(100000 + soloExpectedPnl).toFixed(2)}`);

assert(shadow.would_be_outcome === 'WINDOW_CLOSE',
  `Shadow would_be_outcome = WINDOW_CLOSE (got ${shadow.would_be_outcome})`);
assert(Math.abs(shadow.would_be_pnl - shadowExpectedPnl) < ε,
  `Shadow would_be_pnl = +$${shadowExpectedPnl.toFixed(2)}`);

assert(mechDaily?.trades_count === 1,
  'Mechanical daily trades_count = 1');
assert(mechDaily?.wins === 1,
  `Mechanical daily win counted (P&L > 0)`);
assert(Math.abs((mechDaily?.realized_pnl ?? 0) - mechExpectedPnl) < ε,
  `Mechanical daily realized_pnl = $${mechExpectedPnl.toFixed(2)}`);

assert(soloDaily?.trades_count === 1,
  'Solo daily trades_count = 1');
assert(soloDaily?.wins === 1,
  `Solo daily win counted (P&L > 0)`);
assert(Math.abs((soloDaily?.realized_pnl ?? 0) - soloExpectedPnl) < ε,
  `Solo daily realized_pnl = $${soloExpectedPnl.toFixed(2)}`);

console.log('\n' + '═'.repeat(62));
console.log(pass
  ? '  ✅ ALL ASSERTIONS PASSED'
  : '  ❌ SOME ASSERTIONS FAILED');
console.log('═'.repeat(62) + '\n');

// ── Cleanup ─────────────────────────────────────────────────────────────────
outcomeTracker.stopMonitoring();
database.close();
unlinkSync(testDbPath);
