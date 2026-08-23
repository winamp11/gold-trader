// Controlled tag taxonomy for journal entries.
// Every journal entry MUST use one of these keys as its tag.
// Consistent tags are required for pin firing, Analyst aggregation, and pattern tracking.

export const TAG_TAXONOMY = {
  // Stop management
  stop_hunt:                    'Stop placed at predictable level, wicked before move played out',
  stop_too_tight:               'Stop too narrow for ATR, normal volatility triggered it',
  stop_widened_survived:        'Wider stop kept trade alive, target hit',

  // Entry timing
  entry_at_exhaustion:          'Entered at end of move, no room left to run',
  entry_premature:              'Entered before confirmation candle closed',
  entry_confirmed_rejection:    'Waited for rejection candle, clean entry',

  // Trend/regime
  counter_trend_failed:         'Traded against H4 trend, structure overwhelmed setup',
  low_adx_trap:                 'Low ADX meant no real trend, momentum signal false',
  adx_high_trend_confirmed:     'ADX>50 confirmed strong trend, trade worked',

  // Momentum/RSI
  rsi_exhaustion_fade_win:      'Faded overbought/oversold RSI in strong trend, worked',
  rsi_exhaustion_fade_loss:     'Faded RSI but trend had more fuel left',
  m5_divergence_ignored:        'M5 divergence warned against entry, ignored it',

  // R:R / sizing
  rr_too_low_vetoed:            'R:R below threshold, correctly vetoed',
  rr_too_low_missed_winner:     'R:R below threshold, veto missed a winner',
  sized_down_survived:          'Smaller size absorbed wider stop, trade recovered',

  // Session/volatility
  session_open_volatility:      'Whipsaw during session open invalidated setup',
  session_settled_clean_entry:  'Waited for post-open settle, cleaner result',

  // Multi-timeframe
  mtf_alignment_win:            'All timeframes aligned, high conviction trade worked',
  mtf_divergence_ignored_loss:  'Timeframe conflict noted but ignored, trade failed',

  // Veto outcomes
  rsi_extreme_veto_correct:     'Vetoed on RSI extreme reading, trade would have hit stop — correct',
  rsi_extreme_veto_missed:      'Vetoed on RSI extreme reading, trade would have hit target — missed winner',
  veto_correct_outcome_avoided: 'Vetoed on structural/process grounds, stop would have hit — correct',
  veto_missed_winner:           'Vetoed on structural/process grounds, target would have hit — missed winner',

  // Pattern reinforcement
  sell_bounce_downtrend_win:    'Shorted exhausted bounce in downtrend, target hit',
  sell_bounce_downtrend_loss:   'Shorted bounce in downtrend, stopped out',
  buy_bounce_uptrend_win:       'Bought pullback in uptrend, target hit',
  buy_bounce_uptrend_loss:      'Bought pullback in uptrend, stopped out',

  // Trade lifecycle / artifacts
  expired_no_fill:              'Trade expired or timed out without hitting target or stop — no follow-through',
  window_close_exit:            'Trade closed by session window end, not by TP or SL — artifact, exclude from expectancy',
  momentum_continuation:        'Entered continuation of existing move, not a bounce fade',
  pyramid_trend_add:            'Added to a winning position in trend direction — scaling in',

  // Overlay-specific
  atr_resize_win:               'Overlay approved mechanical proposal with ATR-based resize — won',
  no_entry_observation:         'Overlay or solo chose not to enter — observation only, no trade taken',
};

// Tags whose own taxonomy definition says the outcome was an artifact of the
// harness rather than the trade thesis being wrong. These must never pin: a
// pinned lesson is fed back into the decider as a recurring mistake to avoid,
// and there is nothing for it to avoid here. window_close_exit alone had 34
// entries and was displacing genuine lessons from the 3-slot cap.
export const ARTIFACT_TAGS = new Set([
  'window_close_exit',    // closed by the 21:00 UAE window, not by TP/SL
  'expired_no_fill',      // never filled — no trade thesis was ever tested
  'no_entry_observation', // no trade taken; an observation, not an outcome
]);

