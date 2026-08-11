// gold-trader backend
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import twelveData from './twelveData.js';
import database from './database.js';
import outcomeTracker from './outcomeTracker.js';
import { isTradingHours, getNextTradingTime, getSession, uaeTime } from './tradingHours.js';

import { decide as mechanicalDecide }    from './deciders/mechanicalDecider.js';
import { decide as claudeOverlayDecide } from './deciders/claudeOverlayDecider.js';
import { decide as claudeSoloDecide }    from './deciders/claudeSoloDecider.js';
import { decide as claudeHybridDecide }  from './deciders/claudeHybridDecider.js';
import { reflectDaily } from './deciders/reflector.js';
import { callDecider, todayCallCount, getLastCallUsage, PROVIDER, MODEL as LLM_MODEL } from './deciders/claudeClient.js';
import { VALUE_PER_LOT } from './contractSpec.js';
import { TAG_TAXONOMY } from './tagTaxonomy.js';
import { runAnalysis, formatRulebookPrompt, adxBucket, rsiBucket } from './analyst.js';
import { runForwardLabeling } from './forwardLabeler.js';
import { runHybridMaturation } from './hybridMaturation.js';
import { computeBranchAnalytics } from './hybridAnalytics.js';
import { runMechanicalVariantMaturation } from './mechanicalVariantMaturation.js';
import { computeComparisonMetrics, computeTimeBuckets, computeAttributionMetrics } from './mechanicalVariantAnalytics.js';
import { getM1CacheMetrics, cleanupOldM1Candles } from './m1CandleCache.js';
import {
  CONFIG_SCHEMA, getBotConfig, saveBotConfig, HYBRID_BOT,
  MECHANICAL_PRIME_BOT, MECHANICAL_SESSION_BOT, MECHANICAL_PRIME_SCHEMA, MECHANICAL_SESSION_SCHEMA,
} from './botConfig.js';
import {
  RISK_STATE_PCT,
  isWithinEntryWindow, isMaxPositionsReached, calculateLotsForRisk, clampToOpenRiskHeadroom, clampStopToAtrBand,
  evaluateDailyGuards, checkRecoveryEvidence, applyEvidenceBasedRecovery,
} from './mechanicalRiskEngine.js';
import {
  MECH_VARIANT_ACCOUNTS, mechVariantState, ensureMechVariantDay, persistMechVariantState,
} from './mechanicalVariantState.js';
import { classifyRulebookQualification, classifyOverlayStatus, classifyBranch, clampRiskUsd } from './hybridBranchClassifier.js';

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

// ── FTMO prop-firm simulation (portfolio 'prop_sim') ───────────────────────
// Reuses the overlay's decision each cycle (no extra Claude calls) through a
// strict risk envelope modeled on FTMO 1-Step rules. Halt thresholds sit at
// 80% of FTMO's limits as a slippage/spread buffer.
// FTMO's day boundary is 00:00 CE(S)T; all positions are flat by 21:00 UAE
// (19:00 CEST), so the day-start balance equals the midnight balance and the
// session day maps 1:1 onto the FTMO day.
const PROP = {
  name:                'prop_sim',
  initialCapital:      100000,
  riskPerTrade:        500,     // 0.5% of INITIAL capital (FTMO limits are % of initial)
  maxOpenPositions:    3,
  dailyLossHalt:       2400,    // halt day at −$2,400 (FTMO Max Daily Loss: 3% = $3,000)
  totalDrawdownHalt:   8000,    // permanent halt at high-water −$8,000 (FTMO Max Loss: 10% = $10,000)
  dailyProfitGovernor: 2000,    // no new entries after +$2,000 closed on the day (Best Day rule ≤50%)

  // Rulebook-executor gates: prop trades ONLY forward_rulebook buckets that
  // earned it. Trades the exact thing the label measured: market entry,
  // 4h hold, disaster stop far enough that realized ≈ measured.
  rule: {
    minSamples:      100,      // bucket n_total floor
    minPctUp:        58,       // LONG when pct_up_4h ≥ 58; SHORT when ≤ 42
    minAvgMove:      5,        // |avg_fwd_4h| floor in points (spread is 0.30)
    holdHours:       4,        // exit horizon = the label's horizon
    stopExcursionX:  2.5,      // disaster stop = 2.5× the bucket's avg adverse excursion
    minStopPoints:   15,
    // Entries allowed for the full trading window; late positions simply get
    // WINDOW_CLOSE'd at 21:00 UAE before completing the 4h hold.
  },
};
let propHardHalted = null;      // ISO date string when the trailing Max Loss guard fired, else null

// ── Hybrid bot day state ──────────────────────────────────────────────────
// peakProfit drives the give-back rule; stoppedReason latches the day off
// once the target, give-back or loss limit fires. Reset each session day.
// Give-back operates PER SERIES (one contiguous stretch of open positions,
// from flat to flat), not per day. A series that already closed at a loss
// must not drag down the give-back baseline for an unrelated series that
// opens later — they can even be opposite directions (a losing LONG stack
// followed by a fresh SHORT stack), so netting them into one day-level
// number was hiding real, currently-open profit from ever being protected.
// mechanical_prime/mechanical_session risk-engine state lives in
// mechanicalVariantState.js (not here) so outcomeTracker.js can also update
// it on trade close without a circular import between it and server.js.

// Last N Mechanical evaluation cycles, newest first, for the PAUSED ->
// DEFENSIVE recovery-evidence check. Account-agnostic (it's a property of
// the shared signal history, not either account's own trade sequence), so
// this is queried fresh rather than buffered per account.
async function fetchRecentSignalsForRecovery(limit = 12) {
  const { rows } = await database.pool.query(`
    SELECT signal, direction, h1_rsi_at_signal, h1_macd_hist_at_signal, h1_adx_at_signal, h1_atr_at_signal
    FROM signals ORDER BY id DESC LIMIT $1
  `, [limit]);
  return rows.map(r => ({
    isGreen:    r.signal === 'GREEN',
    direction:  r.direction,
    h1Rsi:      r.h1_rsi_at_signal,
    h1MacdHist: r.h1_macd_hist_at_signal,
    h1Adx:      r.h1_adx_at_signal,
    h1Atr:      r.h1_atr_at_signal,
  }));
}

// Sum of |entry-stop| × lots × VALUE_PER_LOT across one portfolio's own
// open GREEN positions — same math computeUnrealizedPnl uses, but for
// initial risk rather than live P&L.
function computeOpenRiskUsd(portfolioId) {
  let total = 0;
  for (const t of outcomeTracker.activeTracking.values()) {
    if (t.portfolioId !== portfolioId || t.type !== 'GREEN') continue;
    total += Math.abs(t.entryPrice - t.stopLoss) * (t.lots || 0.01) * VALUE_PER_LOT;
  }
  return total;
}

const hybridDay = {
  date: null, stoppedReason: null, runsBanked: 0, runNumber: 0,
  // Balance snapshot at the moment the current series began (first entry
  // after being flat). Null when no series is active (account is flat).
  seriesStartBalance: null,
  // Peak of THIS series' P&L (realized-within-series + unrealized), and the
  // context captured at that peak — written to hybrid_run_log when the
  // series ends. Pure logging, read by nothing else.
  seriesPeak: 0, seriesPeakAt: null, seriesPeakSession: null,
  seriesPeakPositionCount: null, seriesPeakPositionDirections: null,
};

// Restart-safe: a redeploy mid-day must not wipe the run peak or a latched
// stand-down, or the give-back rule and daily limits silently start over.
async function restoreOrResetHybridDay(today) {
  try {
    const raw = await database.getServiceState('hybrid_day');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && saved.date === today) {
      Object.assign(hybridDay, saved);
      console.log(`🔄 [HYBRID] day state restored: series peak +$${(saved.seriesPeak ?? 0).toFixed(0)}, runs banked ${saved.runsBanked ?? 0}${saved.stoppedReason ? `, stood down (${saved.stoppedReason})` : ''}`);
      return;
    }
  } catch { /* fall through to reset */ }
  resetHybridDay(today);
  await persistHybridDay();
}

async function persistHybridDay() {
  try { await database.setServiceState('hybrid_day', JSON.stringify(hybridDay)); }
  catch { /* non-fatal */ }
}

function resetHybridDay(today) {
  hybridDay.date = today;
  hybridDay.stoppedReason = null;
  hybridDay.runsBanked = 0;
  hybridDay.runNumber = 0;
  resetHybridSeries();
}

// Ends the current series' tracking (called when it banks, gets swept up in
// a daily halt, or simply closes out via normal stop/target hits).
function resetHybridSeries() {
  hybridDay.seriesStartBalance = null;
  hybridDay.seriesPeak = 0;
  hybridDay.seriesPeakAt = null;
  hybridDay.seriesPeakSession = null;
  hybridDay.seriesPeakPositionCount = null;
  hybridDay.seriesPeakPositionDirections = null;
}

