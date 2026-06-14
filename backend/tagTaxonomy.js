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

// Formatted block for injection into the reflector system prompt.
export const TAXONOMY_PROMPT_BLOCK = `\
REQUIRED: You must select the tag from the list below that best fits this lesson. \
Do not invent new tag strings. If two tags could apply, pick the one most central to the lesson.

AVAILABLE TAGS:
${Object.entries(TAG_TAXONOMY).map(([k, v]) => `${k} — ${v}`).join('\n')}`;
