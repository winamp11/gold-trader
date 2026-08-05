// hybridBranchClassifier.js — pure, deterministic classification of hybrid's
// decision branch from objective inputs already available before any LLM
// call. No self-labeling: the model is never asked which branch it's in,
// because that reintroduces the unreliable self-classification this project
// hit before (see: tag-rulebook feedback loop). Every function here is a
// plain function of its inputs — no I/O, no randomness, easy to unit test.

const EXECUTION_RISK_KEYWORDS = [
  'whipsaw', 'volatil', 'spread', 'liquidit', 'news', 'event', 'shock', 'gap', 'abnormal',
];

// Same directional-consistency bar the retired prop_sim rulebook-executor
// used: a bucket only counts as "qualified" (strong enough to act on alone)
// above a sample floor with a clear directional lean either way.
export function classifyRulebookQualification(bucket, cfg) {
  if (!bucket) return { qualified: false, direction: null };
  const minSamples = cfg?.rulebookMinSamples ?? 100;
  const n   = bucket.n_total;
  const avg = bucket.avg_fwd_4h;
  const up  = bucket.pct_up_4h;
  if (n == null || avg == null || up == null || n < minSamples) return { qualified: false, direction: null };
  if (avg >= 5 && up >= 58)  return { qualified: true, direction: 'LONG' };
  if (avg <= -5 && up <= 42) return { qualified: true, direction: 'SHORT' };
  return { qualified: false, direction: null };
}

// Overlay exposes only a binary VETO (no confidence score) plus its own
// trade proposals, so opposition is inferred rather than read directly.
// Returns the journaled status (exactly the 4 values the spec asks for) AND
// `opposingTrade` — whether overlay backed its disagreement with a genuine,
// priced trade proposal in the opposite direction, vs. a veto/pass with no
// competing direction of its own. That distinction is what separates
// strong_contradiction (two real, opposing convictions) from
// rulebook_only_overlay_opposed (rulebook alone vs. a veto/pass) at the
// branch level — the status field itself stays to the spec's 4 values.
export function classifyOverlayStatus(overlayDecision, rulebookDirection, mechDecision) {
  const action    = overlayDecision?.action ?? 'NO_TRADE';
  const direction = overlayDecision?.direction ?? null;

  if (action === 'TRADE' && direction && rulebookDirection && direction === rulebookDirection) {
    return { status: 'supportive', oppositionType: null, opposingTrade: false };
  }
  if (action === 'TRADE' && direction && rulebookDirection && direction !== rulebookDirection) {
    // A genuine, priced, opposite-direction conviction — the strongest form
    // of disagreement there is, and the one case with two real trade ideas
    // pointing opposite ways.
    return { status: 'strongly_opposed', oppositionType: 'directional', opposingTrade: true };
  }
  if (action === 'VETO') {
    const text = `${overlayDecision?.reasoning ?? ''} ${overlayDecision?.tag ?? ''}`.toLowerCase();
    const executionRisk = EXECUTION_RISK_KEYWORDS.some(k => text.includes(k));
    return { status: 'strongly_opposed', oppositionType: executionRisk ? 'execution_risk' : 'directional', opposingTrade: false };
  }
  // NO_TRADE. Was there a mechanical proposal opposite the rulebook that
  // overlay simply passed on (neither vetoing nor taking it)?
  const mechDir = mechDecision?.direction ?? null;
  if (mechDir && rulebookDirection && mechDir !== rulebookDirection && mechDecision?.action === 'TRADE') {
    return { status: 'weakly_opposed', oppositionType: 'directional', opposingTrade: false };
  }
  return { status: 'silent', oppositionType: null, opposingTrade: false };
}

// The six stable branch names, plus whether the LLM needs to be called at
// all. strong_contradiction, no_support, and rulebook_only_overlay_opposed
// are deterministic NO_TRADE rules per spec, not judgment calls — none of
// them spend a token.
export function classifyBranch({ rulebookQualified, overlayStatus, overlayOpposingTrade }) {
  const supportive = overlayStatus === 'supportive';
  const silent      = overlayStatus === 'silent';
  const opposed     = overlayStatus === 'weakly_opposed' || overlayStatus === 'strongly_opposed';

  if (rulebookQualified && supportive) {
    return { branch: 'agreement', llmNeeded: true };
  }
  if (rulebookQualified && silent) {
    return { branch: 'rulebook_only_overlay_silent', llmNeeded: true };
  }
  if (rulebookQualified && opposed && overlayOpposingTrade) {
    // Two real, priced, opposing convictions — genuine contradiction.
    return { branch: 'strong_contradiction', llmNeeded: false };
  }
  if (rulebookQualified && opposed) {
    // Rulebook alone vs. a veto or passive disagreement with no competing
    // trade idea of its own.
    return { branch: 'rulebook_only_overlay_opposed', llmNeeded: false };
  }
  if (!rulebookQualified && supportive) {
    return { branch: 'overlay_only', llmNeeded: true };
  }
  // !rulebookQualified: silent, weakly_opposed, or strongly_opposed with no
  // rulebook edge to weigh it against — nothing supports a trade either way.
  return { branch: 'no_support', llmNeeded: false };
}