// Hybrid day guards: update the profit peak and flatten if the daily target,
// max loss, or give-back rule fires. Called from the 5-minute cycle AND from
// every 1-minute price tick, so the peak is sampled at price resolution
// rather than cycle resolution.
async function checkHybridDayGuards(currentPrice) {
  try {
    if (currentPrice == null || !isTradingHours()) return;
    const p = await database.getPortfolioByName(HYBRID_BOT);
    if (!p) return;
    if (hybridDay.date !== uaeDate()) await restoreOrResetHybridDay(uaeDate());

    const cfg        = await getBotConfig(database.pool);
    const dayStart   = circuitBreakerState[p.id]?.dayStartBalance ?? p.current_balance;
    const unrealized = computeUnrealizedPnl(p.id, currentPrice);
    const dayPnl     = (p.current_balance - dayStart) + unrealized;
    const bal        = p.starting_balance || 100000;
    const nowIso     = new Date().toISOString();
    const session    = getSession(new Date());
    const openNow    = outcomeTracker.getOpenPositionsForPortfolio(p.id);
    const hasOpen    = openNow.length > 0;

    // Log a completed series' peak/end context. Pure research data — nothing
    // downstream reads this table to make a decision.
    const logSeries = async (endReason, endPnl) => {
      if (hybridDay.seriesStartBalance == null) return;   // nothing to log
      try {
        hybridDay.runNumber = (hybridDay.runNumber || 0) + 1;
        await database.saveHybridRunLog({
          date: uaeDate(), runNumber: hybridDay.runNumber,
          peakProfit: hybridDay.seriesPeak, peakAt: hybridDay.seriesPeakAt, peakSession: hybridDay.seriesPeakSession,
          peakPositionCount: hybridDay.seriesPeakPositionCount, peakPositionDirections: hybridDay.seriesPeakPositionDirections,
          endReason, endPnl, endAt: nowIso, endSession: session ?? null,
        });
      } catch (err) {
        console.error(`⚠️  [HYBRID] run-log write failed (non-fatal): ${err.message}`);
      }
    };

    if (!hasOpen) {
      // Went flat: if a series was active, it just ended on its own (normal
      // stop/target hits), not via give-back or a daily halt below. Log it
      // and clear series state so the next entry starts a fresh baseline.
      if (hybridDay.seriesStartBalance != null) {
        const endedSeriesPnl = (p.current_balance - hybridDay.seriesStartBalance);
        await logSeries('positions_closed', endedSeriesPnl);
        resetHybridSeries();
        await persistHybridDay();
      }
    } else {
      // Defensive fallback: a series is open but has no baseline (should only
      // happen if the entry-side hook was somehow bypassed). Start it now.
      if (hybridDay.seriesStartBalance == null) {
        hybridDay.seriesStartBalance = p.current_balance;
        await persistHybridDay();
      }

      const seriesPnl = (p.current_balance - hybridDay.seriesStartBalance) + unrealized;
      if (seriesPnl > hybridDay.seriesPeak) {
        hybridDay.seriesPeak            = seriesPnl;
        hybridDay.seriesPeakAt          = nowIso;
        hybridDay.seriesPeakSession     = session ?? null;
        hybridDay.seriesPeakPositionCount      = openNow.length;
        hybridDay.seriesPeakPositionDirections = openNow.map(t => t.direction).join(',') || null;
        await persistHybridDay();
      }

      if (!hybridDay.stoppedReason) {
        const armUsd   = bal * (cfg.giveBackArmPct / 100);
        const floorUsd = hybridDay.seriesPeak * (1 - cfg.giveBackPct / 100);

        // Give-back applies PER SERIES, not per day: it banks the profit of
        // THIS series (independent of what any earlier, already-closed
        // series did — including an opposite-direction one), then clears
        // series state so the bot starts a fresh baseline on its next entry.
        // Only the daily target and the daily max loss end the day.
        if (hybridDay.seriesPeak >= armUsd && seriesPnl < floorUsd) {
          console.log(`🎯 [HYBRID] give-back: series peak +$${hybridDay.seriesPeak.toFixed(0)} → now +$${seriesPnl.toFixed(0)} (floor $${floorUsd.toFixed(0)}) — banking series, continuing to trade`);
          await logSeries('give_back', seriesPnl);
          await outcomeTracker.forceClosePortfolio(p.id, currentPrice);
          resetHybridSeries();
          hybridDay.runsBanked = (hybridDay.runsBanked || 0) + 1;
          await persistHybridDay();
          return;
        }
      }
    }

    if (hybridDay.stoppedReason) return;

    const targetUsd  = bal * (cfg.dailyProfitTargetPct / 100);
    const maxLossUsd = bal * (cfg.dailyMaxLossPct / 100);

    let flatten = null, flattenReason = null;
    if (dayPnl >= targetUsd) {
      flatten = `daily target hit (+$${dayPnl.toFixed(0)} ≥ $${targetUsd.toFixed(0)})`;
      flattenReason = 'daily_target';
    } else if (dayPnl <= -maxLossUsd) {
      flatten = `daily max loss hit ($${dayPnl.toFixed(0)} ≤ -$${maxLossUsd.toFixed(0)})`;
      flattenReason = 'daily_max_loss';
    }

    if (flatten) {
      hybridDay.stoppedReason = flatten;
      await persistHybridDay();
      if (hasOpen) {
        const seriesPnlNow = (p.current_balance - hybridDay.seriesStartBalance) + unrealized;
        await logSeries(flattenReason, seriesPnlNow);
        resetHybridSeries();
        await persistHybridDay();
      }
      console.log(`🛑 [HYBRID] ${flatten} — flattening and standing down for the day`);
      if (hasOpen) await outcomeTracker.forceClosePortfolio(p.id, currentPrice);
    }
  } catch (err) {
    console.error(`❌ [HYBRID] day-guard check failed: ${err.message}`);
  }
}

// Risk currently deployed = sum of (stop distance x lots x value per lot)
function openRiskFor(portfolioId) {
  let total = 0;
  for (const t of outcomeTracker.getOpenPositionsForPortfolio(portfolioId)) {
    total += Math.abs(t.entryPrice - t.stopLoss) * (t.lots || 0) * VALUE_PER_LOT;
  }
  return total;
}

// Default hypothetical geometry for a "rulebook acting alone" counterfactual
// — used only when no real trade was placed in that direction, so there is
// no model-chosen sizing to draw from. Fixed at decision time (current price
// and ATR only, no future information), and identical across every
// rulebook-only counterfactual so branch comparisons stay apples-to-apples:
// 1.5x H1 ATR stop, 1.5R target, 0.30% of balance risked (the midpoint of
// this bot's own 0.25-0.40% rulebook-only-silent risk tier).
const CF_DEFAULT_ATR_MULT  = 1.5;
const CF_DEFAULT_TARGET_R  = 1.5;
const CF_DEFAULT_RISK_PCT  = 0.30;

function computeDefaultCounterfactualGeometry(direction, currentPrice, h1Atr, balance) {
  if (!h1Atr || !currentPrice || !direction) return null;
  const stopDist = h1Atr * CF_DEFAULT_ATR_MULT;
  const riskUsd  = balance * (CF_DEFAULT_RISK_PCT / 100);
  const lots     = Math.max(0.01, Math.min(Math.floor((riskUsd / (stopDist * VALUE_PER_LOT)) * 100) / 100, 1.0));
  const isLong   = direction === 'LONG';
  return {
    direction, entry: currentPrice,
    stop:   isLong ? currentPrice - stopDist : currentPrice + stopDist,
    target: isLong ? currentPrice + stopDist * CF_DEFAULT_TARGET_R : currentPrice - stopDist * CF_DEFAULT_TARGET_R,
    riskUsd, lots,
  };
}

// ── Session range (tracked from 06:00 UAE open, reset daily) ──────────────
let sessionHigh      = null;
let sessionLow       = null;
let sessionRangeDate = null;  // UAE date of last range reset

// ── ADR cache: average daily range over 14 days, recomputed once per day ──
let adrCache = { date: null, value: null };

// ── Previous-day high/low cache: recomputed once per day ──────────────────
let prevDayCache = { date: null, high: null, low: null };

// ── Solo decider throttle ─────────────────────────────────────────────────
// Solo re-evaluates from scratch every cycle, which made it ~70% of LLM spend.
// Its trades hold for hours, so a 15-minute cadence loses nothing but cost.
// Overlay is deliberately NOT throttled: it must see every mechanical proposal.
// Time-based rather than a cycle counter so restarts don't reset the cadence.
const SOLO_INTERVAL_MS = (parseInt(process.env.SOLO_INTERVAL_MIN) || 15) * 60 * 1000;
let lastSoloCallMs = 0;

// Disabled 2026-08-09: two months live (61 trades) showed a flat 0.80
// profit factor in both the first and second half, no improvement trend,
// and no signal distinct from mechanical/overlay's shared RSI/MACD family
// -- not worth the token spend right now. Decider file, portfolio balance,
// and trade history are untouched. Flip back to true to resume.
const SOLO_ENABLED = false;

function updateSessionRange(price) {
  const today = uaeDate();
  let changed = false;
  if (sessionRangeDate !== today) {
    sessionHigh      = price;
    sessionLow       = price;
    sessionRangeDate = today;
    changed = true;
    console.log(`📏 [SESSION RANGE] Reset for ${today} @ $${price.toFixed(2)}`);
  } else {
    if (price > sessionHigh) { sessionHigh = price; changed = true; }
    if (price < sessionLow)  { sessionLow  = price; changed = true; }
  }
  // Write-through so the range survives redeploys (fire-and-forget)
  if (changed) {
    database.setServiceState('session_range', JSON.stringify({
      date: sessionRangeDate, high: sessionHigh, low: sessionLow,
    })).catch(err => console.warn(`⚠️  session_range persist failed: ${err.message}`));
  }
}

// Restore the day's high/low after a restart so range-derived signal
// features (range_position_pct, adr_consumed_pct, day_high/low) aren't
// silently rebuilt from the restart price.
async function restoreSessionRange() {
  try {
    const raw = await database.getServiceState('session_range');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.date === uaeDate() && saved.high != null && saved.low != null) {
      sessionHigh      = saved.high;
      sessionLow       = saved.low;
      sessionRangeDate = saved.date;
      console.log(`📏 [SESSION RANGE] Restored for ${saved.date}: ${saved.low.toFixed(2)}–${saved.high.toFixed(2)}`);
    }
  } catch (err) {
    console.warn(`⚠️  session_range restore failed: ${err.message}`);
  }
}

function getSessionRangeStr(currentPrice) {
  if (sessionHigh == null || sessionLow == null) return null;
  const spread = sessionHigh - sessionLow;
  if (spread < 0.01) return `Session range: establishing (< $0.01 spread so far)`;
  const pct = ((currentPrice - sessionLow) / spread * 100).toFixed(1);
  return `Session range: ${sessionLow.toFixed(2)}–${sessionHigh.toFixed(2)} | current ${currentPrice.toFixed(2)} (${pct}%)`;
}

async function getOrFetchAdr() {
  const today = uaeDate();
  if (adrCache.date === today && adrCache.value != null) return adrCache.value;
  try {
    const res = await twelveData.fetchTimeSeries('XAU/USD', '1day', 14);
    const candles = res?.values;
    if (!candles || candles.length === 0) return null;
    // Filter out weekends/holidays (range < 1 pt) before averaging
    const ranges = candles
      .map(c => parseFloat(c.high) - parseFloat(c.low))
      .filter(r => r > 1.0);
    if (ranges.length === 0) return null;
    const adr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    adrCache = { date: today, value: adr };
    console.log(`📏 [ADR] ${adr.toFixed(2)} from ${ranges.length} trading days`);
    return adr;
  } catch (e) {
    console.error('[ADR] fetch failed:', e.message);
    return null;
  }
}

// Previous (fully-closed) day's high/low. index[0] of a 1day series is
// today's still-forming candle; index[1] is the last completed day.
async function getOrFetchPrevDayHighLow() {
  const today = uaeDate();
  if (prevDayCache.date === today && prevDayCache.high != null) {
    return { high: prevDayCache.high, low: prevDayCache.low };
  }
  try {
    const res = await twelveData.fetchTimeSeries('XAU/USD', '1day', 2);
    const candles = res?.values;
    if (!candles || candles.length < 2) return null;
    const high = parseFloat(candles[1].high);
    const low  = parseFloat(candles[1].low);
    if (!isFinite(high) || !isFinite(low)) return null;
    prevDayCache = { date: today, high, low };
    console.log(`📐 [PREV DAY] ${candles[1].datetime}: H=${high.toFixed(2)} L=${low.toFixed(2)}`);
    return { high, low };
  } catch (e) {
    console.error('[PREV DAY] fetch failed:', e.message);
    return null;
  }
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
    minPrice:       currentPrice,
    timeExitHours:  decision.timeExitHours ?? null
  });
  console.log(`🟢 [OPEN] ${portfolio.name} | ${decision.direction} entry=${decision.entry?.toFixed(2)} stop=${decision.stop?.toFixed(2)} target=${decision.target?.toFixed(2)} lots=${decision.lots}${decision.timeExitHours ? ` timeExit=${decision.timeExitHours}h` : ''}`);
  return tradeId;
}

