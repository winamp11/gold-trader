// Trading hours: 06:00–21:00 UAE (Asia/Dubai = UTC+4, no DST), Monday–Friday.
// Hard close at 21:00 UAE — existing forceCloseAll mechanism fires at that edge.

// Dubai is UTC+4, no daylight saving time.
// Add 4 h to UTC epoch to read hours/minutes as UAE local time.
// Exported (previously module-private) so callers needing UAE minutes/
// weekday -- e.g. the mechanical_prime/mechanical_session entry-window
// gate -- reuse this single canonical offset instead of adding yet another
// copy of the same +4h arithmetic (already duplicated a few times in this
// codebase; not fixing the existing ones here, just not adding a new one).
export function uaeTime(ts) {
  const uaeDate = new Date((ts ? new Date(ts) : new Date()).getTime() + 4 * 60 * 60 * 1000);
  return {
    mins:    uaeDate.getUTCHours() * 60 + uaeDate.getUTCMinutes(),
    day:     uaeDate.getUTCDay(),    // 0=Sun 1=Mon … 6=Sat (in UAE time)
    uaeDate,
  };
}

const SESSION_START = 6  * 60;  //  06:00 UAE = 360 min
const SESSION_END   = 21 * 60;  //  21:00 UAE = 1260 min

// ── Entry window ─────────────────────────────────────────────────────────
//
// No NEW positions before 10:00 UAE. The session itself still runs from
// 06:00: open positions must keep being monitored and stopped out, signals
// must keep being recorded, and the daily close series must keep advancing.
// Only entries are blocked — this is a filter on taking risk, not a shorter
// trading day.
//
// Measured over 3 Jun – 4 Sep 2026, entries in the 06:00–09:59 window:
//
//   claude_overlay   -41,570 across 23 days, losing on 19 of them
//   mechanical       -45,961 in the 06:00 hour alone
//
// Removing them from the historical record: overlay +23,183 → +74,239,
// mechanical -48,626 → +43,143. It holds out of sample (+27,914 and +30,456
// on trades from 15 Aug onward), survives removing the worst three days,
// survives day-weighting instead of trade-weighting, and appears independently
// in two systems that share no decision logic.
//
// The mechanism is documented in Overlay's own journal rather than inferred:
// thin Tokyo liquidity, stops placed at predictable levels and swept in
// clusters. Three separate hypotheses this month — flat days, H4 lag, and
// multi-timeframe alignment — turned out on inspection to be measuring this
// same window under a different name.
//
// 10:00 rather than 11:00 deliberately: 10:00 is Overlay's single best hour
// (+29,611 over 19 trades, profitable on 8 of 9 days, and it improves when its
// worst day is removed). Opening at 11:00 would discard the strongest hour of
// the day to avoid nothing.
const ENTRY_START = 10 * 60;    //  10:00 UAE = 600 min

// True when a NEW position may be opened. Strictly narrower than
// isTradingHours: every entry minute is a trading minute, but not the reverse.
export function isEntryWindow(ts) {
  const { mins, day } = uaeTime(ts);
  if (day === 0 || day === 6) return false;
  return mins >= ENTRY_START && mins < SESSION_END;
}

// Why an entry was refused, for logging. null when it was allowed.
export function entryBlockReason(ts) {
  if (isEntryWindow(ts)) return null;
  const { mins, day } = uaeTime(ts);
  if (day === 0 || day === 6) return 'weekend';
  if (mins < ENTRY_START)     return `pre-10:00 UAE entry block (${getSession(ts) ?? 'pre-session'})`;
  return 'outside trading hours';
}

export function isTradingHours(ts) {
  const { mins, day } = uaeTime(ts);
  if (day === 0 || day === 6) return false;
  return mins >= SESSION_START && mins < SESSION_END;
}

// Returns one of 'JP'|'JP-EUR'|'EUR'|'EUR-US'|'US', or null outside the window.
// Every minute in the 06:00–21:00 UAE window maps to exactly one label.
export function getSession(ts) {
  const { mins, day } = uaeTime(ts);
  if (day === 0 || day === 6) return null;
  if (mins < 360)  return null;      // 00:00–06:00 UAE — pre-session
  if (mins < 600)  return 'JP';      // 06:00–10:00 UAE — Tokyo
  if (mins < 660)  return 'JP-EUR';  // 10:00–11:00 UAE — Tokyo/London overlap
  if (mins < 960)  return 'EUR';     // 11:00–16:00 UAE — London
  if (mins < 1140) return 'EUR-US';  // 16:00–19:00 UAE — London/NY overlap
  if (mins < 1260) return 'US';      // 19:00–21:00 UAE — New York
  return null;                       // 21:00+ UAE — post-session
}

// True if any trading-hours minute (Mon-Fri 06:00-21:00 UAE) falls inside
// [fromMs, toMs). Used by m1CandleCache.js to tell "missing data" apart from
// "the market was legitimately closed" -- a weekend/off-hours gap should
// never trigger a Twelve Data fetch attempt. Bounded day-walk (maturation
// gaps are at most a few days), exact rather than sampled: a false "no
// trading time here" would silently hide real missing candles, which this
// project explicitly does not want to risk to save an API call.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export function hasTradingWindowInRange(fromMs, toMs) {
  if (!(toMs > fromMs)) return false;
  const startUae = uaeTime(fromMs).uaeDate;
  const endUae   = uaeTime(toMs).uaeDate;
  let cursor = Date.UTC(startUae.getUTCFullYear(), startUae.getUTCMonth(), startUae.getUTCDate());
  const lastDay = Date.UTC(endUae.getUTCFullYear(), endUae.getUTCMonth(), endUae.getUTCDate());
  while (cursor <= lastDay) {
    const dow = new Date(cursor).getUTCDay(); // cursor is a UAE-local midnight, day-of-week is UAE's
    if (dow >= 1 && dow <= 5) {
      const dayStartUtcMs = cursor - 4 * 60 * 60 * 1000; // UAE midnight -> UTC
      const winStart = dayStartUtcMs + SESSION_START * 60000;
      const winEnd   = dayStartUtcMs + SESSION_END   * 60000;
      if (winStart < toMs && winEnd > fromMs) return true; // overlaps the requested range
    }
    cursor += MS_PER_DAY;
  }
  return false;
}

export function getNextTradingTime() {
  const { mins, day } = uaeTime();

  if (day === 0 || day === 6) {
    return 'Markets closed (weekend). Opens Monday 06:00 UAE';
  }

  if (mins < SESSION_START) {
    const remaining = SESSION_START - mins;
    const h = Math.floor(remaining / 60);
    const m = remaining % 60;
    return h > 0
      ? `${h}h ${m}m until session (06:00 UAE)`
      : `${m}m until session (06:00 UAE)`;
  }

  if (mins >= SESSION_END) {
    const nextDay = day === 5 ? 'Monday' : 'tomorrow';
    return `Markets closed. Opens ${nextDay} 06:00 UAE`;
  }

  return 'Currently in trading hours';
}
