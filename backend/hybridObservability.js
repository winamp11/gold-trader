// hybridObservability.js — pure helpers for the Release 1 decision journal.
//
// Nothing here influences a trading decision. These functions compute values
// that are RECORDED on every hybrid decision so that questions which are
// currently unanswerable from the database become answerable later:
//
//   - how old was the data this decision was made on?
//   - how close was this entry to one already open in the same direction?
//   - what counts as "today" for an entry count, in UAE terms?
//
// They live outside server.js because server.js starts a server on import,
// so anything in it can only be tested by regex-matching its source. These
// have real edge cases -- absent timestamps, missing ATR, an empty book --
// and edge cases deserve assertions, not a regex.
//
// Pure: no I/O, no module state, no randomness. The clock is always injected.

// Offset Twelve Data stamps its naive datetimes with for XAU/USD.
//
// getMarketDataBulk() sends no `timezone` parameter, so the API applies its
// own default -- UTC+10, not UTC. Confirmed against production on 2026-08-17:
// at 06:20:49Z the M5 bar was labelled "2026-08-17 16:15:00". Read as UTC that
// is an age of -35650s; read as UTC+10 it is 349s, which is what a 5-minute
// bar should be.
//
// Handled here, at the parse site, rather than by adding `timezone=UTC` to the
// request. That looks like the cleaner fix but it shifts H4 bar boundaries,
// which moves H4 RSI/ADX, which moves hybrid's rulebook bucket and mechanical's
// signal -- a live behaviour change. If the request is ever changed, delete
// this constant and the tests below will fail loudly, which is the point.
const API_NAIVE_DATETIME_OFFSET = '+10:00';

/**
 * Age in whole seconds of a source candle at `nowMs`.
 *
 * Returns null -- never 0 -- when the datetime is absent or unparseable. An
 * unknown age recorded as 0 would read as "perfectly fresh", which is the
 * exact inversion of the truth and the kind of value a freshness guard would
 * later trust. Null is honest and a guard can refuse on it.
 *
 * Twelve Data returns datetimes like "2026-08-17 16:15:00" with no timezone
 * designator. A naive value is read at API_NAIVE_DATETIME_OFFSET above; one
 * that already carries an offset is honoured as written.
 *
 * A negative age is returned as-is rather than clamped: it means the feed's
 * clock is genuinely ahead of ours, which is worth seeing in the data rather
 * than hiding. Note that an offset mistake shows up exactly this way -- a
 * column of large negative ages means the parse is wrong, not the feed.
 */
export function candleAgeSec(datetime, nowMs = Date.now()) {
  if (typeof datetime !== 'string' || datetime.trim() === '') return null;
  const trimmed = datetime.trim();
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const iso = hasZone
    ? trimmed.replace(' ', 'T')
    : `${trimmed.replace(' ', 'T')}${API_NAIVE_DATETIME_OFFSET}`;
  const ms = new Date(iso).getTime();
  if (!isFinite(ms)) return null;
  return Math.round((nowMs - ms) / 1000);
}

/**
 * Distance from `price` to the nearest OPEN same-direction entry, expressed in
 * H1 ATR units.
 *
 * This is the measurement that has to precede any entry-clustering rule: a
 * tolerance cannot be chosen from a distribution nobody has recorded. Nothing
 * enforces on it, and nothing should until there is enough of it to look at.
 *
 * ATR-normalised deliberately. $2 is a wide gap in quiet conditions and
 * nothing at all in volatile ones, so a dollar distance pooled across regimes
 * would produce a distribution that means nothing. When ATR is unavailable the
 * answer is null rather than a raw dollar figure -- a silently unnormalised
 * value mixed into the same column is worse than a missing one.
 *
 * Null when: no direction proposed (a NO_TRADE has nothing to be near), the
 * book is empty, nothing open shares the direction, or ATR is missing.
 */
export function nearestSameDirDistanceAtr(direction, price, openPositions, h1Atr) {
  // Number.isFinite, not the global isFinite, throughout. The global coerces
  // first, so isFinite(null) is true and a position with a null entryPrice
  // would be measured from 0 — yielding a distance of several hundred ATRs
  // that looks like a real, very isolated entry. Caught by the malformed-book
  // test below; the same trap applies to '' and to boolean values.
  if (direction !== 'LONG' && direction !== 'SHORT') return null;
  if (!Number.isFinite(price)) return null;
  if (!Number.isFinite(h1Atr) || h1Atr <= 0) return null;

  const distances = (openPositions ?? [])
    .filter(p => p && p.direction === direction && Number.isFinite(p.entryPrice))
    .map(p => Math.abs(price - p.entryPrice));

  if (distances.length === 0) return null;
  return Math.min(...distances) / h1Atr;
}

/**
 * Start of the UAE trading day `uaeDateStr` ('YYYY-MM-DD'), as a UTC ISO
 * string suitable for comparing against `trades.timestamp`, which is stored
 * in UTC.
 *
 * UAE is UTC+4 year-round with no DST, so 00:00 UAE is 20:00 UTC on the
 * previous calendar day. Getting this wrong in the obvious direction -- using
 * UTC midnight -- would count the 20:00-24:00 UTC block against the wrong
 * trading day, which is four hours of the NY session every day.
 */
export function uaeMidnightUtcIso(uaeDateStr) {
  const ms = new Date(`${uaeDateStr}T00:00:00Z`).getTime();
  if (!isFinite(ms)) throw new Error(`invalid UAE date: ${uaeDateStr}`);
  return new Date(ms - 4 * 3600000).toISOString();
}
