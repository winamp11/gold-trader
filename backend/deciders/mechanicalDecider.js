// mechanicalDecider — wraps the existing signalEngine unchanged.
// This is the baseline: no ATR, no M5, no AI.  Results are the ground
// truth against which the two Claude accounts are measured.
//
// decide() returns the standard decider shape plus _signal (internal)
// for backward-compat persistence into the signals table.

import signalEngine from '../signalEngine.js';

export async function decide(marketData, atr, portfolio, recentLessons) {
  const signal = signalEngine.generateSignal(marketData, portfolio.current_balance);

  if (signal.signal === 'GREEN' && signal.recommendation) {
    const rec = signal.recommendation;
    return {
      action:    'TRADE',
      direction: rec.direction,
      entry:     rec.entry,
      stop:      rec.stop,
      target:    rec.target,
      lots:      rec.positionSize,
      reasoning: rec.reasoning,
      tag:       'mechanical',
      _signal:   signal
    };
  }

  return {
    action:    'NO_TRADE',
    direction: null,
    entry:     null,
    stop:      null,
    target:    null,
    lots:      null,
    reasoning: signal.reason || 'Conditions not met',
    tag:       'mechanical',
    _signal:   signal
  };
}
