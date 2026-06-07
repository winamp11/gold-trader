// Trading hours: 06:00–21:00 UAE (Asia/Dubai = UTC+4, no DST), Monday–Friday.
// Hard close at 21:00 UAE — existing forceCloseAll mechanism fires at that edge.

// Dubai is UTC+4, no daylight saving time.
// Add 4 h to UTC epoch to read hours/minutes as UAE local time.
function uaeTime(ts) {
  const uaeDate = new Date((ts ? new Date(ts) : new Date()).getTime() + 4 * 60 * 60 * 1000);
  return {
    mins:    uaeDate.getUTCHours() * 60 + uaeDate.getUTCMinutes(),
    day:     uaeDate.getUTCDay(),    // 0=Sun 1=Mon … 6=Sat (in UAE time)
    uaeDate,
  };
}

const SESSION_START = 6  * 60;  //  06:00 UAE = 360 min
const SESSION_END   = 21 * 60;  //  21:00 UAE = 1260 min

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
