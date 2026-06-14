import pg from 'pg';

const { Pool } = pg;

class DatabaseService {
  constructor() {
    this.pool = null;
  }

  async init() {
    const connectionString = process.env.DATABASE_URL;
    const pgHost           = process.env.PGHOST || '';

    if (!connectionString && !pgHost) {
      throw new Error(
        'No database config found. Set DATABASE_URL, or reference PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from the Postgres service.'
      );
    }

    // Internal Railway hostnames (*.railway.internal) don't need SSL.
    // External proxy hostnames require SSL with self-signed cert.
    const isInternal = connectionString
      ? connectionString.includes('railway.internal')
      : pgHost.includes('railway.internal');
    const ssl = isInternal ? false : { rejectUnauthorized: false };

    // If DATABASE_URL is set use it; otherwise pg reads PG* env vars natively.
    this.pool = new Pool({
      ...(connectionString ? { connectionString } : {}),
      ssl,
      max: 10,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
    });

    console.log(`🔌 Connecting to PostgreSQL via ${connectionString ? 'DATABASE_URL' : 'PGHOST=' + pgHost} (ssl=${ssl ? 'on' : 'off'})...`);
    await this.pool.query('SELECT 1');
    await this.initialize();
    console.log('✅ Database initialized (PostgreSQL)');
  }