// ── Helper: evaluate one mechanical_prime/mechanical_session cycle ────────
// Consumes the SAME mechDecision object mechanical itself already got this
// cycle -- never a second mechanicalDecide() call, never a second copy of
// the RSI/MACD/ADX/ATR entry logic. Every path through this function ends
// in exactly one INSERT into mechanical_variant_decisions (never an
// UPDATE), whether the signal was executed, reduced, or rejected. No AI
// component is in this call path at all -- it is pure deterministic gating
// over mechanicalRiskEngine.js's pure functions.
async function evaluateMechanicalVariant({ account, portfolio, cfg, mechDecision, marketData, signalId, currentPrice, currentSession }) {
  if (mechDecision.action !== 'TRADE') return; // RED cycles need no gating, mirrors mechanical's own executor

  const today  = uaeDate();
  const equity = portfolio.current_balance;
  await ensureMechVariantDay(account, today, equity);
  const state = mechVariantState[account];

  const { mins: uaeMinutes, day: uaeWeekday, uaeDate: uaeDateObj } = uaeTime();
  const uaeHour = uaeDateObj.getUTCHours();
  const nowUtc  = new Date();

  const riskStateBefore = state.riskState;

  // Daily guards recomputed fresh from live equity every cycle -- pure,
  // monotonic for the day (never un-trips once tripped).
  const guard = evaluateDailyGuards({
    dayStartEquity: state.dayStartEquity, currentEquity: equity, dayPeakEquity: state.dayPeakEquity,
    givebackArmed: state.givebackArmed, givebackLocked: state.givebackLocked, dailyMaxLossHit: state.dailyMaxLossHit,
    dailyMaxLossPct: cfg.dailyMaxLossPct, dailyProfitTargetPct: cfg.dailyProfitTargetPct, giveBackPct: cfg.giveBackPct,
  });
  state.dayPeakEquity = guard.dayPeakEquity;
  state.givebackArmed = guard.givebackArmed;
  state.givebackLocked = guard.givebackLocked;
  state.dailyMaxLossHit = guard.dailyMaxLossHit;
  let stateTransitionReason = guard.event;

  // Evidence-gated PAUSED -> DEFENSIVE check. Deterministic numerical
  // conditions only -- see mechanicalRiskEngine.checkRecoveryEvidence.
  if (state.riskState === 'PAUSED') {
    const recent = await fetchRecentSignalsForRecovery(12);
    const evidence = checkRecoveryEvidence(recent);
    const recovery = applyEvidenceBasedRecovery({ currentState: state.riskState, eligible: evidence.eligible });
    if (recovery.transitioned) {
      console.log(`🔓 [${account}] RISK_RESUME: ${evidence.reasons.join(', ')}`);
      state.riskState = recovery.newState;
      stateTransitionReason = stateTransitionReason ?? `${recovery.reason}(${evidence.reasons.join('+')})`;
    }
  }
  if (stateTransitionReason) await persistMechVariantState(account);

  const riskStateAfter  = state.riskState;
  const allowedRiskPct  = RISK_STATE_PCT[riskStateAfter];
  const sessionPermitted = isWithinEntryWindow(uaeMinutes, cfg.entryWindowStartHour, cfg.entryWindowEndHour);
  const openPositions    = outcomeTracker.getOpenPositionsForPortfolio(portfolio.id);
  const openRiskUsdBefore = computeOpenRiskUsd(portfolio.id);
  const openRiskPctBefore = equity > 0 ? (openRiskUsdBefore / equity) * 100 : 0;
  const theoretical = calculateLotsForRisk({ equity, riskPct: 1.00, entry: mechDecision.entry, stop: mechDecision.stop });

  const base = {
    account, signalId, cycleTsUtc: nowUtc.toISOString(), cycleTsUae: uaeDateObj.toISOString(),
    uaeWeekday, uaeHour,
    direction: mechDecision.direction, signalEntry: mechDecision.entry, signalStop: mechDecision.stop, signalTarget: mechDecision.target,
    mechTag: mechDecision.tag ?? null, mechReasoning: mechDecision.reasoning ?? null,
    h4Rsi: marketData.h4?.rsi ?? null, h1Rsi: marketData.h1?.rsi ?? null,
    h4MacdHist: marketData.h4?.macd_hist ?? null, h1MacdHist: marketData.h1?.macd_hist ?? null,
    h4Adx: marketData.h4?.adx ?? null, h1Adx: marketData.h1?.adx ?? null,
    h1Atr: marketData.h1?.atr ?? null, h4Atr: marketData.h4?.atr ?? null,
    sessionPermitted, riskStateBefore, riskStateAfter, stateTransitionReason,
    allowedRiskPct, equity, dayStartEquity: state.dayStartEquity, dayPnl: guard.dayPnl,
    openRiskPctBefore, openPositionCount: openPositions.length, consecutiveLosses: state.consecutiveLosses,
    theoretical1pctLots: theoretical.lots,
  };

  const reject = (reasonCode, extra = {}) => database.saveMechanicalVariantDecision({
    ...base, clampedStop: extra.clampedStop ?? null, atrMultApplied: extra.atrMultApplied ?? null,
    finalAction: 'REJECT', reasonCode, lots: null, riskUsd: null, tradeId: null,
  });

  // ── Mandatory pipeline, in order, no bypass ──────────────────────────
  if (!sessionPermitted) {
    return reject(account === MECHANICAL_PRIME_BOT ? 'OUTSIDE_PRIME_WINDOW' : 'OUTSIDE_SESSION_WINDOW');
  }
  if (riskStateAfter === 'PAUSED') {
    return reject('LOSS_CLUSTER_PAUSE');
  }
  if (state.dailyMaxLossHit) {
    return reject('DAILY_MAX_LOSS');
  }
  if (state.givebackLocked) {
    return reject('DAILY_GIVEBACK_LOCK');
  }
  if (isMaxPositionsReached(openPositions.length, cfg.maxOpenPositions)) {
    return reject('MAX_POSITIONS');
  }

  const clamp = clampStopToAtrBand({
    direction: mechDecision.direction, entry: mechDecision.entry, rawStop: mechDecision.stop,
    h1Atr: marketData.h1?.atr, atrMultMin: cfg.atrMultMin, atrMultMax: cfg.atrMultMax,
  });
  if (!clamp) {
    return reject('INVALID_STOP');
  }

  const requested = calculateLotsForRisk({ equity, riskPct: allowedRiskPct, entry: mechDecision.entry, stop: clamp.stop });
  if (requested.lots <= 0) {
    return reject('POSITION_TOO_SMALL', { clampedStop: clamp.stop, atrMultApplied: clamp.atrMultApplied });
  }

  const headroom = clampToOpenRiskHeadroom({
    requestedRiskUsd: requested.riskUsd, existingOpenRiskUsd: openRiskUsdBefore, equity, maxTotalRiskPct: cfg.maxTotalRiskPct,
  });
  if (headroom.allowedRiskUsd <= 0) {
    return reject('MAX_OPEN_RISK', { clampedStop: clamp.stop, atrMultApplied: clamp.atrMultApplied });
  }

  let finalLots = requested.lots, finalRiskUsd = requested.riskUsd, finalAction = 'EXECUTE';
  if (headroom.reduced) {
    const headroomPct = (headroom.allowedRiskUsd / equity) * 100;
    const reduced = calculateLotsForRisk({ equity, riskPct: headroomPct, entry: mechDecision.entry, stop: clamp.stop });
    if (reduced.lots <= 0) {
      return reject('MAX_OPEN_RISK', { clampedStop: clamp.stop, atrMultApplied: clamp.atrMultApplied });
    }
    finalLots = reduced.lots; finalRiskUsd = reduced.riskUsd; finalAction = 'REDUCE';
  }

  if (!(finalLots > 0) || !(clamp.distance > 0)) {
    return reject('INVALID_STOP', { clampedStop: clamp.stop, atrMultApplied: clamp.atrMultApplied });
  }

  const decision = {
    action: 'TRADE', direction: mechDecision.direction, entry: mechDecision.entry,
    stop: clamp.stop, target: mechDecision.target, lots: finalLots,
    reasoning: mechDecision.reasoning, tag: account,
  };
  const tradeId = await openPosition({ portfolio, decision, signalId, currentPrice, isSignalOwner: false, session: currentSession });

  return database.saveMechanicalVariantDecision({
    ...base, clampedStop: clamp.stop, atrMultApplied: clamp.atrMultApplied,
    finalAction, reasonCode: finalAction === 'REDUCE' ? 'MAX_OPEN_RISK' : null,
    lots: finalLots, riskUsd: finalRiskUsd, tradeId,
  });
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

  // Whether this is genuinely a NEW day, or just a restart within a day that
  // was already initialized. currentSessionDate is in-memory and resets on
  // every restart, so without this check a mid-day redeploy re-baselines every
  // account: the day's P&L display resets to zero AND the circuit-breaker loss
  // counter forgets losses already taken, allowing a full extra day's loss.
  let storedDay = null;
  try { storedDay = await database.getServiceState('session_day'); } catch { /* treat as new */ }
  const isNewDay = storedDay !== today;

  console.log(isNewDay
    ? `🌅 [SESSION] New session day ${today} — snapshotting day-start balances`
    : `🔄 [SESSION] Restart within ${today} — restoring day-start balances from DB`);

  const portfolios = await database.getAllPortfolios();
  for (const p of portfolios) {
    // Preserve halt state for today (handles server restart mid-session).
    const haltedToday = p.circuit_breaker_date === today;
    let dayStartBalance = (!isNewDay || haltedToday) && p.day_start_balance != null
      ? p.day_start_balance     // same day: keep the baseline already captured
      : p.current_balance;      // genuinely a new day (or no baseline recorded)

    // Self-heal a baseline corrupted by earlier restarts: the true day start is
    // current balance minus everything booked today. Derived, not guessed.
    if (!isNewDay) {
      try {
        const { rows } = await database.pool.query(
          `SELECT COALESCE(realized_pnl, 0) AS realized FROM account_pnl_daily
           WHERE portfolio_id = $1 AND date = $2`,
          [p.id, today]
        );
        const realizedToday = rows[0] ? Number(rows[0].realized) : 0;
        const derived = p.current_balance - realizedToday;
        if (Math.abs(derived - dayStartBalance) > 0.01) {
          console.log(`🔧 [SESSION] ${p.name} day-start corrected $${dayStartBalance.toFixed(2)} → $${derived.toFixed(2)} (realized today $${realizedToday.toFixed(2)})`);
          dayStartBalance = derived;
          await database.setDayStartBalance(p.id, derived);
        }
      } catch (err) {
        console.warn(`⚠️  [SESSION] ${p.name} day-start self-heal skipped: ${err.message}`);
      }
    }

    if (isNewDay && !haltedToday) {
      await database.setDayStartBalance(p.id, dayStartBalance);
      await database.setCircuitBreakerDate(p.id, null);
    }
    circuitBreakerState[p.id] = { halted: haltedToday, haltedOnDate: haltedToday ? today : null, dayStartBalance };
    if (haltedToday) console.log(`🛑 [CIRCUIT BREAKER] ${p.name} still halted (restored)`);

    // FTMO trailing Max Loss anchor: high water = highest day-boundary balance
    // (or initial capital if higher). Positions are flat overnight, so the
    // day-start balance IS the midnight balance.
    if (isNewDay && p.name === PROP.name) {
      const hw = Math.max(p.high_water_balance ?? PROP.initialCapital, p.current_balance);
      if (hw !== p.high_water_balance) await database.setHighWaterBalance(p.id, hw);
    }
  }
  currentSessionDate = today;
  if (isNewDay) {
    try { await database.setServiceState('session_day', today); } catch { /* non-fatal */ }
  }
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
    const isProp     = p.name === PROP.name;
    // prop_sim halts at FTMO's Max Daily Loss (with buffer); others keep -10%
    const threshold  = isProp ? -PROP.dailyLossHalt : -(state.dayStartBalance * 0.10);

    if (dayPnl <= threshold) {
      console.log(
        `🛑 [CIRCUIT BREAKER] ${p.name} hit ${isProp ? 'FTMO daily-loss' : '-10%'} day loss` +
        ` (realized $${realized.toFixed(2)} + unrealized $${unrealized.toFixed(2)} = $${dayPnl.toFixed(2)},` +
        ` threshold $${threshold.toFixed(2)}) — flattened and halted until next session`
      );
      const closed = await outcomeTracker.forceClosePortfolio(p.id, currentPrice);
      state.halted      = true;
      state.haltedOnDate = today;
      await database.setCircuitBreakerDate(p.id, today);
      console.log(`🛑 [CIRCUIT BREAKER] ${p.name} — ${closed} position(s)/shadow(s) closed, halted for session day ${today}`);
    }

    // FTMO trailing Max Loss (10% of initial below high-water): permanent halt.
    if (isProp && !propHardHalted) {
      const equity     = p.current_balance + unrealized;
      const highWater  = p.high_water_balance ?? PROP.initialCapital;
      const totalLimit = highWater - PROP.totalDrawdownHalt;
      if (equity <= totalLimit) {
        console.log(
          `🛑 [PROP HARD HALT] ${p.name} equity $${equity.toFixed(2)} ≤ trailing limit $${totalLimit.toFixed(2)}` +
          ` (high water $${highWater.toFixed(2)} − $${PROP.totalDrawdownHalt}) — account permanently halted`
        );
        await outcomeTracker.forceClosePortfolio(p.id, currentPrice);
        propHardHalted = today;
        await database.setServiceState('prop_hard_halt', JSON.stringify({ date: today, equity, limit: totalLimit }));
      }
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
  // Distinct from a real NO_TRADE: the decider was never consulted this cycle.
  if (tag === 'solo_throttled')          return 'THROTTLED';
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
    const prevDayHL = await getOrFetchPrevDayHighLow();
    marketData.prevDayHigh = prevDayHL?.high ?? null;
    marketData.prevDayLow  = prevDayHL?.low  ?? null;
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
    // At-signal enrichment: day range + ADR snapshot (pure logging, no logic impact)
    mechSignal.dayHighAtSignal = sessionHigh;
    mechSignal.dayLowAtSignal  = sessionLow;
    const adrValue = await getOrFetchAdr();
    mechSignal.adrAtSignal    = adrValue;
    mechSignal.adrConsumedPct = (adrValue && sessionHigh != null && sessionLow != null && adrValue > 0)
      ? ((sessionHigh - sessionLow) / adrValue * 100)
      : null;
    // DXY bias enrichment — already fetched in parallel by getMarketDataBulk, never blocks
    const dxyBias = marketData.dxyBias ?? { bias: 'flat', dxy_price: null, dxy_change_pct: null };
    mechSignal.dxyBiasAtSignal      = dxyBias.bias;
    mechSignal.dxyPriceAtSignal     = dxyBias.dxy_price;
    mechSignal.dxyChangePctAtSignal = dxyBias.dxy_change_pct;
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

    // ── mechanical_prime / mechanical_session ─────────────────────────────
    // Consume the SAME mechDecision computed above -- no second signal call,
    // no duplicated indicator logic. mechanical itself is completely
    // unmodified above this point. Gated first by the same generic -10%
    // circuit breaker every other account already has (checkCircuitBreakers
    // iterates all portfolios automatically), then by the full deterministic
    // pipeline in evaluateMechanicalVariant.
    for (const account of MECH_VARIANT_ACCOUNTS) {
      const portfolio = await database.getPortfolioByName(account);
      if (isHaltedToday(portfolio.id)) {
        console.log(`🛑 [${account}] Circuit breaker active — skipping this cycle`);
        continue;
      }
      const schema = account === MECHANICAL_PRIME_BOT ? MECHANICAL_PRIME_SCHEMA : MECHANICAL_SESSION_SCHEMA;
      const cfg = await getBotConfig(database.pool, account, schema);
      await evaluateMechanicalVariant({
        account, portfolio, cfg, mechDecision, marketData, signalId, currentPrice, currentSession,
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
        // Position cap (same as mechanical's 3): post-rework the overlay
        // approves most proposals, which stacks correlated same-direction
        // positions up against the 10% risk budget without a cap.
        if (overlayOpenPositions.length >= 3) {
          console.log(`⏸️  [OVERLAY] Position cap: ${overlayOpenPositions.length}/3 open — no new position this cycle`);
        } else {
          await openPosition({ portfolio: overlayPortfolio, decision: overlayDecision, signalId, currentPrice, isSignalOwner: false, session: currentSession });
        }
      } else if (overlayDecision.action === 'VETO') {
        await openVetoShadow({ portfolio: overlayPortfolio, decision: overlayDecision, currentPrice, session: currentSession });
      }
    }

    // ── prop_sim (FTMO simulation) retired ────────────────────────────────
    // Stopped trading on request. Its portfolio row, trades and endpoints are
    // deliberately preserved as the historical record of that experiment.

    // ── Claude Solo decider ───────────────────────────────────────────────
    let soloDecision;
    if (!SOLO_ENABLED) {
      soloDecision = { action: 'NO_TRADE', direction: null, entry: null, stop: null, target: null, lots: null, reasoning: 'solo disabled', tag: 'solo_disabled' };
    } else if (isHaltedToday(soloPortfolio.id)) {
      console.log(`🛑 [SOLO] Circuit breaker active — skipping Claude call this cycle`);
      soloDecision = { action: 'NO_TRADE', direction: null, entry: null, stop: null, target: null, lots: null, reasoning: 'circuit breaker halt', tag: 'circuit_breaker_halt' };
    } else if (SOLO_INTERVAL_MS - (Date.now() - lastSoloCallMs) > 0) {
      const soloDueMs = SOLO_INTERVAL_MS - (Date.now() - lastSoloCallMs);
      console.log(`⏭️  [SOLO] throttled — next evaluation in ${Math.ceil(soloDueMs / 60000)} min (every ${SOLO_INTERVAL_MS / 60000} min)`);
      soloDecision = { action: 'NO_TRADE', direction: null, entry: null, stop: null, target: null, lots: null, reasoning: `throttled — solo evaluates every ${SOLO_INTERVAL_MS / 60000} min`, tag: 'solo_throttled' };
    } else {
      lastSoloCallMs = Date.now();
      soloDecision = await claudeSoloDecide(
        marketData, atr, soloPortfolio, soloLessons, soloOpenPositions, null, currentSession
      );
      if (soloDecision.action === 'TRADE') {
        if (soloOpenPositions.length >= 3) {
          console.log(`⏸️  [SOLO] Position cap: ${soloOpenPositions.length}/3 open — no new position this cycle`);
        } else {
          await openPosition({ portfolio: soloPortfolio, decision: soloDecision, signalId, currentPrice, isSignalOwner: false, session: currentSession });
        }
      } else if (soloDecision.action === 'VETO') {
        await openVetoShadow({ portfolio: soloPortfolio, decision: soloDecision, currentPrice, session: currentSession });
      }
    }

    // ── Hybrid bot — overlay judgment + forward-rulebook evidence ─────────
    // Risk envelope is fully config-driven (bot_config table, editable in the
    // web app). Order matters: day-level guards run before any entry logic so
    // the give-back and loss rules can flatten even on a cycle that would
    // otherwise trade.
    try {
      const hyPortfolio = await database.getPortfolioByName(HYBRID_BOT);
      if (hyPortfolio) {
        const cfg = await getBotConfig(database.pool);
        if (hybridDay.date !== uaeDate()) await restoreOrResetHybridDay(uaeDate());

        const openPos = outcomeTracker.getOpenPositionsForPortfolio(hyPortfolio.id);
        const bal     = hyPortfolio.starting_balance || 100000;

        // Peak tracking and the day guards also run on every 1-minute price
        // tick (see checkHybridDayGuards), so a spike between 5-minute cycles
        // cannot escape the give-back rule.
        await checkHybridDayGuards(currentPrice);

        // ── Entry logic ───────────────────────────────────────────────────
        const riskUsed    = openRiskFor(hyPortfolio.id);
        const riskBudget  = bal * (cfg.maxTotalRiskPct / 100);
        const riskLeft    = Math.max(0, riskBudget - riskUsed);

        // Day/time entry blocks — market data/context still flow every cycle
        // regardless (the shared signal pipeline runs for all accounts); only
        // the entry decision (and its LLM call) is skipped here.
        const uaeNow  = new Date(Date.now() + 4 * 3600000);
        const uaeDow  = uaeNow.getUTCDay();   // 0=Sun ... 1=Mon ... 5=Fri ... 6=Sat
        const uaeHour = uaeNow.getUTCHours();
        const inMondayBlock = uaeDow === 1 && uaeHour >= cfg.mondayBlockStartHour && uaeHour < cfg.mondayBlockEndHour;
        const inFridayBlock = uaeDow === 5 && uaeHour >= cfg.fridayBlockStartHour && uaeHour < cfg.fridayBlockEndHour;

        let skip = null;
        if (inMondayBlock)                                    skip = `Monday block (${cfg.mondayBlockStartHour}:00-${cfg.mondayBlockEndHour}:00 UAE) — indicators still settling after the weekend`;
        else if (inFridayBlock)                               skip = `Friday block (${cfg.fridayBlockStartHour}:00-${cfg.fridayBlockEndHour}:00 UAE) — confirmed weak window, 25% WR historically`;
        else if (hybridDay.stoppedReason)                     skip = `stood down: ${hybridDay.stoppedReason}`;
        else if (isHaltedToday(hyPortfolio.id))               skip = 'circuit breaker active';
        else if (openPos.length >= cfg.maxOpenPositions)      skip = `position cap ${openPos.length}/${cfg.maxOpenPositions}`;
        else if (riskLeft < 50)                               skip = `risk budget exhausted ($${riskUsed.toFixed(0)}/$${riskBudget.toFixed(0)})`;

        // Entry throttle is read from the DB, not memory: in-memory state resets
        // to "never traded" on every redeploy, which silently bypassed the gate.
        if (!skip) {
          const { rows: lastRows } = await database.pool.query(
            `SELECT timestamp FROM trades WHERE portfolio_id = $1 ORDER BY timestamp DESC LIMIT 1`,
            [hyPortfolio.id]
          );
          const lastMs = lastRows[0] ? new Date(lastRows[0].timestamp).getTime() : 0;
          const waited = Date.now() - lastMs;
          if (lastMs && waited < cfg.entryIntervalMin * 60000) {
            skip = `entry throttle — ${Math.ceil((cfg.entryIntervalMin * 60000 - waited) / 60000)} min to go`;
          }
        }

        if (skip) {
          console.log(`⏸️  [HYBRID] no entry — ${skip}`);
        } else {
          const sess = currentSession ?? 'unknown';
          const adxB = adxBucket(marketData.h4?.adx);
          const rsiB = rsiBucket(marketData.h4?.rsi);
          const bucketDesc = `${sess} / ADX ${adxB} / RSI ${rsiB}`;
          const { rows: bRows } = await database.pool.query(
            `SELECT * FROM forward_rulebook WHERE session = $1 AND adx_bucket = $2 AND rsi_bucket = $3`,
            [sess, adxB, rsiB]
          );
          const bucket = bRows[0] ?? null;

          // ── Deterministic branch classification (no LLM self-labelling) ──
          const { qualified: rulebookQualified, direction: rulebookDirection } = classifyRulebookQualification(bucket, cfg);
          const { status: overlayStatus, oppositionType: overlayOppositionType, opposingTrade: overlayOpposingTrade } =
            classifyOverlayStatus(overlayDecision, rulebookDirection, mechDecision);
          const { branch, llmNeeded } = classifyBranch({ rulebookQualified, overlayStatus, overlayOpposingTrade });

          let hyDecision;
          let vetoOrReductionReason = null;
          if (llmNeeded) {
            hyDecision = await claudeHybridDecide({
              marketData, atr, portfolio: hyPortfolio, session: currentSession, price: currentPrice,
              overlayDecision, bucket, bucketDesc, cfg, branch,
              openPositions: openPos, riskUsed,
              // No journal fed back by design: the forward rulebook is this
              // bot's only learning input. hybrid_decisions below is pure
              // observability, never re-read into a future prompt.
            });
          } else {
            // Deterministic NO_TRADE rules per spec — no token spent.
            const reasons = {
              rulebook_only_overlay_opposed: `rulebook favors ${rulebookDirection} but overlay ${overlayStatus === 'strongly_opposed' ? 'strongly' : 'weakly'} opposed (${overlayOppositionType ?? 'directional'}) — opposition is not overridden`,
              strong_contradiction:          `rulebook favors ${rulebookDirection}, overlay proposed the opposite direction with its own real trade — genuine ambiguity`,
              no_support:                    `neither the rulebook nor overlay supports a trade this cycle`,
            };
            vetoOrReductionReason = reasons[branch] ?? 'deterministic no-trade rule';
            hyDecision = { action: 'NO_TRADE', direction: null, reasoning: vetoOrReductionReason };
            console.log(`⏸️  [HYBRID] ${branch} — ${vetoOrReductionReason}`);
          }

          // ── Execute (if any) ────────────────────────────────────────────
          let finalRiskUsd = null, finalRiskPct = null, finalLots = null, tradeId = null;
          if (hyDecision.action === 'TRADE') {
            const h1Atr    = atr?.h1;
            const mult     = Math.min(cfg.atrMultMax, Math.max(cfg.atrMultMin, Number(hyDecision.stop_atr_mult)));
            const stopDist = h1Atr ? h1Atr * mult : null;
            const riskUsd  = clampRiskUsd(hyDecision.risk_usd, riskLeft, bal * (cfg.maxRiskPerTradePct / 100));
            const targetR  = Math.max(1.5, Number(hyDecision.target_r));

            if (!stopDist || stopDist <= 0 || riskUsd < 50) {
              console.log(`⏸️  [HYBRID] entry rejected — stopDist=${stopDist} riskUsd=${riskUsd?.toFixed?.(0)}`);
              hyDecision.action = 'NO_TRADE';   // reflected in the journal below
              vetoOrReductionReason = 'invalid geometry or risk below minimum';
            } else {
              const lots = Math.max(0.01, Math.min(Math.floor((riskUsd / (stopDist * VALUE_PER_LOT)) * 100) / 100, 1.0));
              const isLong = hyDecision.direction === 'LONG';

              // Starting a new series: this trade opens from flat, so its
              // give-back baseline must be independent of whatever the last
              // (already-closed) series did — including an opposite-direction
              // one. Precise balance snapshot, taken before this trade's own
              // P&L can affect it.
              if (openPos.length === 0) {
                hybridDay.seriesStartBalance = hyPortfolio.current_balance;
                hybridDay.seriesPeak = 0;
                hybridDay.seriesPeakAt = null; hybridDay.seriesPeakSession = null;
                hybridDay.seriesPeakPositionCount = null; hybridDay.seriesPeakPositionDirections = null;
                await persistHybridDay();
              }

              tradeId = await openPosition({
                portfolio: hyPortfolio,
                decision: {
                  action: 'TRADE',
                  direction: hyDecision.direction,
                  entry:  currentPrice,
                  stop:   isLong ? currentPrice - stopDist : currentPrice + stopDist,
                  target: isLong ? currentPrice + stopDist * targetR : currentPrice - stopDist * targetR,
                  lots,
                  reasoning: hyDecision.reasoning,
                  tag: `${branch}_${hyDecision.direction.toLowerCase()}`,
                },
                signalId, currentPrice, isSignalOwner: false, session: currentSession,
              });
              finalRiskUsd = riskUsd; finalRiskPct = (riskUsd / bal) * 100; finalLots = lots;
              console.log(`🔀 [HYBRID] ${hyDecision.direction} stop=${mult.toFixed(2)}×ATR (${stopDist.toFixed(1)}pts) risk=$${riskUsd.toFixed(0)} lots=${lots} target=${targetR.toFixed(1)}R | ${branch} | ${bucketDesc}`);
            }
          }

          // ── Counterfactual geometry, frozen now (no look-ahead) ──────────
          // Only computed for a direction that was NOT actually taken —
          // there's nothing hypothetical about a trade that really happened.
          //
          // Throttled the same way real entries are (entryIntervalMin): while
          // overlay/the rulebook keep proposing essentially the same held
          // idea cycle after cycle, capturing a fresh counterfactual every 5
          // minutes turns one real position into a dozen correlated,
          // non-independent "trades" in the analytics -- a single losing
          // hold gets sampled repeatedly while a quick winner gets sampled
          // once, silently biasing profit_avoided/profit_missed. (Found live:
          // 80 matured overlay counterfactuals, 80 losses, summing to
          // -$132k, while overlay's real trades over the same window were
          // 8W/6L net +$9.8k -- the same handful of held positions, resampled.)
          const finalDirection = hyDecision.action === 'TRADE' ? hyDecision.direction : null;
          const cfThrottleMs = cfg.entryIntervalMin * 60000;
          const { rows: lastCf } = await database.pool.query(
            `SELECT MAX(CASE WHEN cf_rulebook_direction IS NOT NULL THEN cycle_ts END) AS last_rb,
                    MAX(CASE WHEN cf_overlay_direction  IS NOT NULL THEN cycle_ts END) AS last_ov
             FROM hybrid_decisions WHERE cycle_ts > $1`,
            [new Date(Date.now() - cfThrottleMs).toISOString()]
          );
          const cfRulebookRecent = !!lastCf[0]?.last_rb;
          const cfOverlayRecent  = !!lastCf[0]?.last_ov;

          let cfRulebook = null;
          if (!cfRulebookRecent && rulebookQualified && rulebookDirection && (finalDirection !== rulebookDirection)) {
            const g = computeDefaultCounterfactualGeometry(rulebookDirection, currentPrice, atr?.h1, bal);
            if (g) cfRulebook = g;
          }
          let cfOverlay = null;
          if (!cfOverlayRecent && overlayDecision?.action === 'TRADE' && overlayDecision.direction && finalDirection !== overlayDecision.direction) {
            cfOverlay = {
              direction: overlayDecision.direction, entry: overlayDecision.entry,
              stop: overlayDecision.stop, target: overlayDecision.target, lots: overlayDecision.lots,
            };
          }

          // ── Journal every evaluation that reached this point ─────────────
          // Pure observability — nothing here is ever read back into a future
          // decision. Logged regardless of branch or outcome.
          try {
            await database.saveHybridDecision({
              signalId, cycleTs: new Date().toISOString(), decisionBranch: branch,
              finalAction: hyDecision.action === 'TRADE' ? finalDirection : 'NO_TRADE',
              finalRiskUsd, finalRiskPct, finalLots, tradeId,
              finalReasoning: hyDecision.reasoning ?? null, vetoOrReductionReason,
              mechAction: mechDecision?.action ?? null, mechDirection: mechDecision?.direction ?? null, mechTag: mechDecision?.tag ?? null,
              overlayAction: overlayDecision?.action ?? null, overlayDirection: overlayDecision?.direction ?? null,
              overlayStatus, overlayOppositionType, overlayConfidence: overlayDecision?.action === 'VETO' ? 'high' : null,
              overlayReasoning: overlayDecision?.reasoning ?? null, overlayTag: overlayDecision?.tag ?? null,
              rulebookDirection, rulebookSession: sess, rulebookAdxBucket: adxB, rulebookRsiBucket: rsiB,
              rulebookNTotal: bucket?.n_total ?? null, rulebookAvg1h: bucket?.avg_fwd_1h ?? null,
              rulebookAvg4h: bucket?.avg_fwd_4h ?? null, rulebookAvgEod: bucket?.avg_fwd_eod ?? null,
              rulebookPctUp4h: bucket?.pct_up_4h ?? null, rulebookAvgMaxUp4h: bucket?.avg_max_up_4h ?? null,
              rulebookAvgMaxDown4h: bucket?.avg_max_down_4h ?? null, rulebookConfidence: bucket?.sample_confidence ?? null,
              signalsAgreed: rulebookQualified && overlayStatus === 'supportive',
              cfRulebookDirection: cfRulebook?.direction ?? null, cfRulebookEntry: cfRulebook?.entry ?? null,
              cfRulebookStop: cfRulebook?.stop ?? null, cfRulebookTarget: cfRulebook?.target ?? null,
              cfRulebookRiskUsd: cfRulebook?.riskUsd ?? null, cfRulebookLots: cfRulebook?.lots ?? null,
              cfOverlayDirection: cfOverlay?.direction ?? null, cfOverlayEntry: cfOverlay?.entry ?? null,
              cfOverlayStop: cfOverlay?.stop ?? null, cfOverlayTarget: cfOverlay?.target ?? null, cfOverlayLots: cfOverlay?.lots ?? null,
            });
          } catch (journalErr) {
            console.error(`⚠️  [HYBRID] decision journal write failed (non-fatal): ${journalErr.message}`);
          }

          if (hyDecision.action !== 'TRADE') {
            console.log(`⏸️  [HYBRID] NO_TRADE — branch=${branch}`);
          }
        }
      }
    } catch (hyErr) {
      console.error(`❌ [HYBRID] executor error (cycle continues): ${hyErr.message}`);
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

// ── Window-close sweep — fires once at the 21:00 UAE edge ─────────────────
async function runWindowClose() {
  console.log('\n🔔 [WINDOW CLOSE] ─────────────────────────────────────────');
  console.log('🔔 [WINDOW CLOSE] Trading window ended (21:00 UAE) — force-closing all positions');

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

    // Detect the 21:00 window-close edge: was trading, now not
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
      await checkHybridDayGuards(price);
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

// ── Daily reflection cron — one batched LLM call at 21:15 UAE ────────────
// Runs 15 min after the window close, so every position is closed and P&L
// booked. Replaces ~15 per-trade calls with one.
function startDailyReflector() {
  const REFLECT_UAE_MIN = (parseInt(process.env.REFLECT_UAE_MIN) || (21 * 60 + 15));
  let lastRunDate = null;
  console.log(`🪞 Starting daily reflector (${Math.floor(REFLECT_UAE_MIN / 60)}:${String(REFLECT_UAE_MIN % 60).padStart(2, '0')} UAE)...`);

  setInterval(async () => {
    const uae   = new Date(Date.now() + 4 * 3600000);
    const mins  = uae.getUTCHours() * 60 + uae.getUTCMinutes();
    const today = uaeDate();
    if (lastRunDate === today || mins < REFLECT_UAE_MIN) return;
    lastRunDate = today;   // set before awaiting so a slow run can't double-fire
    console.log(`\n🪞 [DAILY REFLECTION] ${today} ─────────────────────────`);
    await reflectDaily(database.pool);
  }, 60 * 1000);
}

// ── Forward labeler cron — hourly, plus one pass shortly after boot ───────
// All three maturation jobs are staggered a minute apart at boot purely so
// their first-ever log lines don't interleave; they no longer race for API
// calls regardless of timing since m1CandleCache.js's budget/in-flight-dedup
// is shared and per-symbol, not per-job.
function startForwardLabeler() {
  console.log('🏷️  Starting forward labeler (hourly)...');
  setTimeout(() => runForwardLabeling(database.pool), 2 * 60 * 1000);
  setInterval(() => runForwardLabeling(database.pool), 60 * 60 * 1000);
  setTimeout(() => runHybridMaturation(database.pool), 3 * 60 * 1000);
  setInterval(() => runHybridMaturation(database.pool), 60 * 60 * 1000);
  setTimeout(() => runMechanicalVariantMaturation(database.pool), 4 * 60 * 1000);
  setInterval(() => runMechanicalVariantMaturation(database.pool), 60 * 60 * 1000);
}

// ── M1 candle cache retention — once per UAE day ──────────────────────────
function startM1CacheRetention() {
  let lastRunDate = null;
  setInterval(async () => {
    const today = uaeDate();
    if (lastRunDate === today) return;
    lastRunDate = today;
    await cleanupOldM1Candles('XAU/USD');
  }, 60 * 1000);
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
    if (req.query.format === 'csv') {
      if (signals.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        return res.send('');
      }
      const headers = Object.keys(signals[0]);
      const escape = v => {
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...signals.map(row => headers.map(h => escape(row[h])).join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="signals.csv"');
      return res.send(csv);
    }
    res.json({ count: signals.length, data: signals });
  } catch (error) {
    res.status(500).json({ error: 'Failed to export signals', message: error.message });
  }
});

// Trades export — each executed trade joined to its originating signal's at-signal columns.
// ?format=csv → RFC-4180 CSV download  (default: JSON)
// ?account=mechanical|claude_overlay|claude_solo → filter to one account
app.get('/api/export-trades', async (req, res) => {
  try {
    const params = [];
    let accountFilter = '';
    if (req.query.account) {
      params.push(req.query.account);
      accountFilter = `AND p.name = $${params.length}`;
    }

    const { rows } = await database.pool.query(`
      SELECT
        p.name                        AS account,
        t.id                          AS trade_id,
        t.direction,
        t.timestamp                   AS open_time,
        t.exit_timestamp              AS close_time,
        t.entry_price,
        t.exit_price,
        t.stop_loss,
        t.take_profit,
        t.lot_size,
        t.pnl,
        t.exit_reason,
        t.tag,
        t.session,
        t.decider,
        -- signal context
        t.signal_id,
        s.timestamp                   AS signal_time,
        s.session                     AS signal_session,
        s.range_position_pct,
        s.range_width_vs_h1_atr,
        s.session_high,
        s.session_low,
        -- at-signal indicator snapshot (NULL for pre-enrichment trades)
        s.h4_rsi_at_signal,
        s.h1_rsi_at_signal,
        s.m30_rsi_at_signal,
        s.h4_macd_hist_at_signal,
        s.h1_macd_hist_at_signal,
        s.m30_macd_hist_at_signal,
        s.h4_macd_signal_at_signal,
        s.h1_macd_signal_at_signal,
        s.m30_macd_signal_at_signal,
        s.h1_atr_at_signal,
        s.m30_atr_at_signal,
        s.h4_adx_at_signal,
        s.h1_adx_at_signal,
        s.m30_adx_at_signal,
        s.day_high_at_signal,
        s.day_low_at_signal,
        s.adr_at_signal,
        s.adr_consumed_pct
      FROM trades t
      JOIN portfolios p ON p.id = t.portfolio_id
      LEFT JOIN signals s ON s.id = t.signal_id
      WHERE t.exit_reason IS NOT NULL
        AND t.pnl IS NOT NULL
        AND t.exit_reason NOT IN ('NO_ENTRY', 'EXPIRED')
        ${accountFilter}
      ORDER BY p.name, t.timestamp
    `, params);

    if (req.query.format === 'csv') {
      if (rows.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        return res.send('');
      }
      const headers = Object.keys(rows[0]);
      const escape = v => {
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...rows.map(row => headers.map(h => escape(row[h])).join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      const fname = req.query.account ? `trades_${req.query.account}.csv` : 'trades_all.csv';
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(csv);
    }

    res.json({ count: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to export trades', message: error.message });
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

// Manual labeler trigger — used for backfilling history. Call repeatedly
// until remaining=0. ?max_calls is accepted for backward compatibility but
// no longer does anything — the M1 fetch budget is shared across all three
// maturation jobs in m1CandleCache.js now, not assigned per caller. See
// GET /api/m1-cache/metrics for the real, shared call count.
app.post('/api/labeler/run', async (req, res) => {
  try {
    const maxApiCalls = Math.min(parseInt(req.query.max_calls) || 6, 20);
    const result = await runForwardLabeling(database.pool, { maxApiCalls });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual hybrid counterfactual maturation trigger, same shape as above
// (?max_calls likewise accepted but unused — see the comment above).
app.post('/api/hybrid/maturation/run', async (req, res) => {
  try {
    const maxApiCalls = Math.min(parseInt(req.query.max_calls) || 6, 20);
    const result = await runHybridMaturation(database.pool, { maxApiCalls });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-branch decision analytics — win rate, P&L, R, profit factor, drawdown,
// MFE/MAE, and counterfactual profit avoided/missed by each veto/no-trade
// branch. ?start=&end= as YYYY-MM-DD, same convention as the equity chart's
// date-range picker; omit either for all history. ?horizon=h1|h4|eod
// (default eod) selects which counterfactual checkpoint is measured.
app.get('/api/hybrid/branch-analytics', async (req, res) => {
  try {
    const params = [];
    let dateFilter = '';
    if (req.query.start) { params.push(req.query.start + 'T00:00:00Z'); dateFilter += ` AND hd.cycle_ts >= $${params.length}`; }
    if (req.query.end)   { params.push(req.query.end   + 'T23:59:59Z'); dateFilter += ` AND hd.cycle_ts <= $${params.length}`; }
    const horizon = ['h1', 'h4', 'eod'].includes(req.query.horizon) ? req.query.horizon : 'eod';

    const { rows } = await database.pool.query(`
      SELECT hd.*, t.direction, t.entry_price, t.stop_loss, t.take_profit,
             t.pnl, t.max_price_during, t.min_price_during, t.exit_reason
      FROM hybrid_decisions hd
      LEFT JOIN trades t ON t.id = hd.trade_id
      WHERE 1=1 ${dateFilter}
      ORDER BY hd.cycle_ts ASC
    `, params);

    res.json({
      horizon,
      total_evaluations: rows.length,
      branches: computeBranchAnalytics(rows, horizon),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual mechanical-variant maturation trigger. No ?max_calls param anymore
// -- the API budget is shared/internal to m1CandleCache.js now, not
// assigned per caller. Call repeatedly until remaining=0.
app.post('/api/mechanical-variants/maturation/run', async (req, res) => {
  try {
    const result = await runMechanicalVariantMaturation(database.pool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshot of the shared M1 candle cache — requests served from cache vs.
// requiring a Twelve Data fetch, real API calls made, candles inserted,
// budget-exhausted misses, broken down per consumer (forward_labeler /
// hybrid_maturation / mechanical_variant_maturation). This is what lets you
// confirm the third maturation job did not add a third job's worth of usage.
app.get('/api/m1-cache/metrics', (req, res) => {
  res.json(getM1CacheMetrics());
});

// Mechanical / mechanical_prime / mechanical_session comparison — equity,
// P&L, WR, PF, expectancy, drawdown, streaks per account; time-bucket
// breakdowns (hour/3h-window/weekday/weekday×window) from real trade
// history; the five value-attribution metrics for prime/session (mechanical
// itself has no decision journal, so no attribution metrics — nothing to
// attribute value to). ?start=&end= as YYYY-MM-DD, same convention as the
// equity chart and hybrid's branch-analytics; omit either for all history.
app.get('/api/mechanical-variants/comparison', async (req, res) => {
  try {
    const params = [];
    let dateFilter = '';
    if (req.query.start) { params.push(req.query.start + 'T00:00:00Z'); dateFilter += ` AND t.timestamp >= $${params.length}`; }
    if (req.query.end)   { params.push(req.query.end   + 'T23:59:59Z'); dateFilter += ` AND t.timestamp <= $${params.length}`; }

    const ACCOUNTS = ['mechanical', 'mechanical_prime', 'mechanical_session'];
    const accounts = {};

    for (const name of ACCOUNTS) {
      const portfolio = await database.getPortfolioByName(name);
      if (!portfolio) continue;

      const { rows: trades } = await database.pool.query(`
        SELECT t.pnl, t.timestamp, t.exit_timestamp, t.entry_price, t.stop_loss, t.lot_size
        FROM trades t
        WHERE t.portfolio_id = $${params.length + 1} AND t.exit_reason IS NOT NULL ${dateFilter}
        ORDER BY t.timestamp ASC
      `, [...params, portfolio.id]);

      const entry = {
        account: name,
        starting_balance: portfolio.starting_balance,
        comparison: computeComparisonMetrics(trades, portfolio.starting_balance),
        time_buckets: computeTimeBuckets(trades),
      };

      if (name !== 'mechanical') {
        const decParams = [name];
        let decDateFilter = '';
        if (req.query.start) { decParams.push(req.query.start + 'T00:00:00Z'); decDateFilter += ` AND d.cycle_ts_utc >= $${decParams.length}`; }
        if (req.query.end)   { decParams.push(req.query.end   + 'T23:59:59Z'); decDateFilter += ` AND d.cycle_ts_utc <= $${decParams.length}`; }
        const { rows: decisions } = await database.pool.query(`
          SELECT d.reason_code, d.final_action, d.lots, d.theoretical_1pct_lots,
                 o.eod_pnl, o.eod_outcome, o.matured_at,
                 t.pnl AS trade_pnl
          FROM mechanical_variant_decisions d
          LEFT JOIN mechanical_variant_decision_outcomes o ON o.decision_id = d.id
          LEFT JOIN trades t ON t.id = d.trade_id
          WHERE d.account = $1 ${decDateFilter}
        `, decParams);
        entry.attribution = computeAttributionMetrics(decisions);
        entry.total_evaluations = decisions.length;
      }

      accounts[name] = entry;
    }

    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live risk-state snapshot for mechanical_prime/mechanical_session — the
// compact gauge-row equivalent of /api/hybrid/status, not a full account
// panel. Reflects mechVariantState directly (in-memory, restart-safe via
// service_state) rather than recomputing from the decision journal.
app.get('/api/mechanical-variants/status', async (req, res) => {
  try {
    const out = {};
    for (const account of MECH_VARIANT_ACCOUNTS) {
      const portfolio = await database.getPortfolioByName(account);
      if (!portfolio) continue;
      const schema = account === MECHANICAL_PRIME_BOT ? MECHANICAL_PRIME_SCHEMA : MECHANICAL_SESSION_SCHEMA;
      const cfg = await getBotConfig(database.pool, account, schema);
      const state = mechVariantState[account];
      const openRiskUsd = computeOpenRiskUsd(portfolio.id);
      const equity = portfolio.current_balance;
      const peakProfit = state.dayStartEquity != null ? (state.dayPeakEquity ?? state.dayStartEquity) - state.dayStartEquity : null;
      const givebackFloor = state.givebackArmed && peakProfit != null
        ? state.dayStartEquity + peakProfit * (1 - cfg.giveBackPct / 100)
        : null;
      out[account] = {
        balance: equity,
        day_start_equity: state.dayStartEquity,
        day_pnl: state.dayStartEquity != null ? equity - state.dayStartEquity : null,
        risk_state: state.riskState,
        allowed_risk_pct: RISK_STATE_PCT[state.riskState],
        consecutive_losses: state.consecutiveLosses,
        open_positions: outcomeTracker.getOpenPositionsForPortfolio(portfolio.id).length,
        open_risk_usd: openRiskUsd,
        open_risk_pct: equity > 0 ? (openRiskUsd / equity) * 100 : 0,
        risk_budget_pct: cfg.maxTotalRiskPct,
        daily_max_loss_hit: state.dailyMaxLossHit,
        daily_max_loss_pct: cfg.dailyMaxLossPct,
        giveback_armed: state.givebackArmed,
        giveback_locked: state.givebackLocked,
        giveback_floor: givebackFloor,
        entry_window: `${String(cfg.entryWindowStartHour).padStart(2, '0')}:00-${String(cfg.entryWindowEndHour).padStart(2, '0')}:00`,
      };
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FTMO prop-sim account status: all four rule gauges in one payload.
app.get('/api/prop/status', async (req, res) => {
  try {
    const p = await database.getPortfolioByName(PROP.name);
    if (!p) return res.status(404).json({ error: 'prop_sim portfolio not found' });

    const state       = circuitBreakerState[p.id];
    const dayStart    = state?.dayStartBalance ?? p.day_start_balance ?? p.current_balance;
    const dayPnl      = p.current_balance - dayStart;
    const highWater   = p.high_water_balance ?? PROP.initialCapital;

    // Best Day rule: best positive day ≤ 50% of the sum of positive days
    const { rows: days } = await database.pool.query(`
      SELECT date, realized_pnl FROM account_pnl_daily
      WHERE portfolio_id = $1 AND realized_pnl > 0
    `, [p.id]);
    const positiveDaysProfit = days.reduce((s, d) => s + d.realized_pnl, 0);
    const bestDay            = days.reduce((m, d) => d.realized_pnl > (m?.realized_pnl ?? 0) ? d : m, null);
    const bestDayRatio       = positiveDaysProfit > 0 && bestDay ? bestDay.realized_pnl / positiveDaysProfit : null;

    res.json({
      balance:              p.current_balance,
      initial_capital:      PROP.initialCapital,
      profit_target:        PROP.initialCapital * 1.10,
      target_progress_pct:  ((p.current_balance - PROP.initialCapital) / (PROP.initialCapital * 0.10)) * 100,
      day_start_balance:    dayStart,
      day_pnl:              dayPnl,
      daily_halt_at:        -PROP.dailyLossHalt,
      daily_budget_left:    PROP.dailyLossHalt + Math.min(dayPnl, 0),
      high_water:           highWater,
      trailing_halt_at:     highWater - PROP.totalDrawdownHalt,
      halted_today:         isHaltedToday(p.id),
      hard_halted:          propHardHalted,
      profit_governor_hit:  dayPnl >= PROP.dailyProfitGovernor,
      best_day:             bestDay ? { date: bestDay.date, pnl: bestDay.realized_pnl } : null,
      positive_days_profit: positiveDaysProfit,
      best_day_ratio:       bestDayRatio,
      best_day_rule_ok:     bestDayRatio == null || bestDayRatio <= 0.5,
      rules: {
        risk_per_trade:        PROP.riskPerTrade,
        max_open_positions:    PROP.maxOpenPositions,
        daily_loss_halt:       PROP.dailyLossHalt,
        total_drawdown_halt:   PROP.totalDrawdownHalt,
        daily_profit_governor: PROP.dailyProfitGovernor,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset prop_sim as a fresh FTMO challenge: balance, high-water and halts
// back to initial. Trade history stays in the tables (the old attempt's
// record); only the account state resets — "buying a new challenge".
app.post('/api/prop/reset', async (req, res) => {
  try {
    const p = await database.getPortfolioByName(PROP.name);
    if (!p) return res.status(404).json({ error: 'prop_sim portfolio not found' });

    const open = outcomeTracker.getOpenPositionsForPortfolio(p.id);
    if (open.length > 0 && lastKnownPrice) {
      await outcomeTracker.forceClosePortfolio(p.id, lastKnownPrice);
    }

    await database.pool.query(
      `UPDATE portfolios
       SET current_balance = $1, high_water_balance = $1, day_start_balance = $1, circuit_breaker_date = NULL
       WHERE id = $2`,
      [PROP.initialCapital, p.id]
    );
    await database.pool.query(`DELETE FROM service_state WHERE key = 'prop_hard_halt'`);
    propHardHalted = null;
    if (circuitBreakerState[p.id]) {
      circuitBreakerState[p.id] = { halted: false, haltedOnDate: null, dayStartBalance: PROP.initialCapital };
    }

    console.log(`🔄 [PROP] account reset to $${PROP.initialCapital.toLocaleString()} — fresh challenge`);
    res.json({ reset: true, balance: PROP.initialCapital, positions_closed: open.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LLM diagnostics ───────────────────────────────────────────────────────
// GET  /api/llm/config  — which provider/model is live (free, no API call)
// POST /api/llm/verify  — fires N real decider prompts and reports schema
//   compliance. Run this after any model change: a model that can't hold the
//   JSON schema turns an account into a silent permanent NO_TRADE.

app.get('/api/llm/config', (req, res) => {
  res.json({ provider: PROVIDER, model: LLM_MODEL, calls_today: todayCallCount(), last_call_usage: getLastCallUsage() });
});

const LLM_TEST_SYSTEM = `You are a gold (XAU/USD) trading decider.
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE" | "VETO",
  "direction": "LONG" | "SHORT" | null,
  "entry": <number or null>,
  "stop": <number or null>,
  "target": <number or null>,
  "lots": <number or null>,
  "reasoning": "<1-2 sentences>",
  "tag": "<snake_case label>"
}

For TRADE all numeric fields must be present:
  LONG: stop < entry < target (strictly)
  SHORT: target < entry < stop (strictly)
For VETO or NO_TRADE set direction/entry/stop/target/lots to null.`;

const LLM_TEST_USER = `MARKET SNAPSHOT — XAU/USD
Current price: $4050.00
Current session: EUR
Account balance: $100000.00

TIMEFRAMES:
H4 : price=4050.00  RSI=58.2  MACD=4.10/sig=2.90/hist=1.20  ATR=22.0  ADX=31.5
H1 : price=4050.00  RSI=61.4  MACD=2.80/sig=1.60/hist=1.20  ATR=15.0  ADX=28.0
M30: price=4050.00  RSI=59.0  MACD=1.40/sig=0.90/hist=0.50  ATR=9.0   ADX=24.0

PRIMARY ATR: H1=15.0  M30=9.0

OPEN POSITIONS: none
RISK BUDGET: $0 used / $10000 limit

You have a defensible bullish read. Size a LONG with a 1.5x H1 ATR stop and
at least 1.5:1 reward-to-risk, risking 2% of the account.

What is your trading decision for this cycle?`;

app.post('/api/llm/verify', async (req, res) => {
  try {
    const runs  = Math.min(parseInt(req.query.runs) || 3, 10);
    const model = req.query.model || null;   // A/B a candidate without redeploying
    const results = [];
    let ok = 0;
    const t0 = Date.now();

    for (let i = 0; i < runs; i++) {
      const d = await callDecider({
        systemPrompt: LLM_TEST_SYSTEM,
        userContent:  LLM_TEST_USER,
        deciderName:  'llm_verify',
        modelOverride: model,
      });
      const failed = typeof d.tag === 'string' && /_(parse_failure|validation_error|api_error)$/.test(d.tag);
      if (!failed) ok++;
      results.push({
        valid:     !failed,
        action:    d.action,
        direction: d.direction ?? null,
        entry: d.entry ?? null, stop: d.stop ?? null, target: d.target ?? null, lots: d.lots ?? null,
        tag:       d.tag,
        detail:    failed ? d.reasoning : undefined,
        usage:     getLastCallUsage(),
      });
    }

    res.json({
      provider: PROVIDER,
      model:    model || LLM_MODEL,
      runs,
      valid:    ok,
      verdict:  ok === runs ? 'PASS — model holds the schema' : 'FAIL — schema failures become silent NO_TRADE',
      avg_seconds: +((Date.now() - t0) / 1000 / runs).toFixed(1),
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the daily batch reflection (also runs at 21:15 UAE).
app.post('/api/reflect/daily', async (req, res) => {
  try {
    res.json(await reflectDaily(database.pool, { dryRun: req.query.dry_run === '1', limit: parseInt(req.query.limit) || undefined }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hybrid bot live state: day P&L against its target, loss limit and the
// give-back floor, plus why it stood down if it did.
app.get('/api/hybrid/status', async (req, res) => {
  try {
    const p = await database.getPortfolioByName(HYBRID_BOT);
    if (!p) return res.status(404).json({ error: 'claude_hybrid portfolio not found' });
    const cfg = await getBotConfig(database.pool);

    // Same source as AccountPanel's "today" figure for the other three
    // accounts (account_pnl_daily, keyed by date) -- reads 0 with no special
    // handling on a day nothing closed, instead of carrying forward the last
    // trading day's balance delta under a "today" label.
    const today      = new Date().toISOString().split('T')[0];
    const realized   = await database.getDailyRealizedPnl(p.id, today);
    const unrealized = lastKnownPrice ? computeUnrealizedPnl(p.id, lastKnownPrice) : 0;
    const dayPnl     = realized + unrealized;
    const bal        = p.starting_balance || 100000;
    const isToday    = hybridDay.date === uaeDate();
    const seriesActive = isToday && hybridDay.seriesStartBalance != null;

    // Give-back is per-series now: an earlier, already-closed series (even an
    // opposite-direction one) no longer drags on whether the CURRENT series
    // is protected. Guards sample the peak every minute; take the live value
    // if this request lands between ticks, so peak can't read stale-low.
    const seriesPnl  = seriesActive ? (p.current_balance - hybridDay.seriesStartBalance) + unrealized : null;
    const seriesPeak = seriesActive ? Math.max(hybridDay.seriesPeak, seriesPnl) : null;
    const armUsd     = bal * (cfg.giveBackArmPct / 100);
    const armed      = seriesActive && seriesPeak >= armUsd;

    res.json({
      balance:          p.current_balance,
      starting_balance: bal,
      day_pnl:          dayPnl,
      series_active:    seriesActive,
      series_pnl:       seriesPnl,
      series_peak:      seriesPeak,
      give_back_armed:  armed,
      give_back_floor:  armed ? seriesPeak * (1 - cfg.giveBackPct / 100) : null,
      daily_target:     bal * (cfg.dailyProfitTargetPct / 100),
      daily_max_loss:   -(bal * (cfg.dailyMaxLossPct / 100)),
      stopped_reason:   isToday ? hybridDay.stoppedReason : null,
      runs_banked:      isToday ? (hybridDay.runsBanked || 0) : 0,
      open_positions:   outcomeTracker.getOpenPositionsForPortfolio(p.id).length,
      risk_used:        openRiskFor(p.id),
      risk_budget:      bal * (cfg.maxTotalRiskPct / 100),
      config:           cfg,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bot config — live-editable parameters, no redeploy needed ────────────
// Schema drives the settings form; every write is clamped server-side.
// bot -> schema lookup. Unknown/omitted ?bot= falls back to hybrid, so every
// pre-existing caller (no query param) is byte-identical to before.
function schemaForBot(botName) {
  if (botName === MECHANICAL_PRIME_BOT)   return MECHANICAL_PRIME_SCHEMA;
  if (botName === MECHANICAL_SESSION_BOT) return MECHANICAL_SESSION_SCHEMA;
  return CONFIG_SCHEMA;
}

app.get('/api/bot-config', async (req, res) => {
  try {
    const bot = req.query.bot || HYBRID_BOT;
    const schema = schemaForBot(bot);
    res.json({ bot, schema, config: await getBotConfig(database.pool, bot, schema) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bot-config', async (req, res) => {
  try {
    const bot = req.query.bot || HYBRID_BOT;
    const schema = schemaForBot(bot);
    const saved = await saveBotConfig(database.pool, req.body?.config ?? req.body ?? {}, bot, schema);
    console.log(`⚙️  [${bot}] config updated: ${JSON.stringify(saved)}`);
    res.json({ saved: true, config: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Labeling progress snapshot.
app.get('/api/labeler/status', async (req, res) => {
  try {
    const { rows } = await database.pool.query(`
      SELECT COUNT(*)                                        AS total,
             COUNT(fwd_labeled_at)                           AS labeled,
             COUNT(fwd_return_4h)                            AS with_4h_label,
             MIN(timestamp) FILTER (WHERE fwd_labeled_at IS NULL) AS oldest_unlabeled
      FROM signals
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyst/run', async (req, res) => {
  try {
    const result = await runAnalysis(database.pool);
    console.log(`📊 Analyst: run complete — ${result.rulebook_rows_written} rulebook rows, ${result.combination_rows_written} combination rows`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backfill endpoint — reclassifies historical observation entries as win/loss
// by P&L sign and tags them exit_type='forced'. Safe to re-run (idempotent).
// GET  → dry run: shows what would change, no writes.
// POST → executes the backfill then re-runs analysis.
app.get('/api/analyst/backfill-journal', async (req, res) => {
  try {
    const pool = database.pool;
    const { rows: preview } = await pool.query(`
      SELECT p.name AS account,
             COUNT(*)                                       AS observation_count,
             COUNT(CASE WHEN t.pnl > 0 THEN 1 END)        AS would_become_win,
             COUNT(CASE WHEN t.pnl < 0 THEN 1 END)        AS would_become_loss,
             COUNT(CASE WHEN t.pnl = 0 THEN 1 END)        AS would_stay_observation
      FROM journal j
      JOIN trades t ON t.id = j.signal_or_trade_id
      JOIN portfolios p ON p.id = j.portfolio_id
      WHERE j.portfolio_id IN (2, 3)
        AND j.entry_type = 'observation'
        AND t.exit_reason IN ('WINDOW_CLOSE', 'CIRCUIT_BREAKER', 'MANAGED_CLOSE')
        AND t.pnl IS NOT NULL
      GROUP BY p.name
    `);
    res.json({ dry_run: true, would_reclassify: preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyst/backfill-journal', async (req, res) => {
  try {
    const pool = database.pool;

    // Before counts
    const { rows: before } = await pool.query(`
      SELECT p.name AS account, j.entry_type, COUNT(*) AS n
      FROM journal j
      JOIN portfolios p ON p.id = j.portfolio_id
      WHERE j.portfolio_id IN (2, 3) AND j.entry_type IN ('win','loss','observation')
      GROUP BY p.name, j.entry_type ORDER BY p.name, j.entry_type
    `);

    // Step 1: tag existing strategy win/loss entries (TARGET_HIT/STOP_HIT) with exit_type
    const { rowCount: strategyTagged } = await pool.query(`
      UPDATE journal j
      SET exit_type = 'strategy'
      FROM trades t
      WHERE j.signal_or_trade_id = t.id
        AND j.portfolio_id IN (2, 3)
        AND j.entry_type IN ('win', 'loss')
        AND j.exit_type IS NULL
        AND t.exit_reason IN ('TARGET_HIT', 'STOP_HIT')
    `);

    // Step 2: reclassify WINDOW_CLOSE/CIRCUIT_BREAKER observations as win/loss
    const { rowCount: reclassified } = await pool.query(`
      UPDATE journal j
      SET entry_type = CASE WHEN t.pnl > 0 THEN 'win' WHEN t.pnl < 0 THEN 'loss' ELSE 'observation' END,
          exit_type  = 'forced'
      FROM trades t
      WHERE j.signal_or_trade_id = t.id
        AND j.portfolio_id IN (2, 3)
        AND j.entry_type = 'observation'
        AND t.exit_reason IN ('WINDOW_CLOSE', 'CIRCUIT_BREAKER', 'MANAGED_CLOSE')
        AND t.pnl IS NOT NULL
    `);

    // After counts
    const { rows: after } = await pool.query(`
      SELECT p.name AS account, j.entry_type, COUNT(*) AS n
      FROM journal j
      JOIN portfolios p ON p.id = j.portfolio_id
      WHERE j.portfolio_id IN (2, 3) AND j.entry_type IN ('win','loss','observation')
      GROUP BY p.name, j.entry_type ORDER BY p.name, j.entry_type
    `);

    // Re-run analysis on the now-complete dataset
    const analystResult = await runAnalysis(pool);

    res.json({
      strategy_tagged: strategyTagged,
      reclassified,
      before,
      after,
      analyst: analystResult,
    });
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

app.get('/api/analyst/mechanical-rulebook', async (req, res) => {
  try {
    const { rows } = await database.pool.query(`
      SELECT * FROM mechanical_rulebook
      ORDER BY n_total DESC, win_rate DESC
    `);
    res.json({ rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analyst/forward-rulebook', async (req, res) => {
  try {
    const { rows } = await database.pool.query(`
      SELECT * FROM forward_rulebook
      ORDER BY n_total DESC
    `);
    res.json({ rows, count: rows.length });
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

// Restore the day's session range (survives redeploys).
await restoreSessionRange();

// Restore the prop hard-halt flag (a fired trailing Max Loss is permanent).
try {
  const raw = await database.getServiceState('prop_hard_halt');
  if (raw) {
    propHardHalted = JSON.parse(raw).date ?? 'unknown';
    console.log(`🛑 [PROP] hard halt restored (fired ${propHardHalted})`);
  }
} catch { /* absent = never fired */ }

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
        // Real entry time from the DB, not the restart time — otherwise every
        // restored position reports the moment of the restart, which breaks
        // age-based logic (expiry, time exits) and misreports entry spacing.
        startTime:      t.timestamp ? new Date(t.timestamp) : new Date(),
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
    const [q1, q2, q3, q4, q5, q6] = await Promise.all([
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
      pool.query(`
        SELECT t.tag, t.direction, t.reasoning, t.session, t.timestamp,
               t.exit_reason, t.pnl
        FROM trades t JOIN portfolios p ON p.id = t.portfolio_id
        WHERE p.name = 'claude_solo' AND t.exit_reason IS NOT NULL
        ORDER BY t.timestamp DESC LIMIT 20`),
      pool.query(`
        SELECT t.tag, t.direction, t.session, t.timestamp,
               t.exit_reason, t.pnl,
               s.h4_adx, s.h1_adx, s.h4_rsi, s.h1_rsi,
               s.h4_macd, s.h1_macd,
               s.session_high, s.session_low, s.range_position_pct
        FROM trades t
        JOIN portfolios p ON p.id = t.portfolio_id
        JOIN signals s ON s.id = t.signal_id
        WHERE p.name = 'claude_solo' AND t.exit_reason IS NOT NULL
        ORDER BY t.timestamp DESC LIMIT 20`),
    ]);
    res.json({
      q1_window_close_by_account: q1.rows,
      q2_circuit_breaker_history: q2.rows,
      q3_risk_budget_utilization: q3.rows,
      q4_no_entry_rate:           q4.rows,
      q5_solo_recent_trades:      q5.rows,
      q6_solo_recent_with_signals: q6.rows,
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
  startForwardLabeler();
  startM1CacheRetention();
  startDailyReflector();
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  outcomeTracker.stopMonitoring();
  database.close();
  process.exit(0);
});
