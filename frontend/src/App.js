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

// ─── helpers ────────────────────────────────────────────────────────────────

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
  return new Date(ts).toLocaleString('en-GB', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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

// ─── AccountCard ─────────────────────────────────────────────────────────────

function AccountCard({ account }) {
  if (!account) return null;
  const color = accountColor(account.name);
  const label = accountLabel(account.name);
  const dailyPnl = account.daily_realized_pnl || 0;
  const hasWinRate = account.closed_trades > 0;
  const winRate = hasWinRate
    ? `${account.win_rate}% win rate`
    : '—';
  const tradesStat = `${account.closed_trades} trade${account.closed_trades !== 1 ? 's' : ''} · ${winRate}`;

  return (
    <div className="account-card" style={{ '--accent': color }}>
      <div className="account-card__header">
        <span className="account-card__dot" />
        <span className="account-card__label">{label}</span>
        {account.open_positions > 0 && (
          <span className="account-card__open">{account.open_positions} open</span>
        )}
      </div>

      <div className="account-card__balance">{usd(account.current_balance, 2)}</div>

      <div className={`account-card__daily ${pnlClass(dailyPnl)}`}>
        {pnlStr(dailyPnl)} today
      </div>

      <div className="account-card__stats">{tradesStat}</div>

      {account.veto_stats && (
        <div className="account-card__veto">
          {account.veto_stats.veto_count} vetoes
          {account.veto_stats.correctly_avoided != null
            ? ` · ${account.veto_stats.correctly_avoided} avoided`
            : ''}
        </div>
      )}
    </div>
  );
}

// ─── EquityChart ──────────────────────────────────────────────────────────────

function toChartData(equity) {
  if (!equity) return [];
  // Merge all timestamps from all portfolios into one sorted timeline
  const allTs = new Set();
  for (const pts of Object.values(equity)) {
    pts.forEach(p => allTs.add(p.t));
  }
  const sorted = [...allTs].sort();

  // For each timestamp, carry-forward the last known balance per account
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
      <div className="chart-tooltip__time">{fmtTime(label)}</div>
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
  if (!data.length) return <div className="chart-empty">No data yet</div>;

  const allBalances = data.flatMap(r =>
    ['mechanical', 'claude_overlay', 'claude_solo'].map(k => r[k]).filter(Boolean)
  );
  const lo = Math.min(...allBalances);
  const hi = Math.max(...allBalances);
  const pad = Math.max(500, (hi - lo) * 0.1) || 1000;
  const domain = [Math.floor(lo - pad), Math.ceil(hi + pad)];

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          tickFormatter={fmtTime}
          tick={{ fontSize: 10, fill: '#4b6070', fontFamily: 'Space Mono, monospace' }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={domain}
          tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'}
          tick={{ fontSize: 10, fill: '#4b6070', fontFamily: 'Space Mono, monospace' }}
          axisLine={false}
          tickLine={false}
          width={44}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          formatter={v => <span style={{ color: accountColor(v), fontSize: 11 }}>{accountLabel(v)}</span>}
          iconType="circle"
          iconSize={7}
        />
        <Line dataKey="mechanical"     stroke={C.mech}    strokeWidth={2} dot={false} connectNulls />
        <Line dataKey="claude_overlay" stroke={C.overlay} strokeWidth={2} dot={false} connectNulls />
        <Line dataKey="claude_solo"    stroke={C.solo}    strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── TFRow — one timeframe row ────────────────────────────────────────────────

function TFRow({ label, tf }) {
  if (!tf) return null;
  const rsiColor = tf.rsi > 65 ? C.loss : tf.rsi < 35 ? C.win : '#94a3b8';
  const macdColor = tf.macd > 0 ? C.win : C.loss;
  return (
    <div className="tf-row">
      <span className="tf-row__label">{label}</span>
      <span className="tf-row__val" style={{ color: rsiColor }}>
        RSI {tf.rsi != null ? tf.rsi.toFixed(1) : '—'}
      </span>
      <span className="tf-row__val" style={{ color: macdColor }}>
        MACD {tf.macd != null ? tf.macd.toFixed(2) : '—'}
      </span>
      {tf.atr != null && (
        <span className="tf-row__val tf-row__val--muted">ATR {tf.atr.toFixed(1)}</span>
      )}
    </div>
  );
}

// ─── MarketPanel ──────────────────────────────────────────────────────────────

function MarketPanel({ snapshot }) {
  if (!snapshot) return <div className="panel-placeholder">Loading market data…</div>;

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
          <div className="market-closed__missed">
            {snapshot.missedOpportunitiesToday} missed opportunit{snapshot.missedOpportunitiesToday > 1 ? 'ies' : 'y'} today
          </div>
        )}
      </div>
    );
  }

  const sig     = snapshot.signal;
  const lcd     = snapshot.lastCycleDecisions;
  const price   = sig?.marketData?.h1?.price ?? sig?.marketData?.m30?.price;
  const allNoTrade = lcd &&
    lcd.mechanical.action === 'NO_TRADE' &&
    lcd.overlay.action    === 'NO_TRADE' &&
    lcd.solo.action       === 'NO_TRADE';

  return (
    <div className="market-panel">
      {/* Price + signal state */}
      <div className="market-panel__price-row">
        {price != null && (
          <div className="market-panel__price">
            <span className="market-panel__price-label">XAU/USD</span>
            <span className="market-panel__price-val">${price.toFixed(2)}</span>
          </div>
        )}
        {sig && (
          <div className={`market-panel__badge ${sig.signal === 'GREEN' ? 'badge--green' : 'badge--red'}`}>
            {sig.signal === 'GREEN' ? '● TRADE' : '● NO TRADE'}
          </div>
        )}
        {snapshot.missedOpportunitiesToday > 0 && (
          <div className="market-panel__missed">
            {snapshot.missedOpportunitiesToday} missed today
          </div>
        )}
      </div>

      {/* 5-timeframe grid */}
      {sig?.marketData && (
        <div className="tf-grid">
          <TFRow label="H4"  tf={sig.marketData.h4}  />
          <TFRow label="H1"  tf={sig.marketData.h1}  />
          <TFRow label="M30" tf={sig.marketData.m30} />
          <TFRow label="M15" tf={sig.marketData.m15} />
          <TFRow label="M5"  tf={sig.marketData.m5}  />
        </div>
      )}

      {/* Why-flat / decisions */}
      {allNoTrade && lcd && (
        <div className="why-flat">
          <div className="why-flat__title">Why nobody's trading</div>
          {[
            { key: 'mechanical', label: 'Mechanical',     color: C.mech },
            { key: 'overlay',    label: 'Overlay',        color: C.overlay },
            { key: 'solo',       label: 'Solo',           color: C.solo },
          ].map(({ key, label, color }) => {
            const d = lcd[key];
            if (!d) return null;
            return (
              <div className="why-flat__row" key={key}>
                <span className="why-flat__account" style={{ color }}>{label}</span>
                {d.tag && <span className="why-flat__tag">{d.tag}</span>}
                <span className="why-flat__reason">{d.reasoning || '—'}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* If there IS a trade, show the active setup summary */}
      {!allNoTrade && lcd && (
        <div className="why-flat">
          <div className="why-flat__title">Cycle decisions</div>
          {[
            { key: 'mechanical', label: 'Mechanical',     color: C.mech },
            { key: 'overlay',    label: 'Overlay',        color: C.overlay },
            { key: 'solo',       label: 'Solo',           color: C.solo },
          ].map(({ key, label, color }) => {
            const d = lcd[key];
            if (!d) return null;
            return (
              <div className="why-flat__row" key={key}>
                <span className="why-flat__account" style={{ color }}>{label}</span>
                <span className={`why-flat__action action--${d.action.toLowerCase()}`}>{d.action}</span>
                {d.tag && <span className="why-flat__tag">{d.tag}</span>}
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

// ─── JournalPanel ─────────────────────────────────────────────────────────────

function JournalPanel({ entries }) {
  if (!entries?.length) {
    return <div className="panel-placeholder">No journal entries yet — learning begins after the first closed trade.</div>;
  }
  return (
    <div className="journal-list">
      {entries.map(e => (
        <div className="journal-entry" key={e.id}>
          <div className="journal-entry__meta">
            <span
              className="journal-entry__type"
              style={{ color: entryTypeColor(e.entry_type) }}
            >
              {e.entry_type}
            </span>
            <span
              className="journal-entry__account"
              style={{ color: accountColor(e.portfolio_name) }}
            >
              {accountLabel(e.portfolio_name)}
            </span>
            <span className="journal-entry__time">{fmtDateTime(e.timestamp)}</span>
            {e.tag && <span className="journal-entry__tag">{e.tag}</span>}
          </div>
          <div className="journal-entry__text">{e.lesson_text}</div>
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [showCalc, setShowCalc]       = useState(false);
  const [accounts, setAccounts]       = useState(null);
  const [snapshot, setSnapshot]       = useState(null);
  const [journal, setJournal]         = useState(null);
  const [equity, setEquity]           = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError]             = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [accRes, snapRes, journalRes, equityRes] = await Promise.all([
        fetch(`${API}/api/accounts`),
        fetch(`${API}/api/market-snapshot`),
        fetch(`${API}/api/journal?limit=20`),
        fetch(`${API}/api/equity`),
      ]);
      const [accData, snapData, journalData, equityData] = await Promise.all([
        accRes.json(), snapRes.json(), journalRes.json(), equityRes.json(),
      ]);
      setAccounts(accData.accounts  || []);
      setSnapshot(snapData);
      setJournal(journalData.entries || []);
      setEquity(equityData.equity    || null);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError('Could not reach backend');
    }
  }, []);

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

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__icon">◈</span>
          <span className="topbar__title">GOLD TRADER</span>
          <span className="topbar__sub">XAU/USD · paper</span>
        </div>
        <div className="topbar__right">
          {lastUpdated && (
            <span className="topbar__updated">
              updated {fmtTime(lastUpdated)}
            </span>
          )}
          {error && <span className="topbar__error">{error}</span>}
          <button className="topbar__btn" onClick={() => setShowCalc(true)}>
            Autochartist ↗
          </button>
        </div>
      </header>

      <main className="main">

        {/* ── Scoreboard ── */}
        <section className="section">
          <h2 className="section__title">Accounts</h2>
          <div className="scoreboard">
            <AccountCard account={mech}    />
            <AccountCard account={overlay} />
            <AccountCard account={solo}    />
          </div>
        </section>

        {/* ── Equity curves ── */}
        <section className="section">
          <h2 className="section__title">Equity Curves</h2>
          <div className="chart-card">
            <EquityChart equity={equity} />
          </div>
        </section>

        {/* ── Market read ── */}
        <section className="section">
          <h2 className="section__title">Market Read</h2>
          <MarketPanel snapshot={snapshot} />
        </section>

        {/* ── Journal ── */}
        <section className="section">
          <h2 className="section__title">Journal</h2>
          <JournalPanel entries={journal} />
        </section>

      </main>
    </div>
  );
}
