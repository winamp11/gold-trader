// Browser notifications for newly opened Overlay positions.
//
// The dashboard already polls /api/positions every 60s. This diffs consecutive
// polls and fires a Notification for positions that appeared since the last
// one — no service worker, no push subscription, no backend involvement.
//
// The diff is kept pure and separate from React so the two failure modes that
// matter can be tested directly:
//
//   1. Notifying for positions that were ALREADY open when the page loaded.
//      On open you would get a burst of alerts for trades from hours ago and
//      might act on a stale one. The first poll must prime the seen-set
//      silently, which means "no previous state" and "previous state was
//      empty" have to be different things — hence `seen === null` rather than
//      an empty Set.
//
//   2. Re-notifying the same position on every poll. Positions are matched on
//      the backend's stable `key` (portfolioId_signalId), not on price or
//      index, both of which change while a position is open.

export const NOTIFY_ACCOUNT = 'claude_overlay';

// Given the previously seen keys and the current positions, return the
// positions worth alerting on and the seen-set to carry forward.
//
// seen === null means "first poll of this page load" — prime, do not notify.
export function diffNewPositions(seen, positions, account = NOTIFY_ACCOUNT) {
  const mine = (positions ?? []).filter(p => p && p.portfolioName === account && p.key != null);
  const keys = new Set(mine.map(p => p.key));

  if (seen === null) return { fresh: [], seen: keys };

  const fresh = mine.filter(p => !seen.has(p.key));
  // Carry forward only what is currently open, so a key that closes and is
  // somehow reissued later is treated as new rather than suppressed forever.
  return { fresh, seen: keys };
}

const fmt = (n, dp = 2) => (n == null ? '—' : Number(n).toFixed(dp));

export function formatPosition(p) {
  const title = `${p.direction} · ${fmt(p.entryPrice)}`;
  const body = [
    `entry ${fmt(p.entryPrice)}`,
    `stop ${fmt(p.stopLoss)}`,
    `target ${fmt(p.target)}`,
    `${fmt(p.lots, 2)} lots`,
    p.tag ? `· ${p.tag}` : null,
  ].filter(Boolean).join('  ');
  return { title, body };
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permissionState() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;          // 'default' | 'granted' | 'denied'
}

export async function requestPermission() {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

// Fires one notification per position. Never throws: a notification failure
// must not break the dashboard render loop.
export function fireNotifications(fresh) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return 0;
  let sent = 0;
  for (const p of fresh) {
    try {
      const { title, body } = formatPosition(p);
      // `tag` replaces any existing notification with the same tag, so a
      // re-render cannot stack duplicates for one position.
      new Notification(`Overlay · ${title}`, { body, tag: `pos-${p.key}` });
      sent += 1;
    } catch {
      /* ignore — a blocked or failed notification is not worth breaking on */
    }
  }
  return sent;
}
