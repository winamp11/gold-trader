import React, { useState, useEffect, useCallback } from 'react';
import './AnalystDashboard.css';

const API = process.env.REACT_APP_API_URL || '';

const C = {
  mech:    '#4d9de0',
  overlay: '#f0a030',
  solo:    '#48bb78',
};

function accountColor(name) {
  if (name === 'mechanical')     return C.mech;
  if (name === 'claude_overlay') return C.overlay;
  if (name === 'claude_solo')    return C.solo;
  return '#888';
}

function accountShort(name) {
  if (name === 'claude_overlay') return 'OVERLAY';
  if (name === 'claude_solo')    return 'SOLO';
  if (name === 'mechanical')     return 'MECH';
  return name.toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function usd(n) {
  if (n == null) return '—';
  const abs = Math.abs(n).toFixed(0);
  return (n < 0 ? '-' : '+') + '$' + abs;
}

function pct(n) {
  if (n == null) return '—';
  return (n * 100).toFixed(0) + '%';
}

function winRateColor(wr) {
  if (wr == null) return '#4b6070';
  if (wr >= 0.7)  return '#22c55e';
  if (wr >= 0.5)  return '#fb923c';
  return '#ef4444';
}

function confClass(c) {
  if (c === 'sufficient')   return 'conf--sufficient';
  if (c === 'early')        return 'conf--early';
  return 'conf--insufficient';
}

function adxClass(bucket) {
  if (bucket === 'strong')  return 'adx--strong';
  if (bucket === 'trend')   return 'adx--trend';
  if (bucket === 'mild')    return 'adx--mild';
  return 'adx--chop';
}

// ── WinRateBar ────────────────────────────────────────────────────────────────

function WinRateBar({ wr, n }) {
  const color = winRateColor(wr);
  return (
    <div className="wr-wrap">
      <div className="wr-bar">
        <div
          className="wr-bar__fill"
          style={{ width: `${Math.round((wr ?? 0) * 100)}%`, background: color }}
        />
      </div>
      <span className="wr-label" style={{ color }}>{pct(wr)}</span>
      <span style={{ color: '#4b6070', fontSize: 10 }}>/{n}</span>
    </div>
  );
}

// ── ExpectancyCell ────────────────────────────────────────────────────────────

function ExpCell({ val }) {
  if (val == null) return <span className="exp--null">n/a</span>;
  const cls = val >= 0 ? 'exp--pos' : 'exp--neg';
  return <span className={cls}>{usd(val)}</span>;
}

// ── Rulebook row ──────────────────────────────────────────────────────────────

function RulebookRow({ row }) {
  const color = accountColor(row.account_name);
  return (
    <tr>
      <td>
        <div className="rt__account">
          <span className="rt__dot" style={{ background: color }} />
          <span style={{ color, fontSize: 9, letterSpacing: '0.08em' }}>{accountShort(row.account_name)}</span>
        </div>
      </td>
      <td><span className="rt__tag">{row.tag}</span></td>
      <td><span className={`conf-badge ${confClass(row.sample_confidence)}`}>{row.sample_confidence}</span></td>
      <td><WinRateBar wr={row.win_rate} n={row.n_total} /></td>
      <td><ExpCell val={row.expectancy} /></td>
      <td>
        <span className={`adx-chip ${adxClass(row.dominant_adx_bucket)}`}>
          {row.dominant_adx_bucket ?? '—'}
          {row.avg_h4_adx != null ? ` ${Math.round(row.avg_h4_adx)}` : ''}
        </span>
      </td>
      <td>
        {row.dominant_session
          ? <span className="sess-chip">{row.dominant_session}</span>
          : <span style={{ color: '#4b6070' }}>—</span>}
      </td>
      <td>
        {row.short_n > 0 && (
          <span style={{ color: '#ef4444', fontSize: 10 }}>
            S {pct(row.short_win_rate)}({row.short_n})
          </span>
        )}
        {row.short_n > 0 && row.long_n > 0 && <span style={{ color: '#4b6070' }}> · </span>}
        {row.long_n > 0 && (
          <span style={{ color: '#22c55e', fontSize: 10 }}>
            L {pct(row.long_win_rate)}({row.long_n})
          </span>
        )}
      </td>
      <td>
        <span className={row.recency_flag === 'active' ? 'recency--active' : 'recency--stale'}>
          {row.recency_flag === 'active' ? '● active' : '○ stale'}
        </span>
      </td>
    </tr>
  );
}

// ── Pinned lessons ────────────────────────────────────────────────────────────

function PinnedCol({ label, color, pins }) {
  return (
    <div className="pin-col">
      <div className="pin-col__label" style={{ color }}>{label}</div>
      {pins.length === 0
        ? <div className="pin-empty">No pins yet — fires after a tag accumulates 2+ losses</div>
        : pins.map(p => (
            <div className="pin-item" key={p.id}>
              <div className="pin-item__tag">
                <span>{p.tag}</span>
                <span className="pin-item__losses">{p.tag_loss_count} losses</span>
              </div>
              <div className="pin-item__text">{p.lesson_text}</div>
            </div>
          ))
      }
    </div>
  );
}

// ── Combinations ──────────────────────────────────────────────────────────────

function CombinationRow({ row }) {
  const color = accountColor(row.account_name);
  const wrColor = winRateColor(row.win_rate);
  return (
    <div className="combo-row">
      <span className="combo-row__account" style={{ color, fontSize: 9, letterSpacing: '0.08em' }}>
        {accountShort(row.account_name)}
      </span>
      <span className={`combo-row__dir ${row.direction === 'SHORT' ? 'dir--short' : 'dir--long'}`}>
        {row.direction === 'SHORT' ? '↓' : '↑'} {row.direction}
      </span>
      <div className="combo-row__tags">
        <span className={`adx-chip ${adxClass(row.adx_bucket)}`}>{row.adx_bucket}</span>
        <span className="adx-chip">RSI {row.h4_rsi_bucket}</span>
        {row.session && row.session !== 'unknown' && (
          <span className="sess-chip">{row.session}</span>
        )}
      </div>
      <span className="combo-row__wr" style={{ color: wrColor }}>{pct(row.win_rate)}</span>
      <span className="combo-row__n">/{row.n_total}</span>
      <span className="combo-row__exp"><ExpCell val={row.expectancy} /></span>
    </div>
  );
}

// ── Cross-account patterns ────────────────────────────────────────────────────

function CrossAccountSection({ rulebook }) {
  const byTag = {};
  for (const r of rulebook) {
    if (!byTag[r.tag]) byTag[r.tag] = {};
    byTag[r.tag][r.account_name] = r;
  }
  const crossTags = Object.entries(byTag).filter(([, accts]) =>
    accts['claude_overlay'] && accts['claude_solo']
  );
  if (crossTags.length === 0) {
    return <div className="analyst-empty">No cross-account patterns yet — both accounts need trades with the same tag</div>;
  }
  return (
    <>
      {crossTags.map(([tag, accts]) => {
        const s = accts['claude_solo'];
        const o = accts['claude_overlay'];
        const agree = (s.win_rate >= 0.5) === (o.win_rate >= 0.5);
        return (
          <div className="cross-row" key={tag}>
            <div className="cross-row__tag">{tag}</div>
            <div className="cross-row__accounts">
              <div className="cross-row__account-item">
                <span style={{ color: C.solo, fontSize: 9 }}>SOLO</span>
                <span style={{ color: winRateColor(s.win_rate), fontSize: 11, fontFamily: 'Space Mono, monospace', fontWeight: 700 }}>
                  {pct(s.win_rate)}
                </span>
                <span style={{ color: '#4b6070', fontSize: 10 }}>/{s.n_total}</span>
              </div>
              <div className="cross-row__account-item">
                <span style={{ color: C.overlay, fontSize: 9 }}>OVERLAY</span>
                <span style={{ color: winRateColor(o.win_rate), fontSize: 11, fontFamily: 'Space Mono, monospace', fontWeight: 700 }}>
                  {pct(o.win_rate)}
                </span>
                <span style={{ color: '#4b6070', fontSize: 10 }}>/{o.n_total}</span>
              </div>
              <span className={agree ? 'cross-agree' : 'cross-disagree'}>
                {agree ? '● AGREE' : '◐ DISAGREE'}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalystDashboard({ onBack }) {
  const [rulebook,    setRulebook]    = useState(null);
  const [pins,        setPins]        = useState([]);
  const [filter,      setFilter]      = useState('all');
  const [running,     setRunning]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error,       setError]       = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [rbRes, pinRes] = await Promise.all([
        fetch(`${API}/api/analyst/rulebook`),
        fetch(`${API}/api/pinned-lessons`),
      ]);
      const [rbData, pinData] = await Promise.all([rbRes.json(), pinRes.json()]);
      setRulebook(rbData);
      setPins(pinData.pinned || []);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError('Could not reach backend');
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const runAnalysis = async () => {
    setRunning(true);
    try {
      await fetch(`${API}/api/analyst/run`, { method: 'POST' });
      await fetchData();
    } catch {
      setError('Run failed');
    } finally {
      setRunning(false);
    }
  };

  const summary = rulebook?.summary;
  const allRows = rulebook?.rulebook || [];
  const combos  = rulebook?.combinations || [];

  const filteredRows = allRows.filter(r => {
    if (filter === 'solo')       return r.account_name === 'claude_solo';
    if (filter === 'overlay')    return r.account_name === 'claude_overlay';
    if (filter === 'sufficient') return r.sample_confidence === 'sufficient';
    if (filter === 'early')      return r.sample_confidence === 'early';
    return true;
  });

  const soloPins    = pins.filter(p => p.portfolio_id === 3 && p.active);
  const overlayPins = pins.filter(p => p.portfolio_id === 2 && p.active);

  return (
    <div className="analyst-page">
      <header className="analyst-header">
        <div className="analyst-header__left">
          <button className="analyst-btn" onClick={onBack}>← Back</button>
          <span className="analyst-header__title">ANALYST</span>
          <span className="analyst-header__sub">Pattern intelligence · {allRows.length} patterns</span>
        </div>
        <div className="analyst-header__right">
          {lastUpdated && (
            <span className="analyst-header__updated">
              updated {fmtTime(lastUpdated)}
            </span>
          )}
          {error && <span style={{ color: '#ef4444', fontSize: 11, fontFamily: 'Space Mono' }}>{error}</span>}
          <button
            className="analyst-btn analyst-btn--run"
            onClick={runAnalysis}
            disabled={running}
          >
            {running ? 'Running…' : '▶ Run now'}
          </button>
        </div>
      </header>

      <main className="analyst-main">

        {/* Summary bar */}
        <div className="analyst-summary">
          <div className="summary-card">
            <div className="summary-card__label">Total patterns</div>
            <div className="summary-card__val">{summary?.total_patterns ?? '—'}</div>
            <div className="summary-card__sub">{summary?.sufficient_patterns ?? 0} sufficient</div>
          </div>
          <div className="summary-card">
            <div className="summary-card__label">Top win rate</div>
            <div className="summary-card__val" style={{ color: '#22c55e' }}>
              {summary?.top_win_rate ? pct(summary.top_win_rate.win_rate) : '—'}
            </div>
            <div className="summary-card__sub">
              {summary?.top_win_rate
                ? `${summary.top_win_rate.tag} · ${summary.top_win_rate.n_total} trades`
                : 'no data'}
            </div>
          </div>
          <div className="summary-card">
            <div className="summary-card__label">Best expectancy</div>
            <div className="summary-card__val" style={{ color: summary?.highest_expectancy?.expectancy >= 0 ? '#22c55e' : '#ef4444' }}>
              {summary?.highest_expectancy ? usd(summary.highest_expectancy.expectancy) : '—'}
            </div>
            <div className="summary-card__sub">
              {summary?.highest_expectancy
                ? `${summary.highest_expectancy.tag}`
                : 'needs wins + losses'}
            </div>
          </div>
          <div className="summary-card">
            <div className="summary-card__label">Pins active</div>
            <div className="summary-card__val">{pins.filter(p => p.active).length}</div>
            <div className="summary-card__sub">
              solo {soloPins.length} · overlay {overlayPins.length}
            </div>
          </div>
        </div>

        {/* Pinned lessons */}
        <div className="analyst-card">
          <div className="analyst-card__header">
            <span className="analyst-card__title">Pinned lessons</span>
            <span className="analyst-card__count">{pins.filter(p => p.active).length} active</span>
          </div>
          <div className="pins-grid">
            <PinnedCol label="Solo" color={C.solo} pins={soloPins} />
            <PinnedCol label="Overlay" color={C.overlay} pins={overlayPins} />
          </div>
        </div>

        {/* Rulebook */}
        <div className="analyst-card">
          <div className="analyst-card__header">
            <span className="analyst-card__title">Rulebook</span>
            <span className="analyst-card__count">{filteredRows.length} patterns</span>
          </div>
          <div className="analyst-filters">
            {['all', 'solo', 'overlay', 'sufficient', 'early'].map(f => (
              <button
                key={f}
                className={`filter-tab ${filter === f ? 'filter-tab--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {filteredRows.length === 0
            ? <div className="analyst-empty">No patterns match this filter</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table className="rulebook-table">
                  <thead>
                    <tr>
                      <th>Acct</th>
                      <th>Pattern tag</th>
                      <th>Confidence</th>
                      <th>Win rate</th>
                      <th>Expectancy</th>
                      <th>ADX</th>
                      <th>Session</th>
                      <th>Direction split</th>
                      <th>Recency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(row => (
                      <RulebookRow key={`${row.portfolio_id}-${row.tag}`} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </div>

        {/* Cross-account patterns */}
        <div className="analyst-card">
          <div className="analyst-card__header">
            <span className="analyst-card__title">Cross-account patterns</span>
            <span className="analyst-card__count">same tag, both accounts</span>
          </div>
          <CrossAccountSection rulebook={allRows} />
        </div>

        {/* Combinations */}
        <div className="analyst-card">
          <div className="analyst-card__header">
            <span className="analyst-card__title">Condition combinations</span>
            <span className="analyst-card__count">n≥3</span>
          </div>
          {combos.length === 0
            ? <div className="analyst-empty">Combinations appear when a direction+ADX+RSI+session combo has 3+ trades</div>
            : combos.map((c, i) => <CombinationRow key={i} row={c} />)
          }
        </div>

      </main>
    </div>
  );
}
