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
    // Standard libpq opt-out, honoured so a plain local Postgres (which
    // speaks no SSL at all) is reachable -- otherwise every non-Railway
    // host is forced into SSL and the integration tests cannot connect.
    // Railway's own URLs set neither, so its behaviour is unchanged.
    const sslDisabled =
      process.env.PGSSLMODE === 'disable' ||
      (connectionString || '').includes('sslmode=disable');
    const ssl = (isInternal || sslDisabled) ? false : { rejectUnauthorized: false };

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

    // FTMO-style prop-firm simulation account: reuses the overlay's decisions
    // through a strict risk envelope (see PROP config in server.js).
    await this.pool.query(`
      INSERT INTO portfolios (name, starting_balance, current_balance) VALUES
        ('prop_sim', 100000, 100000)
      ON CONFLICT (name) DO NOTHING
    `);

    // Hybrid bot: overlay's judgment + forward-rulebook evidence, under a
    // live-editable risk envelope (see botConfig.js).
    await this.pool.query(`
      INSERT INTO portfolios (name, starting_balance, current_balance) VALUES
        ('claude_hybrid', 100000, 100000)
      ON CONFLICT (name) DO NOTHING
    `);

    // mechanical_prime / mechanical_session: same Mechanical signal as the
    // unchanged `mechanical` control, filtered to a historically-strong
    // entry window and sized by the deterministic risk engine in
    // mechanicalRiskEngine.js (see server.js). Not a second strategy.
    await this.pool.query(`
      INSERT INTO portfolios (name, starting_balance, current_balance) VALUES
        ('mechanical_prime',   100000, 100000),
        ('mechanical_session', 100000, 100000)
      ON CONFLICT (name) DO NOTHING
    `);

    // Highest balance recorded at any day boundary — anchor for FTMO's
    // trailing Maximum Loss rule (limit = high water − 10% of initial).
    await this.pool.query(`ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS high_water_balance DOUBLE PRECISION`);

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

    // exit_type: 'strategy' (TARGET_HIT/STOP_HIT reached own level) or
    //            'forced'   (WINDOW_CLOSE/CIRCUIT_BREAKER exited by rule)
    // NULL on older rows and veto/observation entries.
    await this.pool.query(`ALTER TABLE journal ADD COLUMN IF NOT EXISTS exit_type TEXT`);

    // Additive range columns: session high/low snapshot and derived position metrics.
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS session_high          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS session_low           DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS range_position_pct    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS range_width_vs_h1_atr DOUBLE PRECISION`);

    // At-signal indicator snapshot: raw bulk-fetch values at cycle time.
    // Existing rows stay NULL (expected). No data is altered.
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h4_rsi_at_signal          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_rsi_at_signal          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_rsi_at_signal         DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h4_macd_hist_at_signal    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_macd_hist_at_signal    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_macd_hist_at_signal   DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h4_macd_signal_at_signal  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_macd_signal_at_signal  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_macd_signal_at_signal DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_atr_at_signal          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_atr_at_signal         DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h4_adx_at_signal          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS h1_adx_at_signal          DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS m30_adx_at_signal         DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS day_high_at_signal        DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS day_low_at_signal         DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS adr_at_signal             DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS adr_consumed_pct          DOUBLE PRECISION`);

    // DXY (US Dollar Index) bias at signal time — passive enrichment for correlation analysis
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS dxy_bias_at_signal        VARCHAR(10)`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS dxy_price_at_signal       DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS dxy_change_pct_at_signal  DOUBLE PRECISION`);

    // Forward-outcome labels: what price actually did AFTER each signal row,
    // filled in later by the forward labeler for EVERY cycle (traded or not).
    // Units are price points (USD). fwd_max_up/down are positive magnitudes of
    // the best/worst excursion within 4h of the signal. eod = 21:00 UAE close.
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS price_at_signal  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_return_1h    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_return_4h    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_return_eod   DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_max_up_4h    DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_max_down_4h  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fwd_labeled_at   TEXT`);

    // MAE/MFE raw material: price extremes observed while the position was held
    // (from entry trigger to close). MAE/MFE derive from these vs entry_price.
    await this.pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS max_price_during DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS min_price_during DOUBLE PRECISION`);

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

    // forced_close_pct: what % of a tag's analyst-visible trades were forced exits.
    // Must stay below the CREATE TABLE above -- it previously sat with the
    // other ALTERs further up the file, which made initialize() throw
    // "relation analyst_rulebook does not exist" on a genuinely empty
    // database. Existing deployments never hit it because the table was
    // already there from an earlier boot.
    await this.pool.query(`ALTER TABLE analyst_rulebook ADD COLUMN IF NOT EXISTS forced_close_pct DOUBLE PRECISION`);

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

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mechanical_rulebook (
        id                      SERIAL PRIMARY KEY,
        direction               TEXT NOT NULL,
        session                 TEXT,
        adx_bucket              TEXT,
        rsi_bucket              TEXT,
        macd_bias               TEXT,
        n_total                 INTEGER NOT NULL,
        n_wins                  INTEGER NOT NULL,
        n_losses                INTEGER NOT NULL,
        win_rate                DOUBLE PRECISION NOT NULL,
        avg_win_pnl             DOUBLE PRECISION,
        avg_loss_pnl            DOUBLE PRECISION,
        expectancy              DOUBLE PRECISION,
        entry_h4_adx_avg        DOUBLE PRECISION,
        entry_h1_adx_avg        DOUBLE PRECISION,
        entry_h4_rsi_avg        DOUBLE PRECISION,
        entry_h1_rsi_avg        DOUBLE PRECISION,
        entry_h4_macd_avg       DOUBLE PRECISION,
        entry_h1_macd_avg       DOUBLE PRECISION,
        entry_h1_atr_avg        DOUBLE PRECISION,
        entry_adr_consumed_avg  DOUBLE PRECISION,
        avg_stop_atr_multiple   DOUBLE PRECISION,
        avg_rr_planned          DOUBLE PRECISION,
        pct_target_hit          DOUBLE PRECISION,
        pct_stop_hit            DOUBLE PRECISION,
        pct_window_close        DOUBLE PRECISION,
        sample_confidence       TEXT,
        last_trade_date         TEXT,
        last_updated            TEXT NOT NULL
      )
    `);

    // Small key-value store for in-memory service state that must survive
    // redeploys (e.g. the session high/low — resetting it mid-day corrupted
    // range_position_pct / adr_consumed_pct / day_high/low on deploy days).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS service_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    // DXY distribution on mechanical_rulebook (additive — table may already exist)
    await this.pool.query(`ALTER TABLE mechanical_rulebook ADD COLUMN IF NOT EXISTS dxy_rising_pct  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE mechanical_rulebook ADD COLUMN IF NOT EXISTS dxy_falling_pct DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE mechanical_rulebook ADD COLUMN IF NOT EXISTS dxy_flat_pct    DOUBLE PRECISION`);

    // Live-editable bot parameters (see botConfig.js for schema + clamps).
    // Stored as JSON so new parameters need no migration; every value is
    // clamped server-side on write AND on read, so a bad row can never
    // produce unsafe trading behavior.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        bot_name   TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Hybrid run log: raw record of each accounting run's peak and how it
    // ended (give-back bank, daily target, or daily max loss). Written live
    // by server.js the moment a run ends. Pure research data — nothing reads
    // this to make a trading decision; it exists so the analyst can later
    // check whether peak timing correlates with session/time-of-day.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hybrid_run_log (
        id                        SERIAL PRIMARY KEY,
        date                      TEXT NOT NULL,
        run_number                INTEGER NOT NULL,
        peak_profit               DOUBLE PRECISION NOT NULL,
        peak_at                   TEXT NOT NULL,
        peak_session              TEXT,
        peak_position_count       INTEGER,
        peak_position_directions  TEXT,
        end_reason                TEXT NOT NULL,
        end_pnl                   DOUBLE PRECISION NOT NULL,
        end_at                    TEXT NOT NULL,
        end_session               TEXT,
        created_at                TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);

    // Hybrid decision journal — every branch evaluation (not just executed
    // trades). Pure observability: nothing here is ever fed back into a
    // future decision (that would recreate the post-hoc-labelling feedback
    // loop this bot was deliberately built without). Counterfactual geometry
    // is frozen at decision time (no look-ahead); outcomes are matured later
    // by hybridMaturation.js from historical candles, never from live info.
    //
    // All columns beyond the identity fields are nullable by design, so a
    // row inserted before some later column existed still reads/aggregates
    // cleanly (see /api/hybrid/branch-analytics's COALESCE-style handling).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hybrid_decisions (
        id                    SERIAL PRIMARY KEY,
        signal_id             INTEGER REFERENCES signals(id),
        cycle_ts              TEXT NOT NULL,
        decision_branch       TEXT NOT NULL,
        final_action          TEXT NOT NULL,   -- LONG | SHORT | NO_TRADE
        final_risk_usd        DOUBLE PRECISION,
        final_risk_pct        DOUBLE PRECISION,
        final_lots            DOUBLE PRECISION,
        trade_id              INTEGER REFERENCES trades(id),
        final_reasoning       TEXT,
        veto_or_reduction_reason TEXT,

        mech_action           TEXT,
        mech_direction        TEXT,
        mech_tag              TEXT,

        overlay_action        TEXT,
        overlay_direction     TEXT,
        overlay_status        TEXT,   -- supportive | silent | weakly_opposed | strongly_opposed
        overlay_opposition_type TEXT, -- execution_risk | directional | null
        overlay_confidence    TEXT,
        overlay_reasoning     TEXT,
        overlay_tag           TEXT,

        rulebook_direction    TEXT,
        rulebook_session      TEXT,
        rulebook_adx_bucket   TEXT,
        rulebook_rsi_bucket   TEXT,
        rulebook_n_total      INTEGER,
        rulebook_avg_1h       DOUBLE PRECISION,
        rulebook_avg_4h       DOUBLE PRECISION,
        rulebook_avg_eod      DOUBLE PRECISION,
        rulebook_pct_up_4h    DOUBLE PRECISION,
        rulebook_avg_max_up_4h   DOUBLE PRECISION,
        rulebook_avg_max_down_4h DOUBLE PRECISION,
        rulebook_confidence   TEXT,
        signals_agreed        BOOLEAN,

        -- Counterfactual geometry, frozen at decision time (no look-ahead).
        -- "rulebook" track = the rulebook's supported direction (used when it
        -- wasn't taken); "overlay" track = overlay's proposed direction (used
        -- when it wasn't taken). Either may be null if that source had nothing
        -- to counterfactual (e.g. agreement branch with a real trade taken).
        cf_rulebook_direction TEXT,
        cf_rulebook_entry     DOUBLE PRECISION,
        cf_rulebook_stop      DOUBLE PRECISION,
        cf_rulebook_target    DOUBLE PRECISION,
        cf_rulebook_risk_usd  DOUBLE PRECISION,
        cf_rulebook_lots      DOUBLE PRECISION,
        cf_rulebook_outcome   TEXT,   -- JSON: {h1:{...},h4:{...},eod:{...},matured_at}

        cf_overlay_direction  TEXT,
        cf_overlay_entry      DOUBLE PRECISION,
        cf_overlay_stop       DOUBLE PRECISION,
        cf_overlay_target     DOUBLE PRECISION,
        cf_overlay_lots       DOUBLE PRECISION,
        cf_overlay_outcome    TEXT,   -- JSON: {h1:{...},h4:{...},eod:{...},matured_at}

        created_at            TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);

    // Regime context recorded on every hybrid decision, including no-trades.
    // Needed to answer the question that decides whether this layer earns its
    // place: how often does the LLM disagree with the regime when one is
    // present? If that number is ~0, the regime is not informing judgement,
    // it is replacing it -- and a lookup table would be cheaper.
    await this.pool.query(`ALTER TABLE hybrid_decisions ADD COLUMN IF NOT EXISTS regime_state         TEXT`);
    await this.pool.query(`ALTER TABLE hybrid_decisions ADD COLUMN IF NOT EXISTS regime_momentum_pct  DOUBLE PRECISION`);
    await this.pool.query(`ALTER TABLE hybrid_decisions ADD COLUMN IF NOT EXISTS regime_days_in_state INTEGER`);
    await this.pool.query(`ALTER TABLE hybrid_decisions ADD COLUMN IF NOT EXISTS regime_suppressed    TEXT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_hybrid_decisions_branch ON hybrid_decisions(decision_branch)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_hybrid_decisions_cycle_ts ON hybrid_decisions(cycle_ts)`);

    // mechanical_variant_decisions — INSERT-ONLY, immutable decision journal
    // for mechanical_prime/mechanical_session. One row per account per
    // Mechanical TRADE signal (RED cycles need no gating, mirroring
    // mechanical's own executor). Rows are never UPDATEd: a trade's real
    // outcome lives in `trades` (linked via trade_id, known synchronously
    // from openPosition() so no later write-back is needed); any later
    // counterfactual result for a rejected signal is Phase 2 work and will
    // live in its own table linked by decision id, never as a column
    // mutated here — this preserves exactly what the bot knew and decided
    // at the moment it decided it.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mechanical_variant_decisions (
        id                     SERIAL PRIMARY KEY,
        account                TEXT NOT NULL,          -- mechanical_prime | mechanical_session
        signal_id              INTEGER REFERENCES signals(id),
        cycle_ts_utc           TEXT NOT NULL,
        cycle_ts_uae           TEXT NOT NULL,
        uae_weekday            SMALLINT NOT NULL,       -- 0=Sun .. 6=Sat
        uae_hour               SMALLINT NOT NULL,

        -- The shared Mechanical signal, unmodified -- identical across
        -- mechanical/mechanical_prime/mechanical_session for the same
        -- signal_id. This is what "signal-for-signal comparable" means.
        direction              TEXT NOT NULL,           -- LONG | SHORT
        signal_entry           DOUBLE PRECISION NOT NULL,
        signal_stop            DOUBLE PRECISION NOT NULL, -- Mechanical's raw proposed stop, pre-ATR-clamp
        signal_target           DOUBLE PRECISION NOT NULL, -- unchanged by this account, ever
        mech_tag                TEXT,
        mech_reasoning           TEXT,

        -- Indicator snapshot at decision time, denormalized (not joined via
        -- signal_id) so this row is a genuinely self-contained, immutable
        -- record of what the bot knew, independent of the signals table.
        h4_rsi                 DOUBLE PRECISION,
        h1_rsi                 DOUBLE PRECISION,
        h4_macd_hist            DOUBLE PRECISION,
        h1_macd_hist            DOUBLE PRECISION,
        h4_adx                 DOUBLE PRECISION,
        h1_adx                  DOUBLE PRECISION,
        h1_atr                  DOUBLE PRECISION,
        h4_atr                  DOUBLE PRECISION,

        -- This account's own risk-engine adjustment to the stop (spec: TP
        -- is never touched; only the stop is clamped to an ATR safety band).
        clamped_stop             DOUBLE PRECISION,
        atr_mult_applied          DOUBLE PRECISION,

        -- Full pipeline state at the moment this decision was evaluated.
        session_permitted         BOOLEAN NOT NULL,
        risk_state_before          TEXT NOT NULL,        -- NORMAL | CAUTION | DEFENSIVE | PAUSED
        risk_state_after           TEXT NOT NULL,        -- reflects an evidence-based PAUSED->DEFENSIVE transition observed THIS cycle, if any
        state_transition_reason     TEXT,                -- non-null iff risk_state_before <> risk_state_after, or a daily guard tripped this cycle
        allowed_risk_pct            DOUBLE PRECISION NOT NULL,
        equity                     DOUBLE PRECISION NOT NULL,
        day_start_equity            DOUBLE PRECISION NOT NULL,
        day_pnl                    DOUBLE PRECISION NOT NULL,
        open_risk_pct_before         DOUBLE PRECISION NOT NULL,
        open_position_count          SMALLINT NOT NULL,
        consecutive_losses           SMALLINT NOT NULL,

        -- Outcome of the pipeline for this signal, this account, this cycle.
        final_action               TEXT NOT NULL,        -- EXECUTE | REDUCE | REJECT
        reason_code                TEXT,                 -- populated for REJECT always, for REDUCE when open-risk headroom clamped size
        lots                       DOUBLE PRECISION,      -- actual size if EXECUTE/REDUCE, else null
        risk_usd                   DOUBLE PRECISION,
        theoretical_1pct_lots        DOUBLE PRECISION NOT NULL, -- same signal, flat 1% risk -- input to Phase 2's POSITION_SIZING_VALUE
        trade_id                   INTEGER REFERENCES trades(id),

        created_at                 TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_mvd_account_ts     ON mechanical_variant_decisions(account, cycle_ts_utc)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_mvd_action         ON mechanical_variant_decisions(account, final_action)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_mvd_weekday_hour   ON mechanical_variant_decisions(account, uae_weekday, uae_hour)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_mvd_signal         ON mechanical_variant_decisions(signal_id)`);

    // config_version / config_snapshot: which configuration produced this
    // decision. Settings are dashboard-editable and read fresh each cycle,
    // so without these a three-month dataset silently mixes treatments --
    // an entry window widened mid-experiment aggregates into one result
    // describing a configuration that was never actually run. The version
    // is a deterministic fingerprint (see configFingerprint); the snapshot
    // is the full config as JSON so a version can always be explained
    // without reconstructing history.
    await this.pool.query(`ALTER TABLE mechanical_variant_decisions ADD COLUMN IF NOT EXISTS config_version  TEXT`);
    await this.pool.query(`ALTER TABLE mechanical_variant_decisions ADD COLUMN IF NOT EXISTS config_snapshot TEXT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_mvd_config_version ON mechanical_variant_decisions(account, config_version)`);

    // mechanical_variant_decision_outcomes — the Phase-2 maturation result for
    // a mechanical_variant_decisions row. Strictly separate from the decision
    // itself (never a column added to that table, never an UPDATE to it) so
    // the immutable "what the bot knew and decided" record and the
    // later-computed "what actually happened" record can never be conflated.
    // Unique on decision_id: one decision produces at most one outcome row,
    // ever -- a decision only becomes eligible for maturation once the EOD
    // horizon is reachable, at which point h1/h4/eod are all resolved
    // together in a single pass and written once. Re-running maturation on
    // an already-matured decision is a no-op (ON CONFLICT DO NOTHING), so a
    // repeated maturation check can never create a second statistical
    // observation for the same decision.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mechanical_variant_decision_outcomes (
        id                  SERIAL PRIMARY KEY,
        decision_id         INTEGER NOT NULL REFERENCES mechanical_variant_decisions(id),

        h1_outcome          TEXT, h1_exit_price DOUBLE PRECISION, h1_pnl DOUBLE PRECISION, h1_r_multiple DOUBLE PRECISION, h1_mfe DOUBLE PRECISION, h1_mae DOUBLE PRECISION,
        h4_outcome          TEXT, h4_exit_price DOUBLE PRECISION, h4_pnl DOUBLE PRECISION, h4_r_multiple DOUBLE PRECISION, h4_mfe DOUBLE PRECISION, h4_mae DOUBLE PRECISION,
        eod_outcome         TEXT, eod_exit_price DOUBLE PRECISION, eod_pnl DOUBLE PRECISION, eod_r_multiple DOUBLE PRECISION, eod_mfe DOUBLE PRECISION, eod_mae DOUBLE PRECISION,

        matured_at          TEXT NOT NULL,
        created_at          TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mvdo_decision_id ON mechanical_variant_decision_outcomes(decision_id)`);

    // daily_close — one XAU/USD close per UAE calendar day, recorded whether
    // or not any account traded that day. The regime indicator must not be a
    // function of the bot's own activity: a quiet day is still a day the
    // market moved, and deriving the series from trades or signals would make
    // the trend read depend on how busy the strategies happened to be.
    // Upserted every cycle, so the last price seen on a given UAE day wins.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS daily_close (
        date         TEXT PRIMARY KEY,   -- UAE calendar date, YYYY-MM-DD
        close        DOUBLE PRECISION NOT NULL,
        source       TEXT NOT NULL,      -- live | backfill_signals
        recorded_at  TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `);

    // market_candles_m1 — shared XAU/USD 1-minute candle cache. The ONE
    // stored copy of historical M1 data, so forwardLabeler/hybridMaturation/
    // mechanicalVariantMaturation stop independently re-fetching the same
    // Twelve Data history (see m1CandleCache.js). Unique on (symbol, ts)
    // makes every insert idempotent -- overlapping fetches can never create
    // duplicate rows, ON CONFLICT DO NOTHING is always correct here.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS market_candles_m1 (
        id         SERIAL PRIMARY KEY,
        symbol     TEXT NOT NULL,
        ts         TEXT NOT NULL, -- canonical UTC minute, YYYY-MM-DDTHH:mm:00.000Z
        open       DOUBLE PRECISION,
        high       DOUBLE PRECISION NOT NULL,
        low        DOUBLE PRECISION NOT NULL,
        close      DOUBLE PRECISION NOT NULL,
        volume     DOUBLE PRECISION, -- no real volume for spot XAU/USD; kept for other symbols/generality
        created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_market_candles_m1_symbol_ts ON market_candles_m1(symbol, ts)`);

    // Forward rulebook: market behavior by condition bucket across ALL cycles
    // (traded or not), aggregated from the forward-outcome labels. This is the
    // selection-bias-free companion to the per-account rulebooks. Rebuilt on
    // every analyst run. Values in price points; pct_up_4h in percent.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS forward_rulebook (
        id               SERIAL PRIMARY KEY,
        session          TEXT,
        adx_bucket       TEXT,
        rsi_bucket       TEXT,
        n_total          INTEGER NOT NULL,
        avg_fwd_1h       DOUBLE PRECISION,
        avg_fwd_4h       DOUBLE PRECISION,
        avg_fwd_eod      DOUBLE PRECISION,
        pct_up_4h        DOUBLE PRECISION,
        avg_max_up_4h    DOUBLE PRECISION,
        avg_max_down_4h  DOUBLE PRECISION,
        dxy_rising_pct   DOUBLE PRECISION,
        dxy_falling_pct  DOUBLE PRECISION,
        dxy_flat_pct     DOUBLE PRECISION,
        sample_confidence TEXT,
        last_updated     TEXT NOT NULL
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
        session_high, session_low, range_position_pct, range_width_vs_h1_atr,
        h4_rsi_at_signal, h1_rsi_at_signal, m30_rsi_at_signal,
        h4_macd_hist_at_signal, h1_macd_hist_at_signal, m30_macd_hist_at_signal,
        h4_macd_signal_at_signal, h1_macd_signal_at_signal, m30_macd_signal_at_signal,
        h1_atr_at_signal, m30_atr_at_signal,
        h4_adx_at_signal, h1_adx_at_signal, m30_adx_at_signal,
        day_high_at_signal, day_low_at_signal, adr_at_signal, adr_consumed_pct,
        dxy_bias_at_signal, dxy_price_at_signal, dxy_change_pct_at_signal,
        price_at_signal
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,
        $31,$32,$33,$34,
        $35,$36,$37,
        $38,$39,$40,
        $41,$42,$43,
        $44,$45,
        $46,$47,$48,
        $49,$50,$51,$52,
        $53,$54,$55,
        $56
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
      signalData.session           ?? null,
      adx.h4                       ?? null,
      adx.h1                       ?? null,
      adx.m30                      ?? null,
      signalData.sessionHigh       ?? null,
      signalData.sessionLow        ?? null,
      signalData.rangePositionPct  ?? null,
      signalData.rangeWidthVsH1Atr ?? null,
      // at-signal indicator snapshot ($35–$52)
      md.h4?.rsi          ?? null,
      md.h1?.rsi          ?? null,
      md.m30?.rsi         ?? null,
      md.h4?.macd_hist    ?? null,
      md.h1?.macd_hist    ?? null,
      md.m30?.macd_hist   ?? null,
      md.h4?.macd_signal  ?? null,
      md.h1?.macd_signal  ?? null,
      md.m30?.macd_signal ?? null,
      md.h1?.atr          ?? null,
      md.m30?.atr         ?? null,
      md.h4?.adx          ?? null,
      md.h1?.adx          ?? null,
      md.m30?.adx         ?? null,
      signalData.dayHighAtSignal      ?? null,
      signalData.dayLowAtSignal       ?? null,
      signalData.adrAtSignal          ?? null,
      signalData.adrConsumedPct       ?? null,
      signalData.dxyBiasAtSignal      ?? null,
      signalData.dxyPriceAtSignal     ?? null,
      signalData.dxyChangePctAtSignal ?? null,
      signalData.currentPrice         ?? null,
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

  async getServiceState(key) {
    const r = await this.pool.query(`SELECT value FROM service_state WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? null;
  }

  async setServiceState(key, value) {
    await this.pool.query(`
      INSERT INTO service_state (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `, [key, value, new Date().toISOString()]);
  }

  async updateTradeExit(tradeId, exitData) {
    await this.pool.query(`
      UPDATE trades
      SET exit_price = $1, exit_timestamp = $2, exit_reason = $3, pnl = $4,
          max_price_during = $5, min_price_during = $6
      WHERE id = $7
    `, [
      exitData.exit_price,
      exitData.exit_timestamp,
      exitData.exit_reason || null,
      exitData.pnl,
      exitData.max_price_during ?? null,
      exitData.min_price_during ?? null,
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

  async setHighWaterBalance(portfolioId, balance) {
    await this.pool.query(
      'UPDATE portfolios SET high_water_balance = $1 WHERE id = $2',
      [balance, portfolioId]
    );
  }

  async saveHybridRunLog({
    date, runNumber, peakProfit, peakAt, peakSession,
    peakPositionCount, peakPositionDirections,
    endReason, endPnl, endAt, endSession,
  }) {
    await this.pool.query(`
      INSERT INTO hybrid_run_log
        (date, run_number, peak_profit, peak_at, peak_session,
         peak_position_count, peak_position_directions,
         end_reason, end_pnl, end_at, end_session)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [date, runNumber, peakProfit, peakAt, peakSession,
        peakPositionCount, peakPositionDirections,
        endReason, endPnl, endAt, endSession]);
  }

  // ── Hybrid decision journal ────────────────────────────────────────────

  async saveHybridDecision(d) {
    const r = await this.pool.query(`
      INSERT INTO hybrid_decisions (
        signal_id, cycle_ts, decision_branch, final_action, final_risk_usd, final_risk_pct,
        final_lots, trade_id, final_reasoning, veto_or_reduction_reason,
        mech_action, mech_direction, mech_tag,
        overlay_action, overlay_direction, overlay_status, overlay_opposition_type,
        overlay_confidence, overlay_reasoning, overlay_tag,
        rulebook_direction, rulebook_session, rulebook_adx_bucket, rulebook_rsi_bucket,
        rulebook_n_total, rulebook_avg_1h, rulebook_avg_4h, rulebook_avg_eod, rulebook_pct_up_4h,
        rulebook_avg_max_up_4h, rulebook_avg_max_down_4h, rulebook_confidence, signals_agreed,
        cf_rulebook_direction, cf_rulebook_entry, cf_rulebook_stop, cf_rulebook_target,
        cf_rulebook_risk_usd, cf_rulebook_lots,
        cf_overlay_direction, cf_overlay_entry, cf_overlay_stop, cf_overlay_target, cf_overlay_lots,
        regime_state, regime_momentum_pct, regime_days_in_state, regime_suppressed
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,
        $34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,
        $45,$46,$47,$48
      ) RETURNING id
    `, [
      d.signalId ?? null, d.cycleTs, d.decisionBranch, d.finalAction, d.finalRiskUsd ?? null, d.finalRiskPct ?? null,
      d.finalLots ?? null, d.tradeId ?? null, d.finalReasoning ?? null, d.vetoOrReductionReason ?? null,
      d.mechAction ?? null, d.mechDirection ?? null, d.mechTag ?? null,
      d.overlayAction ?? null, d.overlayDirection ?? null, d.overlayStatus ?? null, d.overlayOppositionType ?? null,
      d.overlayConfidence ?? null, d.overlayReasoning ?? null, d.overlayTag ?? null,
      d.rulebookDirection ?? null, d.rulebookSession ?? null, d.rulebookAdxBucket ?? null, d.rulebookRsiBucket ?? null,
      d.rulebookNTotal ?? null, d.rulebookAvg1h ?? null, d.rulebookAvg4h ?? null, d.rulebookAvgEod ?? null, d.rulebookPctUp4h ?? null,
      d.rulebookAvgMaxUp4h ?? null, d.rulebookAvgMaxDown4h ?? null, d.rulebookConfidence ?? null, d.signalsAgreed ?? null,
      d.cfRulebookDirection ?? null, d.cfRulebookEntry ?? null, d.cfRulebookStop ?? null, d.cfRulebookTarget ?? null,
      d.cfRulebookRiskUsd ?? null, d.cfRulebookLots ?? null,
      d.cfOverlayDirection ?? null, d.cfOverlayEntry ?? null, d.cfOverlayStop ?? null, d.cfOverlayTarget ?? null, d.cfOverlayLots ?? null,
      d.regimeState ?? null, d.regimeMomentumPct ?? null, d.regimeDaysInState ?? null, d.regimeSuppressed ?? null,
    ]);
    return r.rows[0].id;
  }

  // ── Mechanical-variant decision journal (mechanical_prime/mechanical_session) ──
  // INSERT-ONLY by design -- see the table comment. No update method exists
  // on purpose; a row's trade_id is known synchronously at insert time
  // (openPosition() returns the new trade id), so there is never a reason
  // to write back to a row after it's created.

  async saveMechanicalVariantDecision(d) {
    const r = await this.pool.query(`
      INSERT INTO mechanical_variant_decisions (
        account, signal_id, cycle_ts_utc, cycle_ts_uae, uae_weekday, uae_hour,
        direction, signal_entry, signal_stop, signal_target, mech_tag, mech_reasoning,
        h4_rsi, h1_rsi, h4_macd_hist, h1_macd_hist, h4_adx, h1_adx, h1_atr, h4_atr,
        clamped_stop, atr_mult_applied,
        session_permitted, risk_state_before, risk_state_after, state_transition_reason,
        allowed_risk_pct, equity, day_start_equity, day_pnl,
        open_risk_pct_before, open_position_count, consecutive_losses,
        final_action, reason_code, lots, risk_usd, theoretical_1pct_lots, trade_id,
        config_version, config_snapshot
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
        $40,$41
      ) RETURNING id
    `, [
      d.account, d.signalId ?? null, d.cycleTsUtc, d.cycleTsUae, d.uaeWeekday, d.uaeHour,
      d.direction, d.signalEntry, d.signalStop, d.signalTarget, d.mechTag ?? null, d.mechReasoning ?? null,
      d.h4Rsi ?? null, d.h1Rsi ?? null, d.h4MacdHist ?? null, d.h1MacdHist ?? null,
      d.h4Adx ?? null, d.h1Adx ?? null, d.h1Atr ?? null, d.h4Atr ?? null,
      d.clampedStop ?? null, d.atrMultApplied ?? null,
      d.sessionPermitted, d.riskStateBefore, d.riskStateAfter, d.stateTransitionReason ?? null,
      d.allowedRiskPct, d.equity, d.dayStartEquity, d.dayPnl,
      d.openRiskPctBefore, d.openPositionCount, d.consecutiveLosses,
      d.finalAction, d.reasonCode ?? null, d.lots ?? null, d.riskUsd ?? null, d.theoretical1pctLots, d.tradeId ?? null,
      d.configVersion ?? null, d.configSnapshot ?? null,
    ]);
    return r.rows[0].id;
  }

  // REJECT rows with no linked outcome yet -- EXECUTE/REDUCE rows already
  // have real ground truth via trade_id -> trades, so only pure rejections
  // (no trade ever placed) need a hypothetical resolved from candles.
  // Maturity (EOD horizon reachable) is checked in JS by the maturation
  // job, same division of responsibility as getUnmaturedHybridDecisions.
  async getUnmaturedMechanicalVariantDecisions(limit = 500) {
    const { rows } = await this.pool.query(`
      SELECT d.* FROM mechanical_variant_decisions d
      LEFT JOIN mechanical_variant_decision_outcomes o ON o.decision_id = d.id
      WHERE o.id IS NULL AND d.final_action = 'REJECT'
      ORDER BY d.cycle_ts_utc ASC
      LIMIT $1
    `, [limit]);
    return rows;
  }

  // INSERT-ONLY, idempotent: ON CONFLICT (decision_id) DO NOTHING means a
  // decision that's somehow matured twice (e.g. a race between two
  // maturation ticks) still only ever ends up with one outcome row -- no
  // second statistical observation is ever created for the same decision.
  async saveMechanicalVariantDecisionOutcome(o) {
    await this.pool.query(`
      INSERT INTO mechanical_variant_decision_outcomes (
        decision_id,
        h1_outcome, h1_exit_price, h1_pnl, h1_r_multiple, h1_mfe, h1_mae,
        h4_outcome, h4_exit_price, h4_pnl, h4_r_multiple, h4_mfe, h4_mae,
        eod_outcome, eod_exit_price, eod_pnl, eod_r_multiple, eod_mfe, eod_mae,
        matured_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (decision_id) DO NOTHING
    `, [
      o.decisionId,
      o.h1.outcome, o.h1.exitPrice, o.h1.pnl, o.h1.rMultiple, o.h1.mfe, o.h1.mae,
      o.h4.outcome, o.h4.exitPrice, o.h4.pnl, o.h4.rMultiple, o.h4.mfe, o.h4.mae,
      o.eod.outcome, o.eod.exitPrice, o.eod.pnl, o.eod.rMultiple, o.eod.mfe, o.eod.mae,
      o.maturedAt,
    ]);
  }

  // ── market_candles_m1: shared M1 cache (see m1CandleCache.js) ────────────

  // ── daily_close: the regime indicator's input series ────────────────────

  // Upsert today's close. Called every trading cycle, so the final price seen
  // on a UAE day is what persists. A live reading always beats a backfilled
  // one, never the reverse -- otherwise a backfill pass could overwrite a
  // genuine close with an interpolated one.
  async recordDailyClose(date, close, source = 'live') {
    if (close == null || !isFinite(Number(close))) return false;
    const now = new Date().toISOString();
    const r = await this.pool.query(`
      INSERT INTO daily_close (date, close, source, recorded_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (date) DO UPDATE SET
        close      = EXCLUDED.close,
        source     = EXCLUDED.source,
        updated_at = EXCLUDED.updated_at
      -- Allow the write when the INCOMING row is live (a newer live price
      -- always supersedes), or when the STORED row is not live (a backfill
      -- may fill a gap). The one case that must never happen is a backfill
      -- overwriting a live close, which is what the stored-side check
      -- excludes. Getting this backwards silently replaces real closes with
      -- approximated ones and corrupts the regime series.
      WHERE EXCLUDED.source = 'live' OR daily_close.source <> 'live'
    `, [date, Number(close), source, now]);
    return r.rowCount > 0;
  }

  // Ascending by date -- computeRegime() requires that ordering.
  async getDailyCloses(limit = 120) {
    const { rows } = await this.pool.query(`
      SELECT date, close, source FROM daily_close
      ORDER BY date DESC
      LIMIT $1
    `, [limit]);
    return rows.reverse().map(r => ({ date: r.date, close: Number(r.close), source: r.source }));
  }

  // One-time seed so the indicator is usable immediately rather than in ten
  // days' time. Uses the last recorded price_at_signal of each UAE day from
  // the signals table -- an approximation of the close, marked as such by its
  // source, and never allowed to overwrite a live reading.
  async backfillDailyClosesFromSignals() {
    const { rows } = await this.pool.query(`
      SELECT DISTINCT ON (d) d AS date, price AS close
      FROM (
        SELECT substring(timestamp from 1 for 10) AS d,
               timestamp,
               COALESCE(price_at_signal, entry_price) AS price
        FROM signals
        WHERE COALESCE(price_at_signal, entry_price) IS NOT NULL
      ) x
      ORDER BY d, timestamp DESC
    `);
    let written = 0;
    for (const r of rows) {
      if (await this.recordDailyClose(r.date, r.close, 'backfill_signals')) written++;
    }
    return { candidates: rows.length, written };
  }

  async getM1Candles(symbol, startMs, endMs) {
    const { rows } = await this.pool.query(`
      SELECT ts, open, high, low, close, volume FROM market_candles_m1
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC
    `, [symbol, new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
    return rows.map(r => ({ t: new Date(r.ts).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }

  // Cheap MIN/MAX(ts) probe the cache layer uses to assess coverage without
  // pulling every candle back — checks BOTH ends of the requested range so
  // a gap at the start (not just a missing recent tail) is also caught.
  async getM1CoverageBounds(symbol, startMs, endMs) {
    const { rows } = await this.pool.query(`
      SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM market_candles_m1
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
    `, [symbol, new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
    const r = rows[0];
    return {
      minTs: r?.min_ts ? new Date(r.min_ts).getTime() : null,
      maxTs: r?.max_ts ? new Date(r.max_ts).getTime() : null,
    };
  }

  // Bulk idempotent insert. candles: [{ts (canonical ISO string), open, high, low, close, volume}].
  async upsertM1Candles(symbol, candles) {
    if (!candles || candles.length === 0) return 0;
    const values = [];
    const params = [];
    let i = 1;
    for (const c of candles) {
      values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
      params.push(symbol, c.ts, c.open ?? null, c.high, c.low, c.close);
    }
    const r = await this.pool.query(`
      INSERT INTO market_candles_m1 (symbol, ts, open, high, low, close)
      VALUES ${values.join(',')}
      ON CONFLICT (symbol, ts) DO NOTHING
    `, params);
    return r.rowCount;
  }

  async deleteM1CandlesBefore(symbol, beforeMs) {
    const r = await this.pool.query(
      `DELETE FROM market_candles_m1 WHERE symbol = $1 AND ts < $2`,
      [symbol, new Date(beforeMs).toISOString()]
    );
    return r.rowCount;
  }

  // Oldest timestamp still needed by ANY pending/retryable maturation
  // consumer -- signals not yet forward-labeled, hybrid_decisions with a
  // counterfactual direction but no outcome yet, and mechanical_variant_
  // decisions with no linked outcome row. The M1 cache's retention floor
  // must never fall below this, or a later maturation pass would find its
  // required candles already deleted.
  async getOldestUnmaturedMaturationTimestamp() {
    const { rows } = await this.pool.query(`
      SELECT MIN(ts) AS oldest FROM (
        SELECT timestamp AS ts FROM signals WHERE fwd_labeled_at IS NULL
        UNION ALL
        SELECT cycle_ts AS ts FROM hybrid_decisions
          WHERE (cf_rulebook_direction IS NOT NULL AND cf_rulebook_outcome IS NULL)
             OR (cf_overlay_direction  IS NOT NULL AND cf_overlay_outcome  IS NULL)
        UNION ALL
        SELECT d.cycle_ts_utc AS ts FROM mechanical_variant_decisions d
          LEFT JOIN mechanical_variant_decision_outcomes o ON o.decision_id = d.id
          WHERE o.id IS NULL
      ) pending
    `);
    return rows[0]?.oldest ?? null;
  }

  async getUnmaturedHybridDecisions(limit = 500) {
    const { rows } = await this.pool.query(`
      SELECT * FROM hybrid_decisions
      WHERE (cf_rulebook_direction IS NOT NULL AND cf_rulebook_outcome IS NULL)
         OR (cf_overlay_direction  IS NOT NULL AND cf_overlay_outcome  IS NULL)
      ORDER BY cycle_ts ASC
      LIMIT $1
    `, [limit]);
    return rows;
  }

  async setHybridDecisionCounterfactualOutcome(id, field, outcomeJson) {
    const col = field === 'rulebook' ? 'cf_rulebook_outcome' : 'cf_overlay_outcome';
    await this.pool.query(`UPDATE hybrid_decisions SET ${col} = $1 WHERE id = $2`, [outcomeJson, id]);
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

  async saveJournalEntry({ portfolioId, signalOrTradeId = null, entryType, exitType = null, lessonText, tag = null, session = null }) {
    const r = await this.pool.query(`
      INSERT INTO journal
        (portfolio_id, timestamp, signal_or_trade_id, entry_type, exit_type, lesson_text, tag, session)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [portfolioId, new Date().toISOString(), signalOrTradeId, entryType, exitType, lessonText, tag, session]);
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
        -- pnl IS NOT NULL, not just exit_reason IS NOT NULL. A NO_ENTRY row
        -- has an exit_reason but was never filled, so it has no P&L and is
        -- not a trade that can be won or lost. Counting it inflated the
        -- win-rate denominator while it could never reach the numerator,
        -- making closed_trades > wins + losses. Small today (8 rows across
        -- all accounts, ~0.6pp on mechanical) but wrong in a direction that
        -- silently understates every account's win rate.
        FROM trades WHERE exit_reason IS NOT NULL AND pnl IS NOT NULL
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

  // Realized P&L booked for one portfolio on one date. Defaults to 0 when no
  // trade closed that day (weekends, holidays) -- same source AccountPanel
  // already reads for mechanical/overlay/solo, so "today" naturally reads
  // flat on non-trading days with no day-boundary bookkeeping required.
  async getDailyRealizedPnl(portfolioId, date) {
    const { rows } = await this.pool.query(
      `SELECT realized_pnl FROM account_pnl_daily WHERE portfolio_id = $1 AND date = $2`,
      [portfolioId, date]
    );
    return rows[0] ? Number(rows[0].realized_pnl) : 0;
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
