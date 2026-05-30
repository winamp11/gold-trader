// claudeSoloDecider — Claude generates its own trade ideas from scratch,
// independent of the mechanical signal.  Can return TRADE, NO_TRADE, or
// VETO (not meaningful here since there is no proposal to veto, but kept
// for interface symmetry).
//
// STUB: not yet wired to the Claude API.  Always returns NO_TRADE.

export async function decide(marketData, atr, portfolio, recentLessons) {
  return {
    action:    'NO_TRADE',
    direction: null,
    entry:     null,
    stop:      null,
    target:    null,
    lots:      null,
    reasoning: 'stub: solo not yet wired',
    tag:       'claude_solo_stub'
  };
}
