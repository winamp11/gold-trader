// overlay_mirror entry gate.
//
// Extracted from the signal cycle so the conditions are testable without a
// running server. Order matters and is preserved verbatim: the first matching
// condition wins, and the DB-backed entry throttle is evaluated last, in the
// caller, because it costs a query.
//
// The purpose of overlay_mirror is to isolate ONE variable — does overlay's
// judgement do better inside hybrid's risk envelope? That only holds if both
// books contain the same positions. Anything that lets the two diverge on
// WHICH trades are taken destroys the comparison, because a P&L gap can then
// no longer be attributed to the risk envelope.

export function mirrorSkipReason(ctx) {
  const {
    overlayAction,        // overlayDecision.action
    overlayExecuted,      // did overlay actually OPEN a position this cycle
    overlayBlockedReason, // why not, when it decided TRADE but did not open
    dayOfWeek,            // UAE day of week, 0=Sun
    hour,                 // UAE hour
    cfg,
    stoppedReason,
    circuitBreaker,
    openPositions,
    riskLeftUsd,
    riskUsedUsd,
    riskBudgetUsd,
  } = ctx;

  if (overlayAction !== 'TRADE') {
    return { code: 'NO_OVERLAY_TRADE', reason: `overlay did not propose (${overlayAction ?? 'none'})` };
  }
  // Mirror what overlay DID, not merely what it decided. A TRADE decision that
  // overlay's own position cap then blocks still reads as action 'TRADE', so a
  // gate keyed on the decision alone opens a trade overlay never took. This is
  // the condition that keeps the two books identical.
  if (!overlayExecuted) {
    return {
      code: 'OVERLAY_NOT_EXECUTED',
      reason: `overlay proposed but did not open (${overlayBlockedReason ?? 'unknown'})`,
    };
  }
  if (dayOfWeek === 1 && hour >= cfg.mondayBlockStartHour && hour < cfg.mondayBlockEndHour) {
    return { code: 'MONDAY_BLOCK', reason: 'Monday block' };
  }
  if (dayOfWeek === 5 && hour >= cfg.fridayBlockStartHour && hour < cfg.fridayBlockEndHour) {
    return { code: 'FRIDAY_BLOCK', reason: 'Friday block' };
  }
  if (stoppedReason)   return { code: 'STOOD_DOWN', reason: `stood down: ${stoppedReason}` };
  if (circuitBreaker)  return { code: 'CIRCUIT_BREAKER', reason: 'circuit breaker active' };
  if (openPositions >= cfg.maxOpenPositions) {
    return { code: 'POSITION_CAP', reason: `position cap ${openPositions}/${cfg.maxOpenPositions}` };
  }
  if (riskLeftUsd < 50) {
    return {
      code: 'RISK_EXHAUSTED',
      reason: `risk budget exhausted ($${riskUsedUsd.toFixed(0)}/$${riskBudgetUsd.toFixed(0)})`,
    };
  }
  return null;
}
