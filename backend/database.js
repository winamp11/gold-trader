import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseService {
  constructor() {
    // Use persistent volume if available (Railway), otherwise local file
    const dbPath = process.env.DATABASE_PATH || join(__dirname, 'trading.db');
    this.db = new Database(dbPath);
    this.initialize();
    console.log(`✅ Database initialized at ${dbPath}`);
  }

  initialize() {
    // Signals table - stores every signal generated
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        signal TEXT NOT NULL,
        direction TEXT,
        entry_price REAL,
        stop_loss REAL,
        target REAL,
        position_size REAL,
        risk_amount REAL,
        potential_profit REAL,
        confidence TEXT,
        reasoning TEXT,
        
        h4_macd REAL,
        h4_rsi REAL,
        h4_atr REAL,
        h1_macd REAL,
        h1_rsi REAL,
        h1_atr REAL,
        m30_macd REAL,
        m30_rsi REAL,
        m30_atr REAL,
        m15_macd REAL,
        m15_rsi REAL,
        m15_atr REAL,
        m5_macd REAL,
        m5_rsi REAL,
        m5_atr REAL,

        outcome TEXT,
        outcome_timestamp TEXT,
        outcome_price REAL,
        outcome_pnl REAL,
        outcome_metadata TEXT
      )
    `);

    // Migrate existing databases: drop MFI columns, add ATR columns
    const sigCols = this.db.prepare('PRAGMA table_info(signals)').all().map(c => c.name);
    for (const col of ['h4_mfi', 'h1_mfi', 'm30_mfi', 'm15_mfi']) {
      if (sigCols.includes(col)) {
        this.db.exec(`ALTER TABLE signals DROP COLUMN ${col}`);
        console.log(`🔧 Migrated: dropped signals.${col}`);
      }
    }
    for (const col of ['h4_atr', 'h1_atr', 'm30_atr', 'm15_atr', 'm5_macd', 'm5_rsi', 'm5_atr']) {
      if (!sigCols.includes(col)) {
        this.db.exec(`ALTER TABLE signals ADD COLUMN ${col} REAL`);
        console.log(`🔧 Migrated: added signals.${col}`);
      }
    }

    // Autochartist patterns table - stores manually logged patterns from Autochartist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autochartist_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_type TEXT NOT NULL,
        time_identified TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        success_probability REAL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        target REAL NOT NULL,
        current_price_at_log REAL,
        our_signal_at_time TEXT,
        outcome TEXT,
        outcome_timestamp TEXT,
        outcome_price REAL,
        outcome_pnl REAL,
        logged_at TEXT NOT NULL
      )
    `);

    // Trades table - one row per simulated position, per portfolio
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER,
        portfolio_id INTEGER DEFAULT 1,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        lot_size REAL NOT NULL,
        stop_loss REAL,
        take_profit REAL,
        pnl REAL,
        exit_timestamp TEXT,
        exit_reason TEXT,
        notes TEXT,
        decider TEXT,
        tag TEXT,
        FOREIGN KEY (signal_id) REFERENCES signals(id),
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    // Migrate trades table — add portfolio_id, decider, tag (for DBs created before Phase 1)
    const tradeCols = this.db.prepare('PRAGMA table_info(trades)').all().map(c => c.name);
    for (const [col, def] of [['portfolio_id', 'INTEGER DEFAULT 1'], ['decider', 'TEXT'], ['tag', 'TEXT']]) {
      if (!tradeCols.includes(col)) {
        this.db.exec(`ALTER TABLE trades ADD COLUMN ${col} ${def}`);
        console.log(`🔧 Migrated: added trades.${col}`);
      }
    }

    // Account snapshots - daily balance tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        balance REAL NOT NULL,
        daily_pnl REAL,
        trades_count INTEGER,
        win_rate REAL
      )
    `);

    // Virtual portfolios - one row per paper-trading account
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        starting_balance REAL NOT NULL,
        current_balance REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Seed all three portfolios — idempotent via OR IGNORE + UNIQUE(name)
    this.db.exec(`
      INSERT OR IGNORE INTO portfolios (name, starting_balance, current_balance) VALUES
        ('mechanical',     100000, 100000),
        ('claude_overlay', 100000, 100000),
        ('claude_solo',    100000, 100000)
    `);

    // Veto shadow tracking — counterfactual outcomes for VETO decisions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS veto_shadows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        target REAL NOT NULL,
        would_be_outcome TEXT,
        would_be_pnl REAL,
        shadow_metadata TEXT,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    // Daily P&L roll-up per portfolio
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_pnl_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        portfolio_id INTEGER NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        open_pnl REAL NOT NULL DEFAULT 0,
        trades_count INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        UNIQUE(date, portfolio_id),
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    console.log('✅ Database initialized');
  }

  saveSignal(signalData) {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        timestamp, signal, direction, entry_price, stop_loss, target,
        position_size, risk_amount, potential_profit, confidence, reasoning,
        h4_macd, h4_rsi, h4_atr,
        h1_macd, h1_rsi, h1_atr,
        m30_macd, m30_rsi, m30_atr,
        m15_macd, m15_rsi, m15_atr,
        m5_macd, m5_rsi, m5_atr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rec = signalData.recommendation || {};
    const tf = signalData.timeframes || {};
    const md = signalData.marketData || {};

    const info = stmt.run(
      signalData.timestamp,
      signalData.signal,
      rec.direction || null,
      rec.entry || null,
      rec.stop || null,
      rec.target || null,
      rec.positionSize || null,
      rec.riskAmount || null,
      rec.potentialProfit || null,
      rec.confidence || null,
      rec.reasoning || signalData.reason || null,
      tf.h4?.macd ?? null,
      tf.h4?.rsi ?? null,
      md.h4?.atr ?? null,
      tf.h1?.macd ?? null,
      tf.h1?.rsi ?? null,
      md.h1?.atr ?? null,
      tf.m30?.macd ?? null,
      tf.m30?.rsi ?? null,
      md.m30?.atr ?? null,
      tf.m15?.macd ?? null,
      tf.m15?.rsi ?? null,
      md.m15?.atr ?? null,
      md.m5?.macd ?? null,
      md.m5?.rsi ?? null,
      md.m5?.atr ?? null
    );

    console.log(`💾 Signal saved to database (ID: ${info.lastInsertRowid})`);
    return info.lastInsertRowid;
  }

  getRecentSignals(limit = 10) {
    const stmt = this.db.prepare(`
      SELECT * FROM signals 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getAllSignals() {
    const stmt = this.db.prepare(`
      SELECT * FROM signals 
      ORDER BY timestamp DESC
    `);
    return stmt.all();
  }

  getSignalById(id) {
    const stmt = this.db.prepare('SELECT * FROM signals WHERE id = ?');
    return stmt.get(id);
  }

  updateSignalOutcome(signalId, outcomeData) {
    const stmt = this.db.prepare(`
      UPDATE signals 
      SET outcome = ?, outcome_timestamp = ?, outcome_price = ?, outcome_pnl = ?, outcome_metadata = ?
      WHERE id = ?
    `);

    stmt.run(
      outcomeData.outcome,
      outcomeData.outcome_timestamp,
      outcomeData.outcome_price || null,
      outcomeData.outcome_pnl || null,
      outcomeData.metadata || null,
      signalId
    );

    console.log(`💾 Signal ${signalId} outcome updated: ${outcomeData.outcome}`);
  }

  getSignalPerformance(days = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString();

    const stmt = this.db.prepare(`
      SELECT 
        signal,
        outcome,
        COUNT(*) as count
      FROM signals 
      WHERE timestamp >= ?
      GROUP BY signal, outcome
    `);

    const results = stmt.all(cutoff);

    // Calculate stats
    const stats = {
      green: { total: 0, wins: 0, losses: 0, noEntry: 0, pending: 0 },
      red: { total: 0, correct: 0, missed: 0, pending: 0 }
    };

    results.forEach(row => {
      if (row.signal === 'GREEN') {
        stats.green.total += row.count;
        if (row.outcome === 'TARGET_HIT') stats.green.wins += row.count;
        else if (row.outcome === 'STOP_HIT') stats.green.losses += row.count;
        else if (row.outcome === 'NO_ENTRY') stats.green.noEntry += row.count;
        else stats.green.pending += row.count;
      } else if (row.signal === 'RED') {
        stats.red.total += row.count;
        if (row.outcome === 'CORRECT_RED') stats.red.correct += row.count;
        else if (row.outcome === 'MISSED_OPPORTUNITY') stats.red.missed += row.count;
        else stats.red.pending += row.count;
      }
    });

    // Calculate percentages
    if (stats.green.total > 0) {
      stats.green.winRate = ((stats.green.wins / stats.green.total) * 100).toFixed(1);
    }
    if (stats.red.total > 0) {
      stats.red.missedRate = ((stats.red.missed / stats.red.total) * 100).toFixed(1);
    }

    return stats;
  }

  saveTrade(tradeData) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        signal_id, portfolio_id, timestamp, direction, entry_price, lot_size,
        stop_loss, take_profit, notes, decider, tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      tradeData.signal_id || null,
      tradeData.portfolio_id || 1,
      tradeData.timestamp,
      tradeData.direction,
      tradeData.entry_price,
      tradeData.lot_size,
      tradeData.stop_loss || null,
      tradeData.take_profit || null,
      tradeData.notes || null,
      tradeData.decider || null,
      tradeData.tag || null
    );

    console.log(`💾 Trade saved (ID: ${info.lastInsertRowid}, portfolio: ${tradeData.portfolio_id || 1})`);
    return info.lastInsertRowid;
  }

  updateTradeExit(tradeId, exitData) {
    const stmt = this.db.prepare(`
      UPDATE trades 
      SET exit_price = ?, exit_timestamp = ?, exit_reason = ?, pnl = ?
      WHERE id = ?
    `);

    stmt.run(
      exitData.exit_price,
      exitData.exit_timestamp,
      exitData.exit_reason || null,
      exitData.pnl,
      tradeId
    );

    console.log(`💾 Trade ${tradeId} updated with exit`);
  }

  getRecentTrades(limit = 20) {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    
    const trades = this.db.prepare(`
      SELECT * FROM trades 
      WHERE date(timestamp) = ?
    `).all(today);

    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const completedTrades = trades.filter(t => t.exit_price !== null);
    const wins = completedTrades.filter(t => (t.pnl || 0) > 0).length;
    const winRate = completedTrades.length > 0 ? (wins / completedTrades.length) * 100 : 0;

    return {
      date: today,
      tradesCount: trades.length,
      completedTrades: completedTrades.length,
      pnl: totalPnl,
      winRate: winRate.toFixed(1)
    };
  }

  updateAccountSnapshot(date, balance, dailyPnl, tradesCount, winRate) {
    const stmt = this.db.prepare(`
      INSERT INTO account_snapshots (date, balance, daily_pnl, trades_count, win_rate)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        balance = excluded.balance,
        daily_pnl = excluded.daily_pnl,
        trades_count = excluded.trades_count,
        win_rate = excluded.win_rate
    `);

    stmt.run(date, balance, dailyPnl, tradesCount, winRate);
  }

  getAccountHistory(days = 30) {
    const stmt = this.db.prepare(`
      SELECT * FROM account_snapshots 
      ORDER BY date DESC 
      LIMIT ?
    `);
    return stmt.all(days);
  }

  // ===== AUTOCHARTIST PATTERNS =====
  
  saveAutochartistPattern(pattern) {
    const stmt = this.db.prepare(`
      INSERT INTO autochartist_patterns (
        pattern_type, time_identified, timeframe, success_probability,
        entry_price, stop_loss, target, current_price_at_log,
        our_signal_at_time, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      pattern.patternType,
      pattern.timeIdentified,
      pattern.timeframe,
      pattern.successProbability,
      pattern.entryPrice,
      pattern.stopLoss,
      pattern.target,
      pattern.currentPrice || null,
      pattern.ourSignal || null,
      new Date().toISOString()
    );

    return result.lastInsertRowid;
  }

  getAutochartistPatterns(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM autochartist_patterns 
      ORDER BY logged_at DESC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  updateAutochartistPatternOutcome(patternId, outcome, price, pnl) {
    const stmt = this.db.prepare(`
      UPDATE autochartist_patterns 
      SET outcome = ?, outcome_timestamp = ?, outcome_price = ?, outcome_pnl = ?
      WHERE id = ?
    `);

    stmt.run(outcome, new Date().toISOString(), price, pnl, patternId);
  }

  // ===== PORTFOLIO ACCOUNTING =====

  getMechanicalPortfolio() {
    return this.getPortfolioByName('mechanical');
  }

  getAllPortfolios() {
    return this.db.prepare('SELECT * FROM portfolios ORDER BY id').all();
  }

  getPortfolioByName(name) {
    return this.db.prepare('SELECT * FROM portfolios WHERE name = ?').get(name);
  }

  getPortfolioById(id) {
    return this.db.prepare('SELECT * FROM portfolios WHERE id = ?').get(id);
  }

  // ===== VETO SHADOW TRACKING =====

  saveVetoShadow({ portfolioId, direction, entry, stop, target }) {
    const id = this.db.prepare(`
      INSERT INTO veto_shadows (portfolio_id, timestamp, direction, entry, stop, target)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(portfolioId, new Date().toISOString(), direction, entry, stop, target).lastInsertRowid;
    console.log(`👻 Veto shadow saved (ID: ${id}, portfolio: ${portfolioId})`);
    return id;
  }

  updateVetoShadow(shadowId, wouldBeOutcome, wouldBePnl, metadata = {}) {
    this.db.prepare(`
      UPDATE veto_shadows
      SET would_be_outcome = ?, would_be_pnl = ?, shadow_metadata = ?
      WHERE id = ?
    `).run(wouldBeOutcome, wouldBePnl, JSON.stringify(metadata), shadowId);
    console.log(`👻 Veto shadow ${shadowId} resolved: ${wouldBeOutcome}`);
  }

  // ===== ACCOUNTS SUMMARY =====

  getAccountsSummary() {
    const today = new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT
        p.id,
        p.name,
        p.starting_balance,
        p.current_balance,
        COALESCE(d.realized_pnl, 0)  AS daily_realized_pnl,
        COALESCE(d.open_pnl, 0)      AS daily_open_pnl,
        COALESCE(d.trades_count, 0)  AS daily_trades,
        COALESCE(d.wins, 0)          AS daily_wins,
        COALESCE(d.losses, 0)        AS daily_losses
      FROM portfolios p
      LEFT JOIN account_pnl_daily d
        ON d.portfolio_id = p.id AND d.date = ?
      ORDER BY p.id
    `).all(today);
  }

  updatePortfolioBalance(portfolioId, pnlDelta) {
    this.db.prepare(
      'UPDATE portfolios SET current_balance = current_balance + ? WHERE id = ?'
    ).run(pnlDelta, portfolioId);
  }

  upsertDailyPnl(date, portfolioId, pnlDelta, isWin) {
    this.db.prepare(`
      INSERT INTO account_pnl_daily (date, portfolio_id, realized_pnl, trades_count, wins, losses)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(date, portfolio_id) DO UPDATE SET
        realized_pnl  = realized_pnl + excluded.realized_pnl,
        trades_count  = trades_count + 1,
        wins          = wins + excluded.wins,
        losses        = losses + excluded.losses
    `).run(date, portfolioId, pnlDelta, isWin ? 1 : 0, isWin ? 0 : 1);
  }

  close() {
    this.db.close();
  }
}

export default new DatabaseService();
