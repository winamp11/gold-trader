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

// ── Mute preference ──────────────────────────────────────────────────────
//
// Browser permission is one-way: once granted, it can only be revoked through
// Chrome's site settings. That is far too buried to be the only off switch,
// so the app keeps its own mute flag alongside it.
//
// Stored rather than held in state so it survives a reload — otherwise every
// refresh silently un-mutes. Reads and writes are guarded: localStorage throws
// outright in some privacy modes, and a storage failure must never stop the
// dashboard rendering.

const MUTE_KEY = 'goldtrader.alerts.muted';

export function isMuted() {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;                 // unreadable storage → default to alerting
  }
}

export function setMuted(muted) {
  try {
    if (muted) window.localStorage.setItem(MUTE_KEY, '1');
    else       window.localStorage.removeItem(MUTE_KEY);
  } catch {
    /* preference simply will not persist; the in-memory state still applies */
  }
  return muted;
}

// The single source of truth for what the toggle shows and does next.
// Kept pure so every state transition is testable without a browser.
//
// 'unsupported' — no Notification API; render nothing
// 'denied'      — blocked at browser level; only Chrome settings can undo it
// 'default'     — never asked; tapping requests permission
// 'on'          — granted and alerting; tapping mutes
// 'muted'       — granted but silenced in-app; tapping unmutes
export function toggleState(permission, muted) {
  if (permission === 'unsupported') return 'unsupported';
  if (permission === 'denied')      return 'denied';
  if (permission !== 'granted')     return 'default';
  return muted ? 'muted' : 'on';
}

export const TOGGLE_LABEL = {
  default: '🔔 alerts off',
  on:      '🔔 alerts on',
  muted:   '🔕 muted',
  denied:  '🔕 blocked',
};

export const TOGGLE_TITLE = {
  default: 'Alert when Overlay opens a position',
  on:      'Alerting on new Overlay positions — tap to mute',
  muted:   'Alerts muted — tap to resume',
  denied:  'Blocked — re-enable notifications for this site in Chrome settings',
};

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
//
// The mute check lives here rather than at the call site so muting cannot be
// bypassed by a caller that forgets to check — the diff still runs and the
// seen-set still advances while muted, so unmuting does not then replay every
// position opened in the meantime.
export function fireNotifications(fresh) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return 0;
  if (isMuted()) return 0;
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
