// mechanicalVariantState.js — owns the persistent risk-engine state for
// mechanical_prime/mechanical_session, in its own module so both server.js
// (pre-trade pipeline: reads state, applies daily guards, evidence-based
// PAUSED->DEFENSIVE recovery) and outcomeTracker.js (post-close: applies
// onTradeClosed's win/loss state transition) can use it without a circular
// import between those two files.
//
// date/dayStartEquity/dayPeakEquity/givebackArmed/givebackLocked/
// dailyMaxLossHit are DAY-SCOPED and reset at the UAE day boundary.
// riskState/consecutiveLosses are CROSS-DAY and never reset by a date
// rollover — see mechanicalRiskEngine.js for why.

import database from './database.js';
import { onTradeClosed } from './mechanicalRiskEngine.js';
import { MECHANICAL_PRIME_BOT, MECHANICAL_SESSION_BOT } from './botConfig.js';

export const MECH_VARIANT_ACCOUNTS = [MECHANICAL_PRIME_BOT, MECHANICAL_SESSION_BOT];

function defaultMechVariantState() {
  return {
    date: null, dayStartEquity: null, dayPeakEquity: 0,
    givebackArmed: false, givebackLocked: false, dailyMaxLossHit: false,
    riskState: 'NORMAL', consecutiveLosses: 0,
  };
}

export const mechVariantState = Object.fromEntries(MECH_VARIANT_ACCOUNTS.map(a => [a, defaultMechVariantState()]));

export async function persistMechVariantState(account) {
  try {
    await database.setServiceState(`mech_variant_state_${account}`, JSON.stringify(mechVariantState[account]));
  } catch (e) {
    console.error(`⚠️  [${account}] state persist failed (non-fatal): ${e.message}`);
  }
}

// Per-account (NOT global) — each account's persisted state must be
// restored independently on the first cycle it's evaluated, or the second
// account in MECH_VARIANT_ACCOUNTS would never load its real state at all.
const stateLoadedOnce = Object.fromEntries(MECH_VARIANT_ACCOUNTS.map(a => [a, false]));

export async function ensureMechVariantDay(account, today, currentEquity) {
  const state = mechVariantState[account];
  if (!stateLoadedOnce[account]) {
    try {
      const raw = await database.getServiceState(`mech_variant_state_${account}`);
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch (e) {
      console.error(`⚠️  [${account}] state restore failed (starting fresh): ${e.message}`);
    }
    stateLoadedOnce[account] = true;
  }
  if (state.date !== today) {
    state.date = today;
    state.dayStartEquity = currentEquity;
    state.dayPeakEquity = currentEquity;
    state.givebackArmed = false;
    state.givebackLocked = false;
    state.dailyMaxLossHit = false;
    await persistMechVariantState(account);
  }
}

// Called from outcomeTracker.finalizePosition() when a mechanical_prime/
// mechanical_session GREEN position closes. Fire-and-forget from the
// caller's perspective (mirrors how reflect()/reflectVeto() are already
// invoked there) — updates the loss-cluster/recovery state machine from
// the ONE source of truth for "did this trade win or lose": realized pnl.
export async function handleMechanicalVariantTradeClosed(portfolioName, pnl) {
  if (!MECH_VARIANT_ACCOUNTS.includes(portfolioName)) return;
  const state = mechVariantState[portfolioName];
  const isWin = pnl > 0;
  const result = onTradeClosed({ currentState: state.riskState, consecutiveLosses: state.consecutiveLosses, isWin });
  state.riskState = result.newState;
  state.consecutiveLosses = result.newConsecutiveLosses;
  if (result.transitioned) {
    console.log(`⚠️  [${portfolioName}] risk state ${result.reason}: -> ${result.newState}`);
  }
  await persistMechVariantState(portfolioName);
}