// Veto entries whose verdict is that the veto COST money — the counterfactual
// would have won. These are the veto-side equivalent of a losing trade, and
// the only veto outcomes worth pinning: a veto that correctly avoided a loss
// is not a mistake to be reminded of.
//
// Journal rows carry no structured verdict for vetoes (entry_type is always
// 'veto', exit_type is null), so the tag is the only place the outcome is
// recorded. Membership is asserted against TAG_TAXONOMY in the tests, so
// renaming a tag there breaks loudly rather than silently emptying this set.
//
// Membership rule: the tag must name a MECHANISM, not merely record a verdict.
// A pinned lesson is injected into the decider as something to do differently,
// so it has to identify what. 'rsi_extreme_veto_missed' does — it points at
// vetoing on an RSI extreme, which cost $42,693 across 24 entries and is a
// specific habit overlay can change.
//
// 'veto_missed_winner' is deliberately excluded despite being the veto-side
// analogue of a loss. It means only "vetoed on structural grounds, was wrong",
// naming no pattern. Pinning it restates the aggregate veto record as a
// recurring mistake — and the aggregate is measured at +85,356 in favour of
// vetoing (550 losers avoided against 519 winners forgone). It would tell
// overlay to veto less on the strength of a number that says the opposite,
// and a coin flip contains no pattern to learn from anyway.
export const COSTLY_VETO_TAGS = new Set([
  'rsi_extreme_veto_missed',
]);

// Verdict-only tags: they record whether an outcome was good or bad without
// identifying any mechanism behind it. Never pinnable, on either side of the
// ledger. Kept as an explicit set rather than an omission so the reasoning is
// visible at the point where someone would otherwise re-add one.
export const VERDICT_ONLY_TAGS = new Set([
  'veto_missed_winner',
  'veto_correct_outcome_avoided',
]);

// ── Entry-reason taxonomy (decider-side) ──────────────────────────────────
// Distinct from TAG_TAXONOMY above, which is post-hoc *lesson* classification
// used by the reflector and by pin firing. This one answers a different
// question: "why is this trade being entered?", recorded on trades.tag at
// decision time. Kept closed so Analyst can aggregate expectancy per setup —
// free-text tags produced 77 distinct strings over 125 trades, 59 of them
// appearing exactly once, which no aggregation can act on.
//
// Risk mechanics (ATR resizing, stop staggering, correlated-book size cuts)
// are deliberately NOT entry reasons and must not appear here — they were the
// dominant source of the fragmentation (`atr_resize` appeared in 73 of 77 tags).
export const ENTRY_TAG_TAXONOMY = {
  trend_h4:          'Entering with the established H4 trend direction',
  trend_h1:          'H1 momentum push; H4 neutral, absent or unclear',
  macd_align:        'H4 and H1 MACD agree, and that agreement is the reason for entry',
  adx_trend:         'ADX confirms an established trend and the entry goes with it',
  pullback:          'Counter-move into a trend — buying a dip or selling a rally',
  breakout:          'Price clears the day or session high/low and the entry follows it',
  range_fade:        'Fading the session high or low as resistance or support',
  stop_hunt_reentry: 'Entering after a stop sweep / liquidity grab has reversed',
  correlated_add:    'Adding to an existing position in the same direction',
  other:             'None of the above genuinely fits this entry',
};

// Formatted block for injection into decider system prompts.
export const ENTRY_TAXONOMY_PROMPT_BLOCK = `\
REQUIRED: "tag" must be exactly one key from the list below — the single reason \
this entry is being taken. Do not invent tags, do not combine them with "_", and \
do not describe sizing or stop mechanics (ATR resizing, staggered stops, \
correlated-book reductions) in the tag; those belong in "reasoning".
If none genuinely fits, use "other" — do not force a near-miss.

AVAILABLE ENTRY TAGS:
${Object.entries(ENTRY_TAG_TAXONOMY).map(([k, v]) => `${k} — ${v}`).join('\n')}`;

// Formatted block for injection into the reflector system prompt.
export const TAXONOMY_PROMPT_BLOCK = `\
REQUIRED: You must select the tag from the list below that best fits this lesson. \
Do not invent new tag strings. If two tags could apply, pick the one most central to the lesson.

AVAILABLE TAGS:
${Object.entries(TAG_TAXONOMY).map(([k, v]) => `${k} — ${v}`).join('\n')}`;
