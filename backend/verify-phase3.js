// verify-phase3.js — offline Phase 3 verification
// Tests: journal DB, win-rate in accounts, veto stats, mechanical skip,
//        reflection safety (no-key path), and — when a real key is present —
//        actual reflection calls + lesson feedback loop.
//
// Run:  cd backend && node verify-phase3.js
//       cd backend && CLAUDE_API_KEY=sk-ant-... node verify-phase3.js

import { unlink } from 'fs/promises';
import dotenv from 'dotenv';
dotenv.config();

// ── Temp DB — must be set BEFORE any dynamic imports ─────────────────────
const TEST_DB = '/tmp/gold-trader-verify-phase3.db';
process.env.DATABASE_PATH = TEST_DB;

for (const ext of ['', '-shm', '-wal']) {
  try { await unlink(`${TEST_DB}${ext}`); } catch {}
}

// ── Dynamic imports (DB singleton uses TEST_DB) ───────────────────────────
const { default: database }   = await import('./database.js');
const { reflect, reflectVeto } = await import('./deciders/reflector.js');

const KEY_LOOKS_REAL =
  typeof process.env.CLAUDE_API_KEY === 'string' &&
  process.env.CLAUDE_API_KEY.length > 20 &&
  !process.env.CLAUDE_API_KEY.includes('your_');

const HR = '─'.repeat(65);

let pass = 0, fail = 0;

