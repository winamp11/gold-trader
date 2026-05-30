// claudeOverlayDecider — Claude reviews the mechanical proposal and can
// TRADE (accept), VETO (counterfactual shadow), or NO_TRADE (skip).
//
// STUB: not yet wired to the Claude API.  Returns the mechanical
// proposal unchanged with a stub tag so the plumbing can be verified.
// When wired, this decider will receive ATR and recentLessons to make
// an informed accept/veto/modify decision.

export async function decide(marketData, atr, portfolio, recentLessons, mechanicalProposal = null) {
  if (!mechanicalProposal || mechanicalProposal.action !== 'TRADE') {
    return {
      action:    'NO_TRADE',
      direction: null,
      entry:     null,
      stop:      null,
      target:    null,
      lots:      null,
      reasoning: 'stub: overlay not yet wired',
      tag:       'claude_overlay_stub'
    };
  }

  // Mirror the mechanical trade unchanged
  return {
    action:    mechanicalProposal.action,
    direction: mechanicalProposal.direction,
    entry:     mechanicalProposal.entry,
    stop:      mechanicalProposal.stop,
    target:    mechanicalProposal.target,
    lots:      mechanicalProposal.lots,
    reasoning: 'stub: overlay not yet wired',
    tag:       'claude_overlay_stub'
  };
}
