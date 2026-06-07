import React, { useState, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import './App.css';
import AutochartistCalculator from './AutochartistCalculator';

const API = process.env.REACT_APP_API_URL || '';

const C = {
  mech:    '#4d9de0',
  overlay: '#f0a030',
  solo:    '#48bb78',
  win:     '#22c55e',
  loss:    '#ef4444',
  veto:    '#a78bfa',
  obs:     '#6b7280',
};

const TRADE_PAGE    = 10;
const JOURNAL_LIMIT = 20;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usd(n, decimals = 2) {
  if (n == null) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (n < 0 ? '-' : '') + '$' + abs;
}

function pnlClass(n) {
  if (n == null || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

function pnlStr(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + usd(n);
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const day   = d.getDate();
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const time  = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${month} ${time}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const s = dateStr.length === 10 ? dateStr + 'T00:00:00Z' : dateStr;
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function sessionLabel(ts) {
  if (!ts) return '';
  const uae  = new Date(new Date(ts).getTime() + 4 * 3600 * 1000);
  const mins = uae.getUTCHours() * 60 + uae.getUTCMinutes();
  if (mins < 360)  return '';
  if (mins < 600)  return 'JP';
  if (mins < 660)  return 'JP-EUR';
  if (mins < 960)  return 'EUR';
  if (mins < 1140) return 'EUR-US';
  if (mins < 1260) return 'US';
  return '';
}

function accountColor(name) {
  if (name === 'mechanical')     return C.mech;
  if (name === 'claude_overlay') return C.overlay;
  if (name === 'claude_solo')    return C.solo;
  return '#888';
}

function accountLabel(name) {
  if (name === 'mechanical')     return 'Mechanical';
  if (name === 'claude_overlay') return 'Overlay';
  if (name === 'claude_solo')    return 'Solo';
  return name;
}

function entryTypeColor(t) {
  if (t === 'win')  return C.win;
  if (t === 'loss') return C.loss;
  if (t === 'veto') return C.veto;
  return C.obs;
}

function price(n) {
  if (n == null) return '—';
  return n.toFixed(2);
}

function dollarRisk(entry, stop, lots) {
  if (entry == null || stop == null || lots == null) return null;
  return Math.abs(entry - stop) * lots * 100;
}

function outcomeLabel(r) {
  if (r === 'TARGET_HIT')   return 'TARGET';
  if (r === 'STOP_HIT')     return 'STOP';
  if (r === 'NO_ENTRY')     return 'NO ENTRY';
  if (r === 'WINDOW_CLOSE') return 'CLOSED';
  if (r === 'EXPIRED')      return 'EXPIRED';
  return r ?? '—';
}

function outcomeClass(r) {
  if (r === 'TARGET_HIT') return 'outcome--win';
  if (r === 'STOP_HIT')   return 'outcome--loss';
  return 'outcome--neutral';
}

// ─── CollapsibleSection ───────────────────────────────────────────────────────

function CollapsibleSection({ label, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapse">
      <button className="collapse__btn" onClick={() => setOpen(v => !v)}>
        <span className="collapse__label">{label}</span>
        {count != null && count > 0 && (
          <span className="collapse__count">{count}</span>
        )}
        <span className="collapse__arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="collapse__body">{children}</div>}
    </div>
  );
}

// ─── OpenSection ─────────────────────────────────────────────────────────────

function OpenSection({ positions }) {
  if (!positions.length) {
    return <div className="section-empty">No open positions</div>;
  }
  return (
    <div className="open-list">
      {positions.map(p => {
        const risk = dollarRisk(p.entryPrice, p.stopLoss, p.lots);
        const sl   = sessionLabel(p.startTime);
        return (
          <div className="open-row" key={p.key}>
            <span className={`open-row__dir dir--${p.direction.toLowerCase()}`}>
              {p.direction === 'LONG' ? '↑' : '↓'} {p.direction}
            </span>
            <span className="open-row__field">
              {p.lots != null ? `${p.lots.toFixed(2)}L` : '—'}
            </span>
            <span className="open-row__field open-row__field--muted">
              {risk != null ? `$${risk.toFixed(0)}` : '—'}
            </span>
            <span className="open-row__field">
              {price(p.entryPrice)}
              {p.entryTriggered && p.currentPrice != null
                ? <> → {price(p.currentPrice)}</>
                : null}
            </span>
            {p.entryTriggered && p.unrealizedPnl != null
              ? <span className={`open-row__pnl ${pnlClass(p.unrealizedPnl)}`}>{pnlStr(p.unrealizedPnl)}</span>
              : <span className="open-row__pending">pending</span>
            }
            <span className="open-row__time">
              {fmtDateTime(p.startTime)}
              {sl && <span className="session-tag">{sl}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── HistorySection ───────────────────────────────────────────────────────────

function HistorySection({ trades, hasMore, onLoadMore }) {
  if (!trades.length) {
    return <div className="section-empty">No closed trades yet</div>;
  }
  return (
    <div className="history-list">
      {trades.map(t => {
        const risk = dollarRisk(t.entry_price, t.stop_loss, t.lot_size);
        const sl   = sessionLabel(t.exit_timestamp || t.timestamp);
        return (
          <div className="history-row" key={t.id}>
            <span className={`history-row__dir dir--${t.direction.toLowerCase()}`}>
              {t.direction === 'LONG' ? '↑' : '↓'} {t.direction}
            </span>
            <span className={`history-row__outcome ${outcomeClass(t.exit_reason)}`}>
              {outcomeLabel(t.exit_reason)}
            </span>
            <span className="history-row__prices">
              {price(t.entry_price)} → {price(t.exit_price)}
            </span>
            <span className="history-row__field">
              {t.lot_size != null ? `${t.lot_size.toFixed(2)}L` : '—'}
            </span>
            <span className="history-row__field history-row__field--muted">
              {risk != null ? `$${risk.toFixed(0)}` : '—'}
            </span>
            <span className={`history-row__pnl ${pnlClass(t.pnl)}`}>
              {pnlStr(t.pnl)}
            </span>
            <span className="history-row__time">
              {t.exit_timestamp
                ? <>{fmtDateTime(t.timestamp)} → {fmtTime(t.exit_timestamp)}</>
                : fmtDateTime(t.timestamp)
              }
              {sl && <span className="session-tag">{sl}</span>}
            </span>
          </div>
        );
      })}
      {hasMore && (
        <button className="show-more-btn" onClick={onLoadMore}>
          Show more
        </button>
      )}
    </div>
  );
}

// ─── JournalSection ───────────────────────────────────────────────────────────

function JournalSection({ entries }) {
  if (!entries.length) {
    return <div className="section-empty">No journal entries yet</div>;
  }
  return (
    <div className="journal-inner">
      {entries.map(e => {
        const sl = sessionLabel(e.timestamp);
        return (
          <div className="journal-row" key={e.id}>
            <div className="journal-row__meta">
              <span
                className="journal-row__type"
                style={{ color: entryTypeColor(e.entry_type) }}
              >
                {e.entry_type}
              </span>
              {e.tag && <span className="journal-row__tag">{e.tag}</span>}
              <span className="journal-row__time">
                {fmtDateTime(e.timestamp)}
                {sl && <span className="session-tag">{sl}</span>}
              </span>
            </div>
            <div className="journal-row__text">{e.lesson_text}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── AccountPanel ─────────────────────────────────────────────────────────────

function AccountPanel({ account, positions, trades, tradeHasMore, journal, onLoadMoreTrades }) {
  if (!account) return null;
  const color    = accountColor(account.name);
  const isMech   = account.name === 'mechanical';
  const myPos    = (positions || []).filter(p => p.portfolioName === account.name);
  const dailyPnl = account.daily_realized_pnl || 0;

  return (
    <div className="account-panel" style={{ '--accent': color }}>
      <div className="panel-headline">
        <div className="panel-headline__top">
          <span className="panel-headline__dot" />
          <span className="panel-headline__name">{accountLabel(account.name)}</span>
          {myPos.length > 0 && (
            <span className="panel-headline__open">{myPos.length} open</span>
          )}
        </div>
        <div className="panel-headline__balance">{usd(account.current_balance)}</div>
        <div className="panel-headline__row2">
          <span className={`panel-headline__daily ${pnlClass(dailyPnl)}`}>
            {pnlStr(dailyPnl)} today
          </span>
          <span className="panel-headline__stats">
            {account.closed_trades || 0} trades
            {account.win_rate != null ? ` · ${account.win_rate}% win` : ''}
          </span>
          {account.veto_stats && (
            <span className="panel-headline__veto">
              {account.veto_stats.veto_count} vetoes
            </span>
          )}
        </div>
      </div>

      <CollapsibleSection label="Open" count={myPos.length} defaultOpen={myPos.length > 0}>
        <OpenSection positions={myPos} />
      </CollapsibleSection>

      <CollapsibleSection label="History" count={account.closed_trades || 0}>
        <HistorySection
          trades={trades || []}
          hasMore={tradeHasMore}
          onLoadMore={onLoadMoreTrades}
        />
      </CollapsibleSection>

      <CollapsibleSection
        label="Journal"
        count={isMech ? null : (account.journal_count || 0)}
      >
        {isMech
          ? <div className="section-empty section-empty--italic">No journal — rule-based, does not reason</div>
          : <JournalSection entries={journal || []} />
        }
      </CollapsibleSection>
    </div>
  );
}

// ─── EquityChart ──────────────────────────────────────────────────────────────

function toChartData(equity) {
  if (!equity) return [];
  const allTs = new Set();
  for (const pts of Object.values(equity)) pts.forEach(p => allTs.add(p.t));
  const sorted = [...allTs].sort();
  const last = {};
  return sorted.map(t => {
    const row = { t };
    for (const [name, pts] of Object.entries(equity)) {
      const point = pts.find(p => p.t === t);
      if (point) last[name] = point.b;
      row[name] = last[name] ?? null;
    }
    return row;
  });
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label && (
        <div className="chart-tooltip__date">{fmtDate(label)}</div>
      )}
      {payload.map(p => (
        <div key={p.dataKey} className="chart-tooltip__row">
          <span style={{ color: p.color }}>{accountLabel(p.dataKey)}</span>
          <span>{usd(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

function EquityChart({ equity }) {
  const data = toChartData(equity);
  if (!data.length) return <div className="chart-empty">No equity data yet</div>;

  const allB = data.flatMap(r =>
    ['mechanical', 'claude_overlay', 'claude_solo'].map(k => r[k]).filter(Boolean)
  );
  const lo  = Math.min(...allB);
  const hi  = Math.max(...allB);
  const pad = Math.max(500, (hi - lo) * 0.1) || 1000;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          tickFormatter={fmtDate}
          tick={{ fontSize: 10, fill: '#4b6070', fontFamily: 'Space Mono, monospace' }}
          axisLine={false} tickLine={false} interval="preserveStartEnd"
        />
        <YAxis
          domain={[Math.floor(lo - pad), Math.ceil(hi + pad)]}
          tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'}
          tick={{ fontSize: 10, fill: '#4b6070', fontFamily: 'Space Mono, monospace' }}
          axisLine={false} tickLine={false} width={44}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          formatter={v => <span style={{ color: accountColor(v), fontSize: 11 }}>{accountLabel(v)}</span>}
          iconType="circle" iconSize={7}
        />
        <Line dataKey="mechanical"     stroke={C.mech}    strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: C.mech    }} connectNulls />
        <Line dataKey="claude_overlay" stroke={C.overlay} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: C.overlay }} connectNulls />
        <Line dataKey="claude_solo"    stroke={C.solo}    strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: C.solo    }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── TFRow ────────────────────────────────────────────────────────────────────

function TFRow({ label, tf }) {
  if (!tf) return null;
  const rsiColor  = tf.rsi > 65 ? C.loss : tf.rsi < 35 ? C.win : '#94a3b8';
  const macdColor = tf.macd > 0 ? C.win : C.loss;
  return (
    <div className="tf-row">
      <span className="tf-row__label">{label}</span>
      <span className="tf-row__val" style={{ color: rsiColor }}>RSI {tf.rsi?.toFixed(1) ?? '—'}</span>
      <span className="tf-row__val" style={{ color: macdColor }}>MACD {tf.macd?.toFixed(2) ?? '—'}</span>
      {tf.atr != null && <span className="tf-row__val tf-row__val--muted">ATR {tf.atr.toFixed(1)}</span>}
    </div>
  );
}

// ─── MissedList ───────────────────────────────────────────────────────────────

function MissedList({ missed }) {
  if (!missed?.length) return <div className="missed-empty">No missed-opportunity detail yet.</div>;
  return (
    <div className="missed-list">
      {missed.map(m => (
        <div className="missed-row" key={m.id}>
          <span className="missed-row__time">{fmtTime(m.timestamp)}</span>
          <span className="missed-row__badge">RED</span>
          <span
            className="missed-row__move"
            style={{ color: m.direction === 'UP' ? C.win : m.direction === 'DOWN' ? C.loss : '#888' }}
          >
            {m.direction === 'UP' ? '↑' : m.direction === 'DOWN' ? '↓' : ''}{' '}
            {m.direction ?? '?'}{m.movePts != null ? ` ${m.movePts.toFixed(1)} pts` : ''}
          </span>
          {m.outcomePrice != null && (
            <span className="missed-row__price">@ ${m.outcomePrice.toFixed(2)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── MarketPanel ──────────────────────────────────────────────────────────────

function MarketPanel({ snapshot, missed }) {
  const [showMissed, setShowMissed] = useState(false);
  if (!snapshot) return null;

  if (!snapshot.tradingHours) {
    return (
      <div className="market-closed">
        <div className="market-closed__icon">◉</div>
        <div className="market-closed__title">Market Closed</div>
        <div className="market-closed__sub">Trading window 16:30 – 20:30 UAE</div>
        {snapshot.nextTradingTime && (
          <div className="market-closed__next">Next session: {snapshot.nextTradingTime}</div>
        )}
        {snapshot.missedOpportunitiesToday > 0 && (
          <button
            className="market-closed__missed market-closed__missed--btn"
            onClick={() => setShowMissed(v => !v)}
          >
            {snapshot.missedOpportunitiesToday} missed opportunit{snapshot.missedOpportunitiesToday > 1 ? 'ies' : 'y'} today {showMissed ? '▲' : '▼'}
          </button>
        )}
        {showMissed && <MissedList missed={missed} />}
      </div>
    );
  }

  const sig  = snapshot.signal;
  const lcd  = snapshot.lastCycleDecisions;
  const px   = sig?.marketData?.h1?.price ?? sig?.marketData?.m30?.price;
  const allNoTrade = lcd &&
    lcd.mechanical.action === 'NO_TRADE' &&
    lcd.overlay.action    === 'NO_TRADE' &&
    lcd.solo.action       === 'NO_TRADE';

  return (
    <div className="market-panel">
      <div className="market-panel__price-row">
        {px != null && (
          <div className="market-panel__price">
            <span className="market-panel__price-label">XAU/USD</span>
            <span className="market-panel__price-val">${px.toFixed(2)}</span>
          </div>
        )}
        {sig && (
          <div className={`market-panel__badge ${sig.signal === 'GREEN' ? 'badge--green' : 'badge--red'}`}>
            {sig.signal === 'GREEN' ? '● TRADE' : '● NO TRADE'}
          </div>
        )}
        {snapshot.missedOpportunitiesToday > 0 && (
          <button
            className="market-panel__missed market-panel__missed--btn"
            onClick={() => setShowMissed(v => !v)}
          >
            {snapshot.missedOpportunitiesToday} missed today {showMissed ? '▲' : '▼'}
          </button>
        )}
      </div>

      {showMissed && <MissedList missed={missed} />}

      {sig?.marketData && (
        <div className="tf-grid">
          <TFRow label="H4"  tf={sig.marketData.h4}  />
          <TFRow label="H1"  tf={sig.marketData.h1}  />
          <TFRow label="M30" tf={sig.marketData.m30} />
          <TFRow label="M15" tf={sig.marketData.m15} />
          <TFRow label="M5"  tf={sig.marketData.m5}  />
        </div>
      )}

      {lcd && (
        <div className="why-flat">
          <div className="why-flat__title">
            {allNoTrade ? "Why nobody's trading" : 'Cycle decisions'}
          </div>
          {[
            { key: 'mechanical', label: 'Mechanical', color: C.mech    },
            { key: 'overlay',    label: 'Overlay',    color: C.overlay },
            { key: 'solo',       label: 'Solo',       color: C.solo    },
          ].map(({ key, label, color }) => {
            const d = lcd[key];
            if (!d) return null;
            return (
              <div className="why-flat__row" key={key}>
                <span className="why-flat__account" style={{ color }}>{label}</span>
                <span className={`why-flat__action action--${d.action.toLowerCase()}`}>{d.action}</span>
                {d.tag && <span className="why-flat__tag">{d.tag}</span>}
                {allNoTrade && d.reasoning && (
                  <span className="why-flat__reason">{d.reasoning}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!sig && !lcd && (
        <div className="panel-placeholder">Waiting for first cycle…</div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [showCalc,    setShowCalc]    = useState(false);
  const [accounts,    setAccounts]    = useState(null);
  const [equity,      setEquity]      = useState(null);
  const [positions,   setPositions]   = useState([]);
  const [snapshot,    setSnapshot]    = useState(null);
  const [missed,      setMissed]      = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error,       setError]       = useState(null);

  const [trades, setTrades] = useState({
    mechanical: [], claude_overlay: [], claude_solo: [],
  });
  const [tradeHasMore, setTradeHasMore] = useState({
    mechanical: false, claude_overlay: false, claude_solo: false,
  });
  const [tradeOffsets, setTradeOffsets] = useState({
    mechanical: 0, claude_overlay: 0, claude_solo: 0,
  });

  const [journal, setJournal] = useState({
    claude_overlay: [], claude_solo: [],
  });

  const fetchAll = useCallback(async () => {
    try {
      const [
        accRes, equityRes, posRes, snapRes, missedRes,
        mechTR, overlayTR, soloTR,
        overlayJR, soloJR,
      ] = await Promise.all([
        fetch(`${API}/api/accounts`),
        fetch(`${API}/api/equity`),
        fetch(`${API}/api/positions`),
        fetch(`${API}/api/market-snapshot`),
        fetch(`${API}/api/missed?limit=20`),
        fetch(`${API}/api/trades/recent?account=mechanical&limit=${TRADE_PAGE}`),
        fetch(`${API}/api/trades/recent?account=claude_overlay&limit=${TRADE_PAGE}`),
        fetch(`${API}/api/trades/recent?account=claude_solo&limit=${TRADE_PAGE}`),
        fetch(`${API}/api/journal?account=claude_overlay&limit=${JOURNAL_LIMIT}`),
        fetch(`${API}/api/journal?account=claude_solo&limit=${JOURNAL_LIMIT}`),
      ]);

      const [
        accData, equityData, posData, snapData, missedData,
        mechTD, overlayTD, soloTD,
        overlayJD, soloJD,
      ] = await Promise.all([
        accRes.json(), equityRes.json(), posRes.json(), snapRes.json(), missedRes.json(),
        mechTR.json(), overlayTR.json(), soloTR.json(),
        overlayJR.json(), soloJR.json(),
      ]);

      setAccounts(accData.accounts || []);
      setEquity(equityData.equity || null);
      setPositions(posData.positions || []);
      setSnapshot(snapData);
      setMissed(missedData.missed || []);

      const mt = mechTD.trades    || [];
      const ot = overlayTD.trades || [];
      const st = soloTD.trades    || [];
      setTrades({ mechanical: mt, claude_overlay: ot, claude_solo: st });
      setTradeOffsets({ mechanical: 0, claude_overlay: 0, claude_solo: 0 });
      setTradeHasMore({
        mechanical:     mt.length >= TRADE_PAGE,
        claude_overlay: ot.length >= TRADE_PAGE,
        claude_solo:    st.length >= TRADE_PAGE,
      });

      setJournal({
        claude_overlay: overlayJD.entries || [],
        claude_solo:    soloJD.entries    || [],
      });

      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError('Could not reach backend');
    }
  }, []);

  const loadMoreTrades = useCallback(async (accountName) => {
    const newOffset = (tradeOffsets[accountName] || 0) + TRADE_PAGE;
    try {
      const res  = await fetch(`${API}/api/trades/recent?account=${accountName}&limit=${TRADE_PAGE}&offset=${newOffset}`);
      const data = await res.json();
      const more = data.trades || [];
      setTrades(prev => ({ ...prev, [accountName]: [...prev[accountName], ...more] }));
      setTradeOffsets(prev => ({ ...prev, [accountName]: newOffset }));
      setTradeHasMore(prev => ({ ...prev, [accountName]: more.length >= TRADE_PAGE }));
    } catch {}
  }, [tradeOffsets]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 60_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  if (showCalc) {
    return <AutochartistCalculator onBack={() => setShowCalc(false)} />;
  }

  const mech    = accounts?.find(a => a.name === 'mechanical');
  const overlay = accounts?.find(a => a.name === 'claude_overlay');
  const solo    = accounts?.find(a => a.name === 'claude_solo');
  const sessionNow  = sessionLabel(new Date().toISOString());
  const isTradingNow = snapshot?.tradingHours ?? false;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__icon">◈</span>
          <span className="topbar__title">GOLD TRADER</span>
          <span className="topbar__sub">XAU/USD · paper</span>
        </div>
        <div className="topbar__right">
          <span className={`topbar__session${isTradingNow ? ' topbar__session--live' : ''}`}>
            {sessionNow}
            {isTradingNow && <span className="topbar__live-dot" />}
          </span>
          {lastUpdated && (
            <span className="topbar__updated">updated {fmtTime(lastUpdated)}</span>
          )}
          {error && <span className="topbar__error">{error}</span>}
          <button className="topbar__btn" onClick={() => setShowCalc(true)}>
            Autochartist ↗
          </button>
        </div>
      </header>

      <main className="main">
        <div className="chart-card">
          <EquityChart equity={equity} />
        </div>

        <AccountPanel
          account={mech}
          positions={positions}
          trades={trades.mechanical}
          tradeHasMore={tradeHasMore.mechanical}
          journal={[]}
          onLoadMoreTrades={() => loadMoreTrades('mechanical')}
        />
        <AccountPanel
          account={overlay}
          positions={positions}
          trades={trades.claude_overlay}
          tradeHasMore={tradeHasMore.claude_overlay}
          journal={journal.claude_overlay}
          onLoadMoreTrades={() => loadMoreTrades('claude_overlay')}
        />
        <AccountPanel
          account={solo}
          positions={positions}
          trades={trades.claude_solo}
          tradeHasMore={tradeHasMore.claude_solo}
          journal={journal.claude_solo}
          onLoadMoreTrades={() => loadMoreTrades('claude_solo')}
        />

        <MarketPanel snapshot={snapshot} missed={missed} />
      </main>
    </div>
  );
}