function ok(label) {
  console.log(`  ✅  ${label}`);
  pass++;
}
function err(label, detail = '') {
  console.log(`  ❌  ${label}${detail ? `  (${detail})` : ''}`);
  fail++;
}
function check(label, cond, detail = '') {
  cond ? ok(label) : err(label, detail);
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 1 — Journal DB: write / read / losses-first / recurring / isolation
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 1 — Journal DB: write, read, ordering, recurring, isolation');
console.log(HR);

const solo    = database.getPortfolioByName('claude_solo');
const overlay = database.getPortfolioByName('claude_overlay');
const mech    = database.getPortfolioByName('mechanical');

// Write: solo gets a loss (tag A), a win (tag B), another loss (tag A → recurring)
database.saveJournalEntry({ portfolioId: solo.id, entryType: 'win',  lessonText: 'Win lesson.',  tag: 'tag_b', signalOrTradeId: null });
database.saveJournalEntry({ portfolioId: solo.id, entryType: 'loss', lessonText: 'Loss 1.',       tag: 'tag_a', signalOrTradeId: null });
database.saveJournalEntry({ portfolioId: solo.id, entryType: 'loss', lessonText: 'Loss 2 same.',  tag: 'tag_a', signalOrTradeId: null });

// Write: overlay gets one veto entry
database.saveJournalEntry({ portfolioId: overlay.id, entryType: 'veto', lessonText: 'Veto lesson.', tag: 'tag_v', signalOrTradeId: null });

const soloLessons    = database.getRecentLessons(solo.id);
const overlayLessons = database.getRecentLessons(overlay.id);
const mechLessons    = database.getRecentLessons(mech.id);

check('solo has 3 journal entries', soloLessons.length === 3, `got ${soloLessons.length}`);
check('overlay has 1 journal entry', overlayLessons.length === 1, `got ${overlayLessons.length}`);
check('mechanical has 0 journal entries', mechLessons.length === 0, `got ${mechLessons.length}`);

// Losses-first: first two entries must be losses
check('solo[0] is a loss (losses-first)', soloLessons[0].entry_type === 'loss', soloLessons[0]?.entry_type);
check('solo[1] is a loss (losses-first)', soloLessons[1].entry_type === 'loss', soloLessons[1]?.entry_type);
check('solo[2] is a win  (wins after)',   soloLessons[2].entry_type === 'win',  soloLessons[2]?.entry_type);

// Recurring: tag_a appears twice → recurring=true
check('tag_a entries marked recurring=true',
  soloLessons.filter(r => r.tag === 'tag_a').every(r => r.recurring === true));
check('tag_b entry marked recurring=false',
  soloLessons.find(r => r.tag === 'tag_b')?.recurring === false);

// Portfolio isolation
check('overlay lessons contain only veto entry', overlayLessons[0]?.entry_type === 'veto');
check('overlay lessons do not bleed into solo', !soloLessons.some(r => r.entry_type === 'veto'));

console.log(`\nSolo lessons preview:`);
for (const r of soloLessons) {
  console.log(`  [${r.entry_type.padEnd(11)} tag=${r.tag} recurring=${r.recurring}]  "${r.lesson_text}"`);
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 2 — /api/accounts: win_rate from closed trades
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 2 — /api/accounts: win_rate computed from closed trades');
console.log(HR);

// Insert 2 wins + 1 loss for solo, 1 win for overlay, nothing for mechanical
const nowIso = new Date().toISOString();

// solo: 3 trades (2 wins, 1 loss)
database.db.prepare(`
  INSERT INTO trades (portfolio_id, timestamp, direction, entry_price, lot_size, exit_price, exit_timestamp, exit_reason, pnl)
  VALUES (?, ?, 'LONG', 3300, 0.10, 3310, ?, 'TARGET_HIT', ?)
`).run(solo.id, nowIso, nowIso, 100);
database.db.prepare(`
  INSERT INTO trades (portfolio_id, timestamp, direction, entry_price, lot_size, exit_price, exit_timestamp, exit_reason, pnl)
  VALUES (?, ?, 'LONG', 3300, 0.10, 3310, ?, 'TARGET_HIT', ?)
`).run(solo.id, nowIso, nowIso, 100);
database.db.prepare(`
  INSERT INTO trades (portfolio_id, timestamp, direction, entry_price, lot_size, exit_price, exit_timestamp, exit_reason, pnl)
  VALUES (?, ?, 'LONG', 3300, 0.10, 3290, ?, 'STOP_HIT', ?)
`).run(solo.id, nowIso, nowIso, -100);

// overlay: 1 win
database.db.prepare(`
  INSERT INTO trades (portfolio_id, timestamp, direction, entry_price, lot_size, exit_price, exit_timestamp, exit_reason, pnl)
  VALUES (?, ?, 'SHORT', 3350, 0.05, 3330, ?, 'TARGET_HIT', ?)
`).run(overlay.id, nowIso, nowIso, 100);

const accounts = database.getAccountsSummary();
const soloAcc    = accounts.find(a => a.name === 'claude_solo');
const overlayAcc = accounts.find(a => a.name === 'claude_overlay');
const mechAcc    = accounts.find(a => a.name === 'mechanical');

console.log('\ngetAccountsSummary():');
for (const a of accounts) {
  console.log(`  ${a.name.padEnd(18)} closed=${a.closed_trades} wins=${a.wins} losses=${a.losses} win_rate=${a.win_rate}`);
}

check('solo: closed_trades=3',   soloAcc?.closed_trades === 3,   `got ${soloAcc?.closed_trades}`);
check('solo: wins=2',            soloAcc?.wins === 2,            `got ${soloAcc?.wins}`);
check('solo: losses=1',          soloAcc?.losses === 1,          `got ${soloAcc?.losses}`);
check('solo: win_rate=66.7',     soloAcc?.win_rate === 66.7,     `got ${soloAcc?.win_rate}`);
check('overlay: closed_trades=1',overlayAcc?.closed_trades === 1,`got ${overlayAcc?.closed_trades}`);
check('overlay: win_rate=100',   overlayAcc?.win_rate === 100,   `got ${overlayAcc?.win_rate}`);
check('mech: win_rate=null (no trades)', mechAcc?.win_rate === null, `got ${mechAcc?.win_rate}`);

// ─────────────────────────────────────────────────────────────────────────
// CHECK 3 — Veto stats: getVetoStats after shadow outcomes
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 3 — Veto stats: getVetoStats counts correctly');
console.log(HR);

// Insert shadow rows directly (overlay): 2 correct (STOP_HIT avoided), 1 missed (TARGET_HIT)
database.db.prepare(`
  INSERT INTO veto_shadows (portfolio_id, timestamp, direction, entry, stop, target, would_be_outcome, would_be_pnl)
  VALUES (?, ?, 'LONG', 3300, 3290, 3320, 'STOP_HIT', -100)
`).run(overlay.id, nowIso);
database.db.prepare(`
  INSERT INTO veto_shadows (portfolio_id, timestamp, direction, entry, stop, target, would_be_outcome, would_be_pnl)
  VALUES (?, ?, 'LONG', 3300, 3290, 3320, 'STOP_HIT', -100)
`).run(overlay.id, nowIso);
database.db.prepare(`
  INSERT INTO veto_shadows (portfolio_id, timestamp, direction, entry, stop, target, would_be_outcome, would_be_pnl)
  VALUES (?, ?, 'LONG', 3300, 3290, 3320, 'TARGET_HIT', 200)
`).run(overlay.id, nowIso);

// Solo: no shadow rows
const overlayVetoStats = database.getVetoStats(overlay.id);
const soloVetoStats    = database.getVetoStats(solo.id);
const mechVetoStats    = database.getVetoStats(mech.id);

console.log('\ngetVetoStats():');
console.log(`  overlay  ${JSON.stringify(overlayVetoStats)}`);
console.log(`  solo     ${JSON.stringify(soloVetoStats)}`);
console.log(`  mech     ${JSON.stringify(mechVetoStats)}`);

check('overlay: veto_count=3',         overlayVetoStats.veto_count === 3,         `got ${overlayVetoStats.veto_count}`);
check('overlay: correctly_avoided=2',  overlayVetoStats.correctly_avoided === 2,  `got ${overlayVetoStats.correctly_avoided}`);
check('overlay: missed_wins=1',        overlayVetoStats.missed_wins === 1,        `got ${overlayVetoStats.missed_wins}`);
check('solo: veto_count=0',            soloVetoStats.veto_count === 0,            `got ${soloVetoStats.veto_count}`);
check('mech: veto_count=0',            mechVetoStats.veto_count === 0,            `got ${mechVetoStats.veto_count}`);

// ─────────────────────────────────────────────────────────────────────────
// CHECK 4 — Mechanical skip: reflect() silently ignores mechanical
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 4 — Mechanical skip: reflect() does not write for mechanical portfolio');
console.log(HR);

const mechTracking = {
  portfolioName: 'mechanical',
  portfolioId:   mech.id,
  direction:     'LONG',
  entryPrice:    3300,
  stopLoss:      3290,
  target:        3320,
  lots:          0.10,
  tag:           'verify_mech_test',
  reasoning:     'mechanical system signal',
  tradeId:       null,
  maxPrice:      3320,
  minPrice:      3295,
};

const journalCountBefore = database.db.prepare('SELECT COUNT(*) as n FROM journal').get().n;
await reflect(mechTracking, 'STOP_HIT', -100);
const journalCountAfter = database.db.prepare('SELECT COUNT(*) as n FROM journal').get().n;

check('reflect(mechanical) wrote no journal entries',
  journalCountAfter === journalCountBefore,
  `count was ${journalCountBefore}, now ${journalCountAfter}`);

// ─────────────────────────────────────────────────────────────────────────
// CHECK 5 — Reflection safety: no API key → callReflector fails → no write
//   (Only run when KEY_LOOKS_REAL is false — real key makes it succeed)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 5 — Reflection safety: failure falls back gracefully (no journal write)');
console.log(HR);

if (!KEY_LOOKS_REAL) {
  const soloTracking = {
    portfolioName: 'claude_solo',
    portfolioId:   solo.id,
    direction:     'LONG',
    entryPrice:    3300,
    stopLoss:      3290,
    target:        3320,
    lots:          0.10,
    tag:           'verify_safety_test',
    reasoning:     'safety test — no real key, expect failure',
    tradeId:       null,
    maxPrice:      3310,
    minPrice:      3295,
  };

  const cntBefore = database.db.prepare('SELECT COUNT(*) as n FROM journal').get().n;
  // This will fail (no/invalid API key) → callReflector returns null → no DB write
  await reflect(soloTracking, 'STOP_HIT', -100);
  const cntAfter = database.db.prepare('SELECT COUNT(*) as n FROM journal').get().n;

  check('reflect() failure path: no journal entry written', cntAfter === cntBefore,
    `count before=${cntBefore} after=${cntAfter}`);
  console.log('  ℹ️  (tested via auth failure — real key not present)');
} else {
  console.log('  ⏭️  Skipped (KEY_LOOKS_REAL=true — safety already guaranteed by try/catch in callReflector)');
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 6 — Real reflection (KEY_LOOKS_REAL only): solo STOP_HIT → lesson
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 6 — Real reflection: solo STOP_HIT → lesson in solo journal only');
console.log(HR);

if (KEY_LOOKS_REAL) {
  const cntSoloBefore    = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(solo.id).n;
  const cntOverlayBefore = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(overlay.id).n;

  const soloLossTracking = {
    portfolioName: 'claude_solo',
    portfolioId:   solo.id,
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
  };

  console.log('  🤖 Calling reflect() for solo STOP_HIT…');
  await reflect(soloLossTracking, 'STOP_HIT', -100);

  const cntSoloAfter    = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(solo.id).n;
  const cntOverlayAfter = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(overlay.id).n;

  check('solo journal grew by 1',    cntSoloAfter === cntSoloBefore + 1,    `was ${cntSoloBefore} now ${cntSoloAfter}`);
  check('overlay journal unchanged', cntOverlayAfter === cntOverlayBefore,  `was ${cntOverlayBefore} now ${cntOverlayAfter}`);

  const newest = database.db.prepare(
    `SELECT * FROM journal WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1`
  ).get(solo.id);
  check('entry_type is loss or observation', ['loss','observation'].includes(newest?.entry_type), newest?.entry_type);
  check('lesson_text non-empty', (newest?.lesson_text || '').length > 10, newest?.lesson_text?.slice(0,40));
  check('tag non-empty',         (newest?.tag || '').length > 0,          newest?.tag);
  console.log(`\n  Lesson: "${newest?.lesson_text}"`);
  console.log(`  Tag:    ${newest?.tag}  |  type: ${newest?.entry_type}`);
} else {
  console.log('  ⏭️  Skipped (no real API key — set CLAUDE_API_KEY to test live reflection)');
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 7 — Real veto reflection (KEY_LOOKS_REAL only): veto shadow → lesson
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 7 — Real veto reflection: veto shadow resolution → veto entry');
console.log(HR);

if (KEY_LOOKS_REAL) {
  const cntBefore = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(solo.id).n;

  const shadow = {
    portfolioName: 'claude_solo',
    portfolioId:   solo.id,
    direction:     'SHORT',
    entryPrice:    3320.00,
    stopLoss:      3330.00,
    target:        3300.00,
    lots:          0.10,
    tag:           'overbought_rejection_veto',
    reasoning:     'H1 RSI 72, overbought; mechanical was late; vetoed on risk of snap-back.',
    shadowId:      999,
  };

  console.log('  🤖 Calling reflectVeto() for solo (would_be_outcome=STOP_HIT → correct veto)…');
  await reflectVeto(shadow, 'STOP_HIT', -100);

  const cntAfter = database.db.prepare('SELECT COUNT(*) as n FROM journal WHERE portfolio_id = ?').get(solo.id).n;
  check('solo journal grew by 1 (veto entry)', cntAfter === cntBefore + 1, `was ${cntBefore} now ${cntAfter}`);

  const vetoEntry = database.db.prepare(
    `SELECT * FROM journal WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1`
  ).get(solo.id);
  check('entry_type is veto',       vetoEntry?.entry_type === 'veto',       vetoEntry?.entry_type);
  check('lesson_text non-empty',    (vetoEntry?.lesson_text || '').length > 10, vetoEntry?.lesson_text?.slice(0,40));
  check('tag non-empty',            (vetoEntry?.tag || '').length > 0,      vetoEntry?.tag);
  console.log(`\n  Veto lesson: "${vetoEntry?.lesson_text}"`);
  console.log(`  Tag: ${vetoEntry?.tag}`);
} else {
  console.log('  ⏭️  Skipped (no real API key)');
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 8 — Lessons feedback: getRecentLessons returns real lessons (KEY_LOOKS_REAL)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('CHECK 8 — Lessons feedback: getRecentLessons populates lesson block for next cycle');
console.log(HR);

if (KEY_LOOKS_REAL) {
  const lessons = database.getRecentLessons(solo.id, 8);
  check('getRecentLessons returns at least 1 real lesson',
    lessons.some(l => l.lesson_text.length > 20));
  check('losses/veto entries sort before wins',
    !lessons.some((l, i) => {
      if (l.entry_type === 'win') {
        return lessons.slice(0, i).some(prev => prev.entry_type === 'loss' || prev.entry_type === 'veto');
      }
      return false; // only flag if win appears before a loss/veto
    }) || lessons.length === 0
  );
  console.log(`\n  Lessons slice (${lessons.length} entries):`);
  for (const l of lessons) {
    console.log(`  [${l.entry_type.padEnd(11)} recurring=${String(l.recurring).padEnd(5)} tag=${l.tag}]`);
  }
} else {
  // Offline: rely on Check 1 journal entries (written directly to DB)
  const lessons = database.getRecentLessons(solo.id, 8);
  check('getRecentLessons returns entries from DB (offline fixtures)',
    lessons.length >= 3, `got ${lessons.length}`);
  check('lesson_text and tag present on all rows',
    lessons.every(l => l.lesson_text && l.tag),
    'some rows missing lesson_text or tag');
  console.log(`\n  Lessons slice (${lessons.length} entries, from offline fixtures):`);
  for (const l of lessons) {
    console.log(`  [${l.entry_type.padEnd(11)} recurring=${String(l.recurring).padEnd(5)} tag=${l.tag}]`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + HR);
console.log('PHASE 3 VERIFICATION SUMMARY');
console.log(HR);
console.log(`  Passed : ${pass}`);
console.log(`  Failed : ${fail}`);
console.log(`  API key: ${KEY_LOOKS_REAL ? 'real (online checks ran)' : 'missing (offline checks only)'}`);
if (fail > 0) {
  console.log('\n  ⚠️  One or more checks failed — review output above.\n');
} else {
  console.log('\n  ✅  All checks passed.\n');
}

database.close();
