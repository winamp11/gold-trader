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
        h4_mfi REAL,
        h1_macd REAL,
        h1_rsi REAL,
        h1_mfi REAL,
        m30_macd REAL,
        m30_rsi REAL,
        m30_mfi REAL,
        m15_macd REAL,
        m15_rsi REAL,
        m15_mfi REAL,
        
        outcome TEXT,
        outcome_timestamp TEXT,
        outcome_price REAL,
        outcome_pnl REAL,
        outcome_metadata TEXT
      )
    `);

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

    // Trades table - stores actual trades taken by user
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER,
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
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      )
    `);

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

    console.log('✅ Database initialized');
  }

  saveSignal(signalData) {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        timestamp, signal, direction, entry_price, stop_loss, target,
        position_size, risk_amount, potential_profit, confidence, reasoning,
        h4_macd, h4_rsi, h1_macd, h1_rsi,
        m30_macd, m30_rsi, m15_macd, m15_rsi
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rec = signalData.recommendation || {};
    const tf = signalData.timeframes || {};

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
      tf.h4?.macd || null,
      tf.h4?.rsi || null,
      tf.h1?.macd || null,
      tf.h1?.rsi || null,
      tf.m30?.macd || null,
      tf.m30?.rsi || null,
      tf.m15?.macd || null,
      tf.m15?.rsi || null
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
        signal_id, timestamp, direction, entry_price, lot_size,
        stop_loss, take_profit, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      tradeData.signal_id || null,
      tradeData.timestamp,
      tradeData.direction,
      tradeData.entry_price,
      tradeData.lot_size,
      tradeData.stop_loss || null,
      tradeData.take_profit || null,
      tradeData.notes || null
    );

    console.log(`💾 Trade saved (ID: ${info.lastInsertRowid})`);
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

  close() {
    this.db.close();
  }
}

export default new DatabaseService();
