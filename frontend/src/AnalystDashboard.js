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

function pts(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1);
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

// ── Mechanical rulebook ───────────────────────────────────────────────────────

function MechRulebookSection({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="analyst-empty">No mechanical rulebook data yet — run analysis first</div>;
  }

  const sorted = [...rows].sort((a, b) => {
    const confOrder = { sufficient: 0, early: 1, insufficient: 2 };
    const cDiff = (confOrder[a.sample_confidence] ?? 2) - (confOrder[b.sample_confidence] ?? 2);
    return cDiff !== 0 ? cDiff : b.n_total - a.n_total;
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="rulebook-table">
        <thead>
          <tr>
            <th>Dir</th>
            <th>ADX</th>
            <th>RSI</th>
            <th>MACD bias</th>
            <th>Session</th>
            <th>Win rate</th>
            <th>Expectancy</th>
            <th>Avg H4 ADX</th>
            <th>Avg H1 RSI</th>
            <th>Stop ATR×</th>
            <th>Exit split</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const expVal = r.expectancy;
            return (
              <tr key={i}>
                <td>
                  <span className={r.direction === 'SHORT' ? 'dir--short' : 'dir--long'} style={{ fontWeight: 700 }}>
                    {r.direction === 'SHORT' ? '↓' : '↑'} {r.direction}
                  </span>
                </td>
                <td><span className={`adx-chip ${adxClass(r.adx_bucket)}`}>{r.adx_bucket}</span></td>
                <td><span className="adx-chip">{r.rsi_bucket}</span></td>
                <td>
                  <span style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: r.macd_bias === 'aligned' ? 'var(--pos)' : r.macd_bias === 'opposed' ? 'var(--neg)' : 'var(--text3)'
                  }}>
                    {r.macd_bias}
                  </span>
                </td>
                <td>{r.session && r.session !== 'unknown' ? <span className="sess-chip">{r.session}</span> : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                <td><WinRateBar wr={r.win_rate} n={r.n_total} /></td>
                <td>
                  {expVal != null
                    ? <span className={expVal >= 0 ? 'exp--pos' : 'exp--neg'}>{usd(expVal)}</span>
                    : <span className="exp--null">n/a</span>}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
                  {r.entry_h4_adx_avg != null ? Math.round(r.entry_h4_adx_avg) : '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
                  {r.entry_h1_rsi_avg != null ? r.entry_h1_rsi_avg.toFixed(1) : '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
                  {r.avg_stop_atr_multiple != null ? r.avg_stop_atr_multiple.toFixed(2) + '×' : '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                  {r.pct_target_hit != null ? `T${Math.round(r.pct_target_hit)}` : ''}
                  {r.pct_stop_hit != null ? ` S${Math.round(r.pct_stop_hit)}` : ''}
                  {r.pct_window_close != null ? ` W${Math.round(r.pct_window_close)}` : ''}
                </td>
                <td><span className={`conf-badge ${confClass(r.sample_confidence)}`}>{r.sample_confidence}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Forward rulebook ──────────────────────────────────────────────────────────
// Market behavior by condition bucket across ALL cycles (traded or not).
// Values are price points over the horizon after the signal.

function PtsCell({ val }) {
  if (val == null) return <span className="exp--null">—</span>;
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: val >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
      {pts(val)}
    </span>
  );
}

function ForwardRulebookSection({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="analyst-empty">No forward-labeled data yet — the labeler runs hourly</div>;
  }
  const sorted = [...rows].sort((a, b) => b.n_total - a.n_total);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="rulebook-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>ADX</th>
            <th>RSI</th>
            <th>n</th>
            <th>Avg 1h</th>
            <th>Avg 4h</th>
            <th>% up 4h</th>
            <th>Avg EOD</th>
            <th>Max up 4h</th>
            <th>Max dn 4h</th>
            <th>DXY ↑/↓/=</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const up = r.pct_up_4h;
            const upColor = up == null ? 'var(--text3)' : up >= 55 ? 'var(--pos)' : up <= 45 ? 'var(--neg)' : 'var(--text2)';
            return (
              <tr key={i}>
                <td>{r.session && r.session !== 'unknown' ? <span className="sess-chip">{r.session}</span> : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                <td><span className={`adx-chip ${adxClass(r.adx_bucket)}`}>{r.adx_bucket}</span></td>
                <td><span className="adx-chip">{r.rsi_bucket}</span></td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{r.n_total}</td>
                <td><PtsCell val={r.avg_fwd_1h} /></td>
                <td><PtsCell val={r.avg_fwd_4h} /></td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: upColor }}>
                  {up != null ? Math.round(up) + '%' : '—'}
                </td>
                <td><PtsCell val={r.avg_fwd_eod} /></td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--pos)' }}>
                  {r.avg_max_up_4h != null ? r.avg_max_up_4h.toFixed(1) : '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--neg)' }}>
                  {r.avg_max_down_4h != null ? r.avg_max_down_4h.toFixed(1) : '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                  {r.dxy_rising_pct != null
                    ? `${Math.round(r.dxy_rising_pct)}/${Math.round(r.dxy_falling_pct)}/${Math.round(r.dxy_flat_pct)}`
                    : '—'}
                </td>
                <td><span className={`conf-badge ${confClass(r.sample_confidence)}`}>{r.sample_confidence}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Collapsible section card ──────────────────────────────────────────────────
// Open/closed state persists per section in localStorage.

function Section({ id, title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(`analyst.section.${id}`);
      return saved != null ? saved === '1' : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () => {
    setOpen(prev => {
      try { localStorage.setItem(`analyst.section.${id}`, prev ? '0' : '1'); } catch { /* private mode */ }
      return !prev;
    });
  };

  return (
    <div className="analyst-card">
      <button
        type="button"
        className={`analyst-card__header analyst-card__header--btn ${open ? '' : 'analyst-card__header--closed'}`}
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="analyst-card__title">
          <span className={`section-chev ${open ? 'section-chev--open' : ''}`}>▸</span>
          {title}
        </span>
        <span className="analyst-card__count">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalystDashboard({ onBack }) {
  const [rulebook,     setRulebook]     = useState(null);
  const [pins,         setPins]         = useState([]);
  const [mechRulebook, setMechRulebook] = useState([]);
  const [fwdRulebook,  setFwdRulebook]  = useState([]);
  const [filter,       setFilter]       = useState('all');
  const [running,      setRunning]      = useState(false);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [error,        setError]        = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [rbRes, pinRes, mechRes, fwdRes] = await Promise.all([
        fetch(`${API}/api/analyst/rulebook`),
        fetch(`${API}/api/pinned-lessons`),
        fetch(`${API}/api/analyst/mechanical-rulebook`),
        fetch(`${API}/api/analyst/forward-rulebook`),
      ]);
      const [rbData, pinData, mechData, fwdData] = await Promise.all([
        rbRes.json(), pinRes.json(), mechRes.json(), fwdRes.json()
      ]);
      setRulebook(rbData);
      setPins(pinData.pinned || []);
      setMechRulebook(mechData.rows || []);
      setFwdRulebook(fwdData.rows || []);
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

        {/* Forward rulebook — market behavior across ALL cycles, traded or not */}
        <Section id="forward" title="Forward rulebook — market behavior" count={`${fwdRulebook.length} condition buckets`} defaultOpen={true}>
          <ForwardRulebookSection rows={fwdRulebook} />
        </Section>

        {/* Pinned lessons */}
        <Section id="pins" title="Pinned lessons" count={`${pins.filter(p => p.active).length} active`}>
          <div className="pins-grid">
            <PinnedCol label="Solo" color={C.solo} pins={soloPins} />
            <PinnedCol label="Overlay" color={C.overlay} pins={overlayPins} />
          </div>
        </Section>

        {/* Rulebook */}
        <Section id="rulebook" title="Rulebook" count={`${filteredRows.length} patterns`}>
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
        </Section>

        {/* Cross-account patterns */}
        <Section id="cross" title="Cross-account patterns" count="same tag, both accounts">
          <CrossAccountSection rulebook={allRows} />
        </Section>

        {/* Combinations */}
        <Section id="combos" title="Condition combinations" count="n≥3">
          {combos.length === 0
            ? <div className="analyst-empty">Combinations appear when a direction+ADX+RSI+session combo has 3+ trades</div>
            : combos.map((c, i) => <CombinationRow key={i} row={c} />)
          }
        </Section>

        {/* Mechanical Rulebook */}
        <Section id="mech" title="Mechanical rulebook" count={`${mechRulebook.length} condition buckets`}>
          <MechRulebookSection rows={mechRulebook} />
        </Section>

      </main>
    </div>
  );
}
