import React, { useState, useEffect, useCallback } from 'react';
import './AnalystDashboard.css';

const API = process.env.REACT_APP_API_URL || '';

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function WinRateBar({ winRate, nTotal }) {
  if (!nTotal) return <span className="analyst__muted">—</span>;
  const pct = Math.round((winRate || 0) * 100);
  const cls = pct >= 60 ? '' : pct >= 40 ? 'analyst__wr-fill--mid' : 'analyst__wr-fill--low';
  return (
    <div className="analyst__wr-bar">
      <div className="analyst__wr-track">
        <div className={`analyst__wr-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="analyst__wr-pct">{pct}%</span>
    </div>
  );
}

function ExpCell({ exp }) {
  if (exp == null) return <span className="analyst__muted">—</span>;
  const cls = exp > 0 ? 'analyst__pos' : exp < 0 ? 'analyst__neg' : '';
  return <span className={cls}>{exp > 0 ? '+' : ''}{exp.toFixed(2)}R</span>;
}

function ConfBadge({ conf }) {
  if (!conf) return null;
  const cls = conf === 'sufficient' ? 'analyst__conf-badge--sufficient'
    : conf === 'early' ? 'analyst__conf-badge--early'
    : 'analyst__conf-badge--insufficient';
  return <span className={`analyst__conf-badge ${cls}`}>{conf}</span>;
}

function AccountBadge({ name }) {
  const label = name === 'claude_overlay' ? 'overlay' : name === 'claude_solo' ? 'solo' : name;
  const cls   = name === 'claude_overlay' ? 'analyst__account-badge--overlay' : 'analyst__account-badge--solo';
  return <span className={`analyst__account-badge ${cls}`}>{label}</span>;
}

function PinnedCol({ account, label, pins }) {
  const filtered = pins.filter(p => p.account_name === account && p.active);
  return (
    <div className="analyst__pin-col">
      <div className="analyst__pin-account">{label}</div>
      {filtered.length === 0 && (
        <div className="analyst__pin-empty">no active pins</div>
      )}
      {filtered.map(pin => (
        <div key={pin.id} className="analyst__pin-item">
          <div className="analyst__pin-tag">{pin.tag}</div>
          <div className="analyst__pin-text">{pin.lesson_text}</div>
          <div className="analyst__pin-meta">
            {pin.tag_loss_count} losses · pinned {fmtDateTime(pin.pinned_at)}
          </div>
        </div>
      ))}
    </div>
  );
}

function RulebookRow({ row }) {
  return (
    <tr>
      <td>
        <div className="analyst__tag-cell" title={row.tag}>{row.tag}</div>
      </td>
      <td><AccountBadge name={row.account_name} /></td>
      <td><WinRateBar winRate={row.win_rate} nTotal={row.n_total} /></td>
      <td><span className="analyst__muted">{row.n_total ?? '—'}</span></td>
      <td><ExpCell exp={row.expectancy} /></td>
      <td><ConfBadge conf={row.sample_confidence} /></td>
      <td className="analyst__muted">
        {row.last_trade_date ? fmtDateTime(row.last_trade_date) : '—'}
      </td>
    </tr>
  );
}

function CrossAccountSection({ rulebook }) {
  const tagsByAccount = {};
  for (const row of rulebook) {
    if (!tagsByAccount[row.tag]) tagsByAccount[row.tag] = [];
    tagsByAccount[row.tag].push(row);
  }
  const crossTags = Object.entries(tagsByAccount)
    .filter(([, rows]) => rows.length > 1)
    .map(([tag, rows]) => ({ tag, rows }));

  if (crossTags.length === 0) {
    return (
      <div className="analyst__section">
        <div className="analyst__section-header">Cross-account patterns</div>
        <div className="analyst__empty">No tags appear in both accounts yet.</div>
      </div>
    );
  }

  return (
    <div className="analyst__section">
      <div className="analyst__section-header">Cross-account patterns</div>
      <div className="analyst__cross-list">
        {crossTags.map(({ tag, rows }) => (
          <div key={tag} className="analyst__cross-item">
            <div className="analyst__cross-tag">{tag}</div>
            <div className="analyst__cross-stats">
              {rows.map(r => {
                const pct = Math.round((r.win_rate || 0) * 100);
                const label = r.account_name === 'claude_overlay' ? 'overlay' : 'solo';
                return (
                  <span key={r.account_name}>
                    {label}: {pct}% WR ({r.n_total} trades)
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CombinationRow({ comb }) {
  const label = comb.account_name === 'claude_overlay' ? 'overlay' : 'solo';
  const pct   = Math.round((comb.win_rate || 0) * 100);
  const parts = [
    comb.direction    && `dir: ${comb.direction}`,
    comb.adx_bucket   && `ADX: ${comb.adx_bucket}`,
    comb.h4_rsi_bucket && `RSI: ${comb.h4_rsi_bucket}`,
    comb.session && comb.session !== 'unknown' && `session: ${comb.session}`,
  ].filter(Boolean);

  return (
    <div className="analyst__comb-item">
      <div className="analyst__comb-account">{label}</div>
      <div className="analyst__comb-body">
        <div className="analyst__comb-conditions">{parts.join(' · ')}</div>
        <div className="analyst__comb-stats">
          <span>{pct}% WR</span>
          <span>{comb.n_total} trades</span>
          {comb.expectancy != null && (
            <span className={comb.expectancy >= 0 ? 'analyst__pos' : 'analyst__neg'}>
              {comb.expectancy >= 0 ? '+' : ''}{comb.expectancy.toFixed(2)}R
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const FILTERS = ['all', 'solo', 'overlay', 'sufficient', 'early'];

export default function AnalystDashboard({ onBack }) {
  const [rulebook,     setRulebook]     = useState([]);
  const [combinations, setCombinations] = useState([]);
  const [pins,         setPins]         = useState([]);
  const [lastRun,      setLastRun]      = useState(null);
  const [filter,       setFilter]       = useState('all');
  const [running,      setRunning]      = useState(false);
  const [loading,      setLoading]      = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [rbRes, pinRes] = await Promise.all([
        fetch(`${API}/api/analyst/rulebook`),
        fetch(`${API}/api/pinned-lessons`),
      ]);
      const [rbData, pinData] = await Promise.all([
        rbRes.json(), pinRes.json(),
      ]);
      const rb   = rbData.rulebook      || [];
      const comb = rbData.combinations  || [];
      setRulebook(rb);
      setCombinations(comb);
      setPins(pinData.pinned || []);
      if (rb.length > 0 && rb[0].last_updated) {
        setLastRun(rb[0].last_updated);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const runAnalysis = async () => {
    setRunning(true);
    try {
      const res  = await fetch(`${API}/api/analyst/run`, { method: 'POST' });
      const data = await res.json();
      if (data.timestamp) setLastRun(data.timestamp);
      await fetchData();
    } catch {}
    setRunning(false);
  };

  const filteredRulebook = rulebook.filter(row => {
    if (filter === 'solo')       return row.account_name === 'claude_solo';
    if (filter === 'overlay')    return row.account_name === 'claude_overlay';
    if (filter === 'sufficient') return row.sample_confidence === 'sufficient';
    if (filter === 'early')      return row.sample_confidence === 'early';
    return true;
  });

  // Summary cards — use pre-computed summary if present, else derive
  const totalPatterns = rulebook.length;

  let topWRTag = '—';
  let topWRPct = null;
  let bestExpVal   = null;
  let bestExpTag   = '—';
  for (const row of rulebook) {
    if (!row.n_total) continue;
    const pct = (row.win_rate || 0) * 100;
    if (topWRPct === null || pct > topWRPct) { topWRPct = pct; topWRTag = row.tag; }
    if (row.expectancy != null && (bestExpVal === null || row.expectancy > bestExpVal)) {
      bestExpVal = row.expectancy; bestExpTag = row.tag;
    }
  }

  const activePins    = pins.filter(p => p.active);
  const soloPins      = activePins.filter(p => p.account_name === 'claude_solo').length;
  const overlayPins   = activePins.filter(p => p.account_name === 'claude_overlay').length;

  return (
    <div className="analyst">
      <header className="analyst__header">
        <span className="analyst__title">ANALYST</span>
        <div className="analyst__header-right">
          {lastRun && (
            <span className="analyst__ts">last run {fmtDateTime(lastRun)}</span>
          )}
          <button className="analyst__btn" onClick={onBack}>← Back</button>
          <button
            className="analyst__btn analyst__btn--run"
            onClick={runAnalysis}
            disabled={running}
          >
            {running ? 'running…' : '▶ Run now'}
          </button>
        </div>
      </header>

      <main className="analyst__main">
        {loading ? (
          <div className="analyst__loading">loading…</div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="analyst__cards">
              <div className="analyst__card">
                <div className="analyst__card-label">Total patterns</div>
                <div className="analyst__card-value">{totalPatterns}</div>
              </div>
              <div className="analyst__card">
                <div className="analyst__card-label">Top win rate</div>
                <div className="analyst__card-value">
                  {topWRPct != null ? `${Math.round(topWRPct)}%` : '—'}
                </div>
                {topWRPct != null && (
                  <div className="analyst__card-sub" title={topWRTag}>
                    {topWRTag.length > 22 ? topWRTag.slice(0, 22) + '…' : topWRTag}
                  </div>
                )}
              </div>
              <div className="analyst__card">
                <div className="analyst__card-label">Best expectancy</div>
                <div className="analyst__card-value">
                  {bestExpVal != null
                    ? (bestExpVal >= 0 ? '+' : '') + bestExpVal.toFixed(2) + 'R'
                    : '—'}
                </div>
                {bestExpVal != null && (
                  <div className="analyst__card-sub" title={bestExpTag}>
                    {bestExpTag.length > 22 ? bestExpTag.slice(0, 22) + '…' : bestExpTag}
                  </div>
                )}
              </div>
              <div className="analyst__card">
                <div className="analyst__card-label">Pins active</div>
                <div className="analyst__card-value">{activePins.length}</div>
                <div className="analyst__card-sub">
                  {soloPins} solo · {overlayPins} overlay
                </div>
              </div>
            </div>

            {/* Pinned lessons */}
            <div className="analyst__section">
              <div className="analyst__section-header">Pinned lessons</div>
              <div className="analyst__pins">
                <PinnedCol account="claude_solo"    label="Solo"    pins={pins} />
                <PinnedCol account="claude_overlay" label="Overlay" pins={pins} />
              </div>
            </div>

            {/* Rulebook */}
            <div className="analyst__section">
              <div className="analyst__section-header">Rulebook</div>
              <div className="analyst__filter-tabs">
                {FILTERS.map(f => (
                  <button
                    key={f}
                    className={`analyst__tab${filter === f ? ' analyst__tab--active' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              {filteredRulebook.length === 0 ? (
                <div className="analyst__table-empty">no patterns match this filter</div>
              ) : (
                <div className="analyst__table-wrap">
                  <table className="analyst__table">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th>Account</th>
                        <th>Win rate</th>
                        <th>n</th>
                        <th>Expectancy</th>
                        <th>Confidence</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRulebook.map((row, i) => (
                        <RulebookRow key={`${row.account_name}-${row.tag}-${i}`} row={row} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Cross-account patterns */}
            <CrossAccountSection rulebook={rulebook} />

            {/* Condition combinations */}
            <div className="analyst__section">
              <div className="analyst__section-header">Condition combinations</div>
              {combinations.length === 0 ? (
                <div className="analyst__empty">No combinations with ≥3 trades yet.</div>
              ) : (
                <div className="analyst__comb-list">
                  {combinations.map((comb, i) => (
                    <CombinationRow key={i} comb={comb} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