  async initialize() {
    // Row-count audit — logged before and after so any accidental data loss is visible.
    let tradesBefore = 0;
    try {
      const r = await this.pool.query('SELECT COUNT(*) AS n FROM trades');
      tradesBefore = parseInt(r.rows[0].n) || 0;
      console.log(`🔍 trades table: ${tradesBefore} rows before schema sync`);
    } catch { /* table doesn't exist yet on first boot */ }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        timestamp TEXT NOT NULL,
        signal TEXT NOT NULL,
        direction TEXT,
        entry_price DOUBLE PRECISION,
        stop_loss DOUBLE PRECISION,
        target DOUBLE PRECISION,
        position_size DOUBLE PRECISION,
        risk_amount DOUBLE PRECISION,
        potential_profit DOUBLE PRECISION,
        confidence TEXT,
        reasoning TEXT,
        h4_macd DOUBLE PRECISION,
        h4_rsi DOUBLE PRECISION,
        h4_atr DOUBLE PRECISION,
        h1_macd DOUBLE PRECISION,
        h1_rsi DOUBLE PRECISION,
        h1_atr DOUBLE PRECISION,
        m30_macd DOUBLE PRECISION,
        m30_rsi DOUBLE PRECISION,
        m30_atr DOUBLE PRECISION,
        m15_macd DOUBLE PRECISION,
        m15_rsi DOUBLE PRECISION,
        m15_atr DOUBLE PRECISION,
        m5_macd DOUBLE PRECISION,
        m5_rsi DOUBLE PRECISION,
        m5_atr DOUBLE PRECISION,
        outcome TEXT,
        outcome_timestamp TEXT,
        outcome_price DOUBLE PRECISION,
        outcome_pnl DOUBLE PRECISION,
        outcome_metadata TEXT
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS autochartist_patterns (
        id SERIAL PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        time_identified TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        success_probability DOUBLE PRECISION,
        entry_price DOUBLE PRECISION NOT NULL,
        stop_loss DOUBLE PRECISION NOT NULL,
        target DOUBLE PRECISION NOT NULL,
        current_price_at_log DOUBLE PRECISION,
        our_signal_at_time TEXT,
        outcome TEXT,
        outcome_timestamp TEXT,
        outcome_price DOUBLE PRECISION,
        outcome_pnl DOUBLE PRECISION,
        logged_at TEXT NOT NULL
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        starting_balance DOUBLE PRECISION NOT NULL,
        current_balance DOUBLE PRECISION NOT NULL,
        created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);

    await this.pool.query(`
      INSERT INTO portfolios (name, starting_balance, current_balance) VALUES
        ('mechanical',     100000, 100000),
        ('claude_overlay', 100000, 100000),
        ('claude_solo',    100000, 100000)
      ON CONFLICT (name) DO NOTHING
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        signal_id INTEGER,
        portfolio_id INTEGER DEFAULT 1,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        exit_price DOUBLE PRECISION,
        lot_size DOUBLE PRECISION NOT NULL,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        pnl DOUBLE PRECISION,
        exit_timestamp TEXT,
        exit_reason TEXT,
        notes TEXT,
        decider TEXT,
        tag TEXT,
        reasoning TEXT,
        FOREIGN KEY (signal_id) REFERENCES signals(id),
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        balance DOUBLE PRECISION NOT NULL,
        daily_pnl DOUBLE PRECISION,
        trades_count INTEGER,
        win_rate DOUBLE PRECISION
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS veto_shadows (
        id SERIAL PRIMARY KEY,
        portfolio_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry DOUBLE PRECISION NOT NULL,
        stop DOUBLE PRECISION NOT NULL,
        target DOUBLE PRECISION NOT NULL,
        tag TEXT,
        reasoning TEXT,
        would_be_outcome TEXT,
        would_be_pnl DOUBLE PRECISION,
        shadow_metadata TEXT,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS journal (
        id SERIAL PRIMARY KEY,
        portfolio_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        signal_or_trade_id INTEGER,
        entry_type TEXT NOT NULL,
        lesson_text TEXT NOT NULL,
        tag TEXT,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS account_pnl_daily (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        portfolio_id INTEGER NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        open_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        trades_count INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        UNIQUE(date, portfolio_id),
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    // Additive columns: per-signal overlay and solo decision labels.
    // Existing rows remain NULL; new rows populated after each cycle.
    // Values: 'TRADE' | 'VETO' | 'NO_TRADE' | 'PARSE_FAILURE' | 'VALIDATION_ERROR' | 'API_ERROR'
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS overlay_decision TEXT`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS solo_decision TEXT`);

    // Additive columns: session label and ADX readings per timeframe.
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS session TEXT`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h4_adx DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_adx DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_adx DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS session TEXT`);
    await this.pool.query(`ALTER TABLE journal ADD COLUMN IF NOT EXISTS session TEXT`);

    // Additive range columns: session high/low snapshot and derived position metrics.
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS session_high          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS session_low           DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS range_position_pct    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS range_width_vs_h1_atr DOUBLE PRECISION`);

    // Circuit-breaker state: session-start balance + per-day halt flag.
    await this.pool.query(`ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS day_start_balance DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS circuit_breaker_date TEXT`);

    // Pinned lessons — high-recurrence loss tags that persist beyond the 8-entry window.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pinned_lessons (
        id              SERIAL PRIMARY KEY,
        portfolio_id    INTEGER NOT NULL,
        journal_id      INTEGER NOT NULL,
        tag             TEXT NOT NULL,
        tag_total_count INTEGER NOT NULL,
        tag_loss_count  INTEGER NOT NULL,
        pin_reason      TEXT,
        pinned_at       TEXT NOT NULL,
        active          BOOLEAN DEFAULT TRUE,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
        FOREIGN KEY (journal_id)   REFERENCES journal(id)
      )
    `);

    // Analyst tables — populated nightly after WINDOW_CLOSE.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS analyst_rulebook (
        id                      SERIAL PRIMARY KEY,
        portfolio_id            INTEGER NOT NULL,
        account_name            TEXT NOT NULL,
        tag                     TEXT NOT NULL,
        n_total                 INTEGER NOT NULL,
        n_wins                  INTEGER NOT NULL,
        n_losses                INTEGER NOT NULL,
        win_rate                DOUBLE PRECISION NOT NULL,
        avg_win_pnl             DOUBLE PRECISION,
        avg_loss_pnl            DOUBLE PRECISION,
        expectancy              DOUBLE PRECISION,
        long_n                  INTEGER,
        long_win_rate           DOUBLE PRECISION,
        short_n                 INTEGER,
        short_win_rate          DOUBLE PRECISION,
        avg_h4_adx              DOUBLE PRECISION,
        dominant_adx_bucket     TEXT,
        adx_breakdown           TEXT,
        avg_h4_rsi              DOUBLE PRECISION,
        rsi_breakdown           TEXT,
        avg_macd_alignment      DOUBLE PRECISION,
        session_breakdown       TEXT,
        dominant_session        TEXT,
        avg_stop_atr_multiple   DOUBLE PRECISION,
        stop_atr_breakdown      TEXT,
        avg_rr_planned          DOUBLE PRECISION,
        avg_range_position_pct  DOUBLE PRECISION,
        avg_range_width_atr     DOUBLE PRECISION,
        squeeze_trade_pct       DOUBLE PRECISION,
        recency_flag            TEXT,
        last_trade_date         TEXT,
        sample_confidence       TEXT,
        window_close_excluded   INTEGER DEFAULT 0,
        last_updated            TEXT NOT NULL,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS analyst_combinations (
        id                SERIAL PRIMARY KEY,
        portfolio_id      INTEGER NOT NULL,
        account_name      TEXT NOT NULL,
        direction         TEXT NOT NULL,
        adx_bucket        TEXT NOT NULL,
        h4_rsi_bucket     TEXT NOT NULL,
        session           TEXT,
        n_total           INTEGER NOT NULL,
        n_wins            INTEGER NOT NULL,
        win_rate          DOUBLE PRECISION NOT NULL,
        avg_pnl           DOUBLE PRECISION,
        expectancy        DOUBLE PRECISION,
        sample_confidence TEXT,
        last_updated      TEXT NOT NULL,
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
      )
    `);

    // Confirm row count unchanged after all DDL
    try {
      const r = await this.pool.query('SELECT COUNT(*) AS n FROM trades');
      const tradesAfter = parseInt(r.rows[0].n) || 0;
      console.log(`✅ trades table: ${tradesAfter} rows after schema sync${tradesAfter === tradesBefore ? ' (unchanged ✓)' : ' ⚠️ COUNT CHANGED'}`);
    } catch { /* ignore */ }

    console.log('✅ Schema up to date');

    // One-time tag normalization: remap fragmented stop-hunt tags → 'stop_hunt'.
    // These four tags are the same lesson; fragmentation prevented pin firing.
    try {
      const remapResult = await this.pool.query(`
        UPDATE journal
        SET tag = 'stop_hunt'
        WHERE portfolio_id = (SELECT id FROM portfolios WHERE name = 'claude_solo')
          AND tag IN (
            'stop_hunt_tight_stop_loss',
            'stop_hunt_despite_prior_warning_loss',
            'stop_hunt_acknowledged_then_ignored_loss',
            'sell_bounce_stop_hunt_loss'
          )
      `);
      const remapped = remapResult.rowCount ?? 0;
      if (remapped > 0) {
        console.log(`🔧 Tag remap: ${remapped} solo journal rows → 'stop_hunt'`);
      }
    } catch (err) {
      console.error('⚠️  Tag remap error (non-fatal):', err.message);
    }

    // One-time tag normalization: remap fragmented overlay veto tags → outcome-based taxonomy keys.
    try {
      const r1 = await this.pool.query(`
        UPDATE journal
        SET tag = 'veto_missed_winner'
        WHERE portfolio_id = (SELECT id FROM portfolios WHERE name = 'claude_overlay')
          AND tag = 'veto_wrong_target_missed'
      `);
      const r2 = await this.pool.query(`
        UPDATE journal
        SET tag = 'veto_correct_outcome_avoided'
        WHERE portfolio_id = (SELECT id FROM portfolios WHERE name = 'claude_overlay')
          AND tag = 'veto_correct_stop_avoided'
      `);
      const r3 = await this.pool.query(`
        UPDATE journal
        SET tag = 'rsi_exhaustion_fade_loss'
        WHERE portfolio_id = (SELECT id FROM portfolios WHERE name = 'claude_overlay')
          AND tag = 'extreme_oversold_carveout_stop_loss'
      `);
      const remapped = (r1.rowCount ?? 0) + (r2.rowCount ?? 0) + (r3.rowCount ?? 0);
      if (remapped > 0) {
        console.log(`🔧 Tag remap: ${r1.rowCount ?? 0} overlay rows → 'veto_missed_winner', ${r2.rowCount ?? 0} → 'veto_correct_outcome_avoided', ${r3.rowCount ?? 0} → 'rsi_exhaustion_fade_loss'`);
      }
    } catch (err) {
      console.error('⚠️  Overlay tag remap error (non-fatal):', err.message);
    }

    // One-time tag normalization: remap solo orphan tags → controlled taxonomy keys.
    try {
      const soloId = `(SELECT id FROM portfolios WHERE name = 'claude_solo')`;
      const soloRemaps = [
        // Wins
        [`UPDATE journal SET tag = 'sell_bounce_downtrend_win'   WHERE portfolio_id = ${soloId} AND tag IN ('sell_bounce_downtrend_confluence_win', 'sell_bounce_downtrend_confluence_target_hit')`, 'sell_bounce_downtrend_win'],
        [`UPDATE journal SET tag = 'mtf_alignment_win'           WHERE portfolio_id = ${soloId} AND tag = 'multi_tf_momentum_cascade_win'`,                  'mtf_alignment_win'],
        [`UPDATE journal SET tag = 'pyramid_trend_add'           WHERE portfolio_id = ${soloId} AND tag = 'pyramid_short_downtrend_win'`,                    'pyramid_trend_add'],
        // Losses
        [`UPDATE journal SET tag = 'low_adx_trap'               WHERE portfolio_id = ${soloId} AND tag = 'low_adx_momentum_trap_loss'`,                     'low_adx_trap'],
        [`UPDATE journal SET tag = 'stop_hunt'                   WHERE portfolio_id = ${soloId} AND tag = 'late_add_bounce_stop_hunt_loss'`,                 'stop_hunt'],
        [`UPDATE journal SET tag = 'entry_at_exhaustion'         WHERE portfolio_id = ${soloId} AND tag = 'entry_at_exhaustion_stop_hit'`,                  'entry_at_exhaustion'],
        [`UPDATE journal SET tag = 'rsi_exhaustion_fade_loss'    WHERE portfolio_id = ${soloId} AND tag = 'rsi_elevated_bounce_stop_hit'`,                  'rsi_exhaustion_fade_loss'],
        [`UPDATE journal SET tag = 'counter_trend_failed'        WHERE portfolio_id = ${soloId} AND tag = 'counter_trend_h4_structure_stop_hit'`,            'counter_trend_failed'],
        [`UPDATE journal SET tag = 'm5_divergence_ignored'       WHERE portfolio_id = ${soloId} AND tag = 'm5_divergence_ignored_loss'`,                    'm5_divergence_ignored'],
        // Window/expiry artifacts
        [`UPDATE journal SET tag = 'window_close_exit'           WHERE portfolio_id = ${soloId} AND tag IN ('window_close_partial_target_win', 'momentum_continuation_partial_window_close')`, 'window_close_exit'],
        [`UPDATE journal SET tag = 'expired_no_fill'             WHERE portfolio_id = ${soloId} AND tag = 'expired_no_follow_through'`,                     'expired_no_fill'],
      ];
      const counts = [];
      for (const [sql, label] of soloRemaps) {
        const r = await this.pool.query(sql);
        if ((r.rowCount ?? 0) > 0) counts.push(`${r.rowCount} → '${label}'`);
      }
      if (counts.length > 0) {
        console.log(`🔧 Solo orphan remap: ${counts.join(', ')}`);
      }
    } catch (err) {
      console.error('⚠️  Solo orphan remap error (non-fatal):', err.message);
    }

    // One-time tag normalization: remap fragmented overlay win/observation tags → controlled taxonomy keys.
    try {
      const overlayRemaps = [
        // 10 atr_resize_* win variants → single consolidated tag
        [`UPDATE journal SET tag = 'atr_resize_win' WHERE portfolio_id = 2 AND tag IN (
            'atr_resize_bear_continuation_oversold_win',
            'atr_resize_short_bear_structure_win',
            'atr_resize_bear_continuation_target_hit',
            'atr_resize_bear_trend_target_extension_win',
            'atr_resize_short_bearish_alignment_win',
            'atr_resize_bearish_structure_win',
            'atr_resize_multi_tf_short_win',
            'atr_resize_short_window_close_partial_win',
            'atr_resize_correct_win',
            'atr_resize_short_h4h1_bear_aligned_win'
          )`, 'atr_resize_win'],
        // No-entry observations
        [`UPDATE journal SET tag = 'no_entry_observation' WHERE portfolio_id = 2 AND tag IN (
            'no_entry_missed_directional_move',
            'no_entry_execution_ambiguity'
          )`, 'no_entry_observation'],
        // Window-close artifacts
        [`UPDATE journal SET tag = 'window_close_exit' WHERE portfolio_id = 2 AND tag IN (
            'window_close_partial_profit_short',
            'atr_resize_short_window_close_partial_win'
          )`, 'window_close_exit'],
        // Expired artifact
        [`UPDATE journal SET tag = 'expired_no_fill' WHERE portfolio_id = 2 AND tag = 'expired_no_follow_through'`, 'expired_no_fill'],
      ];
      const counts = [];
      for (const [sql, label] of overlayRemaps) {
        const r = await this.pool.query(sql);
        if ((r.rowCount ?? 0) > 0) counts.push(`${r.rowCount} → '${label}'`);
      }
      if (counts.length > 0) {
        console.log(`🔧 Overlay orphan remap: ${counts.join(', ')}`);
      }
    } catch (err) {
      console.error('⚠️  Overlay orphan remap error (non-fatal):', err.message);
    }

    // One-time tag normalization: remap fragmented overlay loss tags → controlled taxonomy keys.
    try {
      const overlayLossRemaps = [
        [`UPDATE journal SET tag = 'stop_hunt'               WHERE portfolio_id = 2 AND tag = 'atr_resize_stop_hunt_loss'`,               'stop_hunt'],
        [`UPDATE journal SET tag = 'm5_divergence_ignored'   WHERE portfolio_id = 2 AND tag = 'atr_resize_stop_hit_counter_momentum_ignored'`, 'm5_divergence_ignored'],
        [`UPDATE journal SET tag = 'entry_premature'         WHERE portfolio_id = 2 AND tag = 'atr_stop_correct_entry_timing_loss'`,        'entry_premature'],
        [`UPDATE journal SET tag = 'rsi_exhaustion_fade_loss' WHERE portfolio_id = 2 AND tag = 'atr_stop_clipped_near_oversold_loss'`,      'rsi_exhaustion_fade_loss'],
      ];
      const counts = [];
      for (const [sql, label] of overlayLossRemaps) {
        const r = await this.pool.query(sql);
        if ((r.rowCount ?? 0) > 0) counts.push(`${r.rowCount} → '${label}'`);
      }
      if (counts.length > 0) {
        console.log(`🔧 Overlay loss remap: ${counts.join(', ')}`);
      }
    } catch (err) {
      console.error('⚠️  Overlay loss remap error (non-fatal):', err.message);
    }

    // Backfill pinned lessons from existing journal data (no-ops if already pinned).
    try {
      const { rows: nonMech } = await this.pool.query(
        `SELECT id FROM portfolios WHERE name != 'mechanical'`
      );
      for (const p of nonMech) await this.updatePinnedLessons(p.id);
      console.log(`📌 Pinned lessons backfilled for ${nonMech.length} account(s)`);
    } catch (err) {
      console.error('⚠️  Pinned lessons backfill error (non-fatal):', err.message);
    }
  }

  async updateSignalDecisions(signalId, overlayDecision, soloDecision) {
    await this.pool.query(
      'UPDATE signals SET overlay_decision = $1, solo_decision = $2 WHERE id = $3',
      [overlayDecision, soloDecision, signalId]
    );
  }

  async saveSignal(signalData) {
    const rec = signalData.recommendation || {};
    const tf  = signalData.timeframes    || {};
    const md  = signalData.marketData    || {};
    const adx = signalData.adx || {};

    const result = await this.pool.query(`
      INSERT INTO signals (
        timestamp, signal, direction, entry_price, stop_loss, target,
        position_size, risk_amount, potential_profit, confidence, reasoning,
        h4_macd, h4_rsi, h4_atr,
        h1_macd, h1_rsi, h1_atr,
        m30_macd, m30_rsi, m30_atr,
        m15_macd, m15_rsi, m15_atr,
        m5_macd, m5_rsi, m5_atr,
        session, h4_adx, h1_adx, m30_adx,
        session_high, session_low, range_position_pct, range_width_vs_h1_atr
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,
        $31,$32,$33,$34
      ) RETURNING id
    `, [
      signalData.timestamp,
      signalData.signal,
      rec.direction         || null,
      rec.entry             || null,
      rec.stop              || null,
      rec.target            || null,
      rec.positionSize      || null,
      rec.riskAmount        || null,
      rec.potentialProfit   || null,
      rec.confidence        || null,
      rec.reasoning || signalData.reason || null,
      tf.h4?.macd   ?? null,
      tf.h4?.rsi    ?? null,
      md.h4?.atr    ?? null,
      tf.h1?.macd   ?? null,
      tf.h1?.rsi    ?? null,
      md.h1?.atr    ?? null,
      tf.m30?.macd  ?? null,
      tf.m30?.rsi   ?? null,
      md.m30?.atr   ?? null,
      tf.m15?.macd  ?? null,
      tf.m15?.rsi   ?? null,
      md.m15?.atr   ?? null,
      md.m5?.macd   ?? null,
      md.m5?.rsi    ?? null,
      md.m5?.atr    ?? null,
      signalData.session          ?? null,
      adx.h4                      ?? null,
      adx.h1                      ?? null,
      adx.m30                     ?? null,
      signalData.sessionHigh      ?? null,
      signalData.sessionLow       ?? null,
      signalData.rangePositionPct ?? null,
      signalData.rangeWidthVsH1Atr ?? null,
    ]);

    const id = result.rows[0].id;
    console.log(`💾 Signal saved (ID: ${id})`);
    return id;
  }

  async getRecentSignals(limit = 10) {
    const r = await this.pool.query(
      'SELECT * FROM signals ORDER BY timestamp DESC LIMIT $1', [limit]
    );
    return r.rows;
  }

  async getAllSignals() {
    const r = await this.pool.query('SELECT * FROM signals ORDER BY timestamp DESC');
    return r.rows;
  }

  async getSignalById(id) {
    const r = await this.pool.query('SELECT * FROM signals WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async updateSignalOutcome(signalId, outcomeData) {
    await this.pool.query(`
      UPDATE signals
      SET outcome = $1, outcome_timestamp = $2, outcome_price = $3,
          outcome_pnl = $4, outcome_metadata = $5
      WHERE id = $6
    `, [
      outcomeData.outcome,
      outcomeData.outcome_timestamp,
      outcomeData.outcome_price  || null,
      outcomeData.outcome_pnl    || null,
      outcomeData.metadata       || null,
      signalId,
    ]);
    console.log(`💾 Signal ${signalId} outcome: ${outcomeData.outcome}`);
  }

  async getSignalPerformance(days = 7) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const r = await this.pool.query(`
      SELECT signal, outcome, COUNT(*) AS count
      FROM signals WHERE timestamp >= $1
      GROUP BY signal, outcome
    `, [cutoff]);

    const stats = {
      green: { total: 0, wins: 0, losses: 0, noEntry: 0, pending: 0 },
      red:   { total: 0, correct: 0, missed: 0, pending: 0 },
    };
    r.rows.forEach(row => {
      const n = parseInt(row.count);
      if (row.signal === 'GREEN') {
        stats.green.total += n;
        if (row.outcome === 'TARGET_HIT')           stats.green.wins    += n;
        else if (row.outcome === 'STOP_HIT')        stats.green.losses  += n;
        else if (row.outcome === 'NO_ENTRY')        stats.green.noEntry += n;
        else                                        stats.green.pending += n;
      } else if (row.signal === 'RED') {
        stats.red.total += n;
        if (row.outcome === 'CORRECT_RED')          stats.red.correct += n;
        else if (row.outcome === 'MISSED_OPPORTUNITY') stats.red.missed += n;
        else                                        stats.red.pending += n;
      }
    });
    if (stats.green.total > 0)
      stats.green.winRate = ((stats.green.wins / stats.green.total) * 100).toFixed(1);
    if (stats.red.total > 0)
      stats.red.missedRate = ((stats.red.missed / stats.red.total) * 100).toFixed(1);
    return stats;
  }

  async saveTrade(tradeData) {
    const r = await this.pool.query(`
      INSERT INTO trades (
        signal_id, portfolio_id, timestamp, direction, entry_price, lot_size,
        stop_loss, take_profit, notes, decider, tag, reasoning, session
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id
    `, [
      tradeData.signal_id    || null,
      tradeData.portfolio_id || 1,
      tradeData.timestamp,
      tradeData.direction,
      tradeData.entry_price,
      tradeData.lot_size,
      tradeData.stop_loss    || null,
      tradeData.take_profit  || null,
      tradeData.notes        || null,
      tradeData.decider      || null,
      tradeData.tag          || null,
      tradeData.reasoning    || null,
      tradeData.session      || null,
    ]);
    const id = r.rows[0].id;
    console.log(`💾 Trade saved (ID: ${id}, portfolio: ${tradeData.portfolio_id || 1})`);
    return id;
  }

  async updateTradeExit(tradeId, exitData) {
    await this.pool.query(`
      UPDATE trades
      SET exit_price = $1, exit_timestamp = $2, exit_reason = $3, pnl = $4
      WHERE id = $5
    `, [
      exitData.exit_price,
      exitData.exit_timestamp,
      exitData.exit_reason || null,
      exitData.pnl,
      tradeId,
    ]);
    console.log(`💾 Trade ${tradeId} updated with exit`);
  }

  async getRecentTrades(limit = 20) {
    const r = await this.pool.query(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT $1', [limit]
    );
    return r.rows;
  }

  async getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    const r = await this.pool.query(
      "SELECT * FROM trades WHERE LEFT(timestamp, 10) = $1", [today]
    );
    const trades = r.rows;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const done  = trades.filter(t => t.exit_price !== null);
    const wins  = done.filter(t => (t.pnl || 0) > 0).length;
    return {
      date: today,
      tradesCount: trades.length,
      completedTrades: done.length,
      pnl: totalPnl,
      winRate: done.length > 0 ? ((wins / done.length) * 100).toFixed(1) : '0.0',
    };
  }

  async updateAccountSnapshot(date, balance, dailyPnl, tradesCount, winRate) {
    await this.pool.query(`
      INSERT INTO account_snapshots (date, balance, daily_pnl, trades_count, win_rate)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(date) DO UPDATE SET
        balance      = EXCLUDED.balance,
        daily_pnl    = EXCLUDED.daily_pnl,
        trades_count = EXCLUDED.trades_count,
        win_rate     = EXCLUDED.win_rate
    `, [date, balance, dailyPnl, tradesCount, winRate]);
  }

  async getAccountHistory(days = 30) {
    const r = await this.pool.query(
      'SELECT * FROM account_snapshots ORDER BY date DESC LIMIT $1', [days]
    );
    return r.rows;
  }

  async saveAutochartistPattern(pattern) {
    const r = await this.pool.query(`
      INSERT INTO autochartist_patterns (
        pattern_type, time_identified, timeframe, success_probability,
        entry_price, stop_loss, target, current_price_at_log,
        our_signal_at_time, logged_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [
      pattern.patternType,
      pattern.timeIdentified,
      pattern.timeframe,
      pattern.successProbability,
      pattern.entryPrice,
      pattern.stopLoss,
      pattern.target,
      pattern.currentPrice  || null,
      pattern.ourSignal     || null,
      new Date().toISOString(),
    ]);
    return r.rows[0].id;
  }

  async getAutochartistPatterns(limit = 100) {
    const r = await this.pool.query(
      'SELECT * FROM autochartist_patterns ORDER BY logged_at DESC LIMIT $1', [limit]
    );
    return r.rows;
  }

  async updateAutochartistPatternOutcome(patternId, outcome, price, pnl) {
    await this.pool.query(`
      UPDATE autochartist_patterns
      SET outcome = $1, outcome_timestamp = $2, outcome_price = $3, outcome_pnl = $4
      WHERE id = $5
    `, [outcome, new Date().toISOString(), price, pnl, patternId]);
  }

  async getAllPortfolios() {
    const r = await this.pool.query('SELECT * FROM portfolios ORDER BY id');
    return r.rows;
  }

  async getPortfolioByName(name) {
    const r = await this.pool.query(
      'SELECT * FROM portfolios WHERE name = $1', [name]
    );
    return r.rows[0] ?? null;
  }

  async getPortfolioById(id) {
    const r = await this.pool.query(
      'SELECT * FROM portfolios WHERE id = $1', [id]
    );
    return r.rows[0] ?? null;
  }

  async setDayStartBalance(portfolioId, balance) {
    await this.pool.query(
      'UPDATE portfolios SET day_start_balance = $1 WHERE id = $2',
      [balance, portfolioId]
    );
  }

  async setCircuitBreakerDate(portfolioId, dateStr) {
    await this.pool.query(
      'UPDATE portfolios SET circuit_breaker_date = $1 WHERE id = $2',
      [dateStr, portfolioId]
    );
  }

  async saveVetoShadow({ portfolioId, direction, entry, stop, target, tag = null, reasoning = null }) {
    const r = await this.pool.query(`
      INSERT INTO veto_shadows
        (portfolio_id, timestamp, direction, entry, stop, target, tag, reasoning)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [portfolioId, new Date().toISOString(), direction, entry, stop, target, tag, reasoning]);
    const id = r.rows[0].id;
    console.log(`👻 Veto shadow saved (ID: ${id}, portfolio: ${portfolioId})`);
    return id;
  }

  async updateVetoShadow(shadowId, wouldBeOutcome, wouldBePnl, metadata = {}) {
    await this.pool.query(`
      UPDATE veto_shadows
      SET would_be_outcome = $1, would_be_pnl = $2, shadow_metadata = $3
      WHERE id = $4
    `, [wouldBeOutcome, wouldBePnl, JSON.stringify(metadata), shadowId]);
    console.log(`👻 Shadow ${shadowId} resolved: ${wouldBeOutcome}`);
  }

  async saveJournalEntry({ portfolioId, signalOrTradeId = null, entryType, lessonText, tag = null, session = null }) {
    const r = await this.pool.query(`
      INSERT INTO journal
        (portfolio_id, timestamp, signal_or_trade_id, entry_type, lesson_text, tag, session)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id
    `, [portfolioId, new Date().toISOString(), signalOrTradeId, entryType, lessonText, tag, session]);
    const id = r.rows[0].id;
    console.log(`📓 Journal entry saved (ID: ${id}, portfolio: ${portfolioId}, type: ${entryType})`);
    return id;
  }

  // Returns full tag×entry_type frequency across all journal entries for a portfolio.
  async getTagFullHistory(portfolioId) {
    const r = await this.pool.query(`
      SELECT tag, entry_type, COUNT(*) AS count
      FROM journal
      WHERE portfolio_id = $1 AND tag IS NOT NULL
      GROUP BY tag, entry_type
      ORDER BY count DESC
    `, [portfolioId]);
    return r.rows;
  }

  // Maintains the pinned_lessons table: finds tags with loss_count >= 2 and ensures
  // the most recent loss entry for each such tag is pinned (max 3 active pins per portfolio).
  async updatePinnedLessons(portfolioId) {
    const history = await this.getTagFullHistory(portfolioId);

    // Aggregate loss count and total count per tag
    const lossCounts  = {};
    const totalCounts = {};
    for (const row of history) {
      const cnt = parseInt(row.count);
      totalCounts[row.tag] = (totalCounts[row.tag] ?? 0) + cnt;
      if (row.entry_type === 'loss') lossCounts[row.tag] = cnt;
    }

    // Tags with >= 2 loss entries, sorted by loss count descending
    const qualifying = Object.entries(lossCounts)
      .filter(([, cnt]) => cnt >= 2)
      .sort((a, b) => b[1] - a[1]);

    for (const [tag, lossCount] of qualifying) {
      const totalCount = totalCounts[tag] ?? lossCount;

      // Most recent loss entry for this tag
      const { rows: recent } = await this.pool.query(`
        SELECT id FROM journal
        WHERE portfolio_id = $1 AND tag = $2 AND entry_type = 'loss'
        ORDER BY timestamp DESC
        LIMIT 1
      `, [portfolioId, tag]);
      if (!recent.length) continue;
      const journalId = recent[0].id;

      // Skip if this exact journal entry is already an active pin
      const { rows: existing } = await this.pool.query(`
        SELECT id FROM pinned_lessons
        WHERE portfolio_id = $1 AND journal_id = $2 AND active = TRUE
      `, [portfolioId, journalId]);
      if (existing.length > 0) continue;

      // Enforce hard cap of 3 active pins — deactivate lowest-priority one first
      const { rows: activeRows } = await this.pool.query(`
        SELECT COUNT(*) AS n FROM pinned_lessons
        WHERE portfolio_id = $1 AND active = TRUE
      `, [portfolioId]);
      if (parseInt(activeRows[0].n) >= 3) {
        await this.pool.query(`
          UPDATE pinned_lessons SET active = FALSE
          WHERE id = (
            SELECT id FROM pinned_lessons
            WHERE portfolio_id = $1 AND active = TRUE
            ORDER BY tag_loss_count ASC, pinned_at ASC
            LIMIT 1
          )
        `, [portfolioId]);
      }

      await this.pool.query(`
        INSERT INTO pinned_lessons
          (portfolio_id, journal_id, tag, tag_total_count, tag_loss_count, pin_reason, pinned_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        portfolioId,
        journalId,
        tag,
        totalCount,
        lossCount,
        `loss_tag_recurring_${lossCount}_times`,
        new Date().toISOString(),
      ]);
      console.log(`📌 [PIN] portfolio=${portfolioId} tag=${tag} loss_count=${lossCount} journal_id=${journalId}`);
    }
  }

  async getRecentLessons(portfolioId, limit = 8) {
    // 1. Active pinned lessons — shown first regardless of age
    const { rows: pinnedRows } = await this.pool.query(`
      SELECT j.id, j.lesson_text, j.tag, j.entry_type, j.timestamp
      FROM pinned_lessons pl
      JOIN journal j ON j.id = pl.journal_id
      WHERE pl.portfolio_id = $1 AND pl.active = TRUE
      ORDER BY pl.tag_loss_count DESC, pl.pinned_at DESC
    `, [portfolioId]);
    const pinnedIds = new Set(pinnedRows.map(r => r.id));

    // 2. Standard recency window — fetch extra to compensate for deduplication
    const { rows: windowRows } = await this.pool.query(`
      SELECT id, lesson_text, tag, entry_type, timestamp
      FROM journal
      WHERE portfolio_id = $1
      ORDER BY
        CASE entry_type WHEN 'loss' THEN 0 WHEN 'veto' THEN 1 ELSE 2 END ASC,
        timestamp DESC
      LIMIT $2
    `, [portfolioId, limit + pinnedRows.length]);

    // 3. Remove any window entries already in the pinned set
    const dedupedWindow = windowRows
      .filter(r => !pinnedIds.has(r.id))
      .slice(0, limit);

    // 4. Combine: pinned first, then window
    const pinned  = pinnedRows.map(r => ({ ...r, pinned: true,  pinned_flag: true }));
    const window_ = dedupedWindow.map(r => ({ ...r, pinned: false }));
    const combined = [...pinned, ...window_];

    // 5. Recurring flag across the full combined set (same-tag count > 1)
    const tagCount = {};
    for (const row of combined) {
      if (row.tag) tagCount[row.tag] = (tagCount[row.tag] ?? 0) + 1;
    }
    return combined.map(row => ({ ...row, recurring: (tagCount[row.tag] ?? 0) > 1 }));
  }

  async getAccountsSummary() {
    const today = new Date().toISOString().split('T')[0];
    const r = await this.pool.query(`
      SELECT
        p.id,
        p.name,
        p.starting_balance,
        p.current_balance,
        COALESCE(d.realized_pnl, 0)   AS daily_realized_pnl,
        COALESCE(d.open_pnl, 0)       AS daily_open_pnl,
        COALESCE(d.trades_count, 0)   AS daily_trades,
        COALESCE(d.wins, 0)           AS daily_wins,
        COALESCE(d.losses, 0)         AS daily_losses,
        COALESCE(wr.closed_trades, 0) AS closed_trades,
        COALESCE(wr.wins, 0)          AS wins,
        COALESCE(wr.losses, 0)        AS losses,
        COALESCE(jc.journal_count, 0) AS journal_count
      FROM portfolios p
      LEFT JOIN account_pnl_daily d
        ON d.portfolio_id = p.id AND d.date = $1
      LEFT JOIN (
        SELECT
          portfolio_id,
          COUNT(*)                                                    AS closed_trades,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                   AS wins,
          SUM(CASE WHEN pnl IS NOT NULL AND pnl <= 0 THEN 1 ELSE 0 END) AS losses
        FROM trades WHERE exit_reason IS NOT NULL
        GROUP BY portfolio_id
      ) wr ON wr.portfolio_id = p.id
      LEFT JOIN (
        SELECT portfolio_id, COUNT(*) AS journal_count
        FROM journal
        GROUP BY portfolio_id
      ) jc ON jc.portfolio_id = p.id
      ORDER BY p.id
    `, [today]);

    return r.rows.map(row => {
      const closed = parseInt(row.closed_trades) || 0;
      const wins   = parseInt(row.wins)          || 0;
      return {
        ...row,
        closed_trades:  closed,
        wins,
        losses:         parseInt(row.losses)       || 0,
        daily_trades:   parseInt(row.daily_trades) || 0,
        daily_wins:     parseInt(row.daily_wins)   || 0,
        daily_losses:   parseInt(row.daily_losses) || 0,
        journal_count:  parseInt(row.journal_count) || 0,
        win_rate: closed > 0 ? Math.round((wins / closed) * 1000) / 10 : null,
      };
    });
  }

  async getVetoStats(portfolioId) {
    const r = await this.pool.query(`
      SELECT
        COUNT(*) AS veto_count,
        SUM(CASE WHEN would_be_outcome = 'STOP_HIT'
                 OR  (would_be_pnl IS NOT NULL AND would_be_pnl < 0)
                 THEN 1 ELSE 0 END) AS correctly_avoided,
        SUM(CASE WHEN would_be_outcome = 'TARGET_HIT'
                 OR  (would_be_pnl IS NOT NULL AND would_be_pnl > 0)
                 THEN 1 ELSE 0 END) AS missed_wins
      FROM veto_shadows WHERE portfolio_id = $1
    `, [portfolioId]);
    const row = r.rows[0];
    return {
      veto_count:        parseInt(row?.veto_count)        || 0,
      correctly_avoided: parseInt(row?.correctly_avoided) || 0,
      missed_wins:       parseInt(row?.missed_wins)       || 0,
    };
  }

  async updatePortfolioBalance(portfolioId, pnlDelta) {
    await this.pool.query(
      'UPDATE portfolios SET current_balance = current_balance + $1 WHERE id = $2',
      [pnlDelta, portfolioId]
    );
  }

  async upsertDailyPnl(date, portfolioId, pnlDelta, isWin) {
    await this.pool.query(`
      INSERT INTO account_pnl_daily
        (date, portfolio_id, realized_pnl, trades_count, wins, losses)
      VALUES ($1, $2, $3, 1, $4, $5)
      ON CONFLICT(date, portfolio_id) DO UPDATE SET
        realized_pnl = account_pnl_daily.realized_pnl + EXCLUDED.realized_pnl,
        trades_count = account_pnl_daily.trades_count + 1,
        wins         = account_pnl_daily.wins + EXCLUDED.wins,
        losses       = account_pnl_daily.losses + EXCLUDED.losses
    `, [date, portfolioId, pnlDelta, isWin ? 1 : 0, isWin ? 0 : 1]);
  }

  // ── Composite queries used by specific endpoints ───────────────────────────

  async getJournalEntries(limit = 20, portfolioId = null, offset = 0) {
    const params = [];
    let sql = `
      SELECT j.id, j.portfolio_id, p.name AS portfolio_name,
             j.timestamp, j.entry_type, j.lesson_text, j.tag
      FROM journal j
      JOIN portfolios p ON p.id = j.portfolio_id
      WHERE 1=1
    `;
    if (portfolioId != null) {
      params.push(portfolioId);
      sql += ` AND j.portfolio_id = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY j.timestamp DESC LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows;
  }

  async getMissedOpportunitiesToday() {
    const today = new Date().toISOString().split('T')[0];
    const r = await this.pool.query(
      "SELECT COUNT(*) AS n FROM signals WHERE LEFT(timestamp,10) = $1 AND outcome = 'MISSED_OPPORTUNITY'",
      [today]
    );
    return parseInt(r.rows[0]?.n) || 0;
  }

  async getDailyEquity(portfolioId) {
    const portfolio = await this.getPortfolioById(portfolioId);
    const r = await this.pool.query(`
      SELECT date, realized_pnl FROM account_pnl_daily
      WHERE portfolio_id = $1 ORDER BY date ASC
    `, [portfolioId]);

    const today = new Date().toISOString().split('T')[0];
    const points = [];
    let balance = parseFloat(portfolio.starting_balance);
    for (const row of r.rows) {
      balance = Math.round((balance + parseFloat(row.realized_pnl)) * 100) / 100;
      if (row.date !== today) points.push({ t: row.date, b: balance });
    }
    points.push({ t: today, b: parseFloat(portfolio.current_balance) });
    return points;
  }

  async getOpenTrades() {
    const r = await this.pool.query(`
      SELECT t.id, t.signal_id, t.portfolio_id, t.timestamp,
             t.direction, t.entry_price, t.lot_size,
             t.stop_loss, t.take_profit, t.tag, t.reasoning, t.session,
             p.name AS portfolio_name
      FROM trades t
      JOIN portfolios p ON p.id = t.portfolio_id
      WHERE t.exit_reason IS NULL
      ORDER BY t.id ASC
    `);
    return r.rows;
  }

  async getRecentClosedTrades(limit, portfolioId = null, offset = 0) {
    const params = [];
    let sql = `
      SELECT t.id, t.timestamp, t.direction, t.entry_price, t.exit_price,
             t.lot_size, t.stop_loss, t.take_profit, t.pnl,
             t.exit_timestamp, t.exit_reason, t.tag,
             p.name AS portfolio_name
      FROM trades t
      JOIN portfolios p ON p.id = t.portfolio_id
      WHERE t.exit_reason IS NOT NULL
    `;
    if (portfolioId != null) {
      params.push(portfolioId);
      sql += ` AND t.portfolio_id = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY t.exit_timestamp DESC LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows;
  }

  async getReconciliationData() {
    const r = await this.pool.query(`
      SELECT
        p.id,
        p.name,
        p.starting_balance,
        p.current_balance,
        COUNT(t.id)                                        AS total_trades,
        COUNT(t.id) FILTER (WHERE t.exit_reason IS NOT NULL) AS closed_trades,
        COUNT(t.id) FILTER (WHERE t.exit_reason IS NULL)     AS orphan_trades,
        COALESCE(SUM(t.pnl) FILTER (WHERE t.exit_reason IS NOT NULL), 0) AS sum_closed_pnl
      FROM portfolios p
      LEFT JOIN trades t ON t.portfolio_id = p.id
      GROUP BY p.id
      ORDER BY p.id
    `);
    return r.rows;
  }

  async getMissedOpportunitiesRecent(limit) {
    const r = await this.pool.query(`
      SELECT id, timestamp, outcome_timestamp, outcome_price, outcome_metadata
      FROM signals
      WHERE outcome = 'MISSED_OPPORTUNITY'
      ORDER BY outcome_timestamp DESC
      LIMIT $1
    `, [limit]);
    return r.rows;
  }

  close() {
    if (this.pool) this.pool.end();
  }
}

export default new DatabaseService();
