import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [signal, setSignal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(395);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [performance, setPerformance] = useState(null);

  const fetchSignal = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const endpoint = forceRefresh ? '/api/signal/refresh' : `/api/signal?balance=${balance}`;
      const method = forceRefresh ? 'POST' : 'GET';
      const body = forceRefresh ? JSON.stringify({ balance }) : undefined;
      
      const response = await fetch(endpoint, {
        method,
        headers: forceRefresh ? { 'Content-Type': 'application/json' } : {},
        body
      });
      
      const data = await response.json();
      setSignal(data);
      setLastUpdate(new Date());
      setLoading(false);
    } catch (error) {
      console.error('Error fetching signal:', error);
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const response = await fetch('/api/signals/history?limit=50');
      const data = await response.json();
      setHistory(data.signals || []);
    } catch (error) {
      console.error('Error fetching history:', error);
    }
  };

  const fetchPerformance = async () => {
    try {
      const response = await fetch('/api/stats/performance?days=7');
      const data = await response.json();
      setPerformance(data);
    } catch (error) {
      console.error('Error fetching performance:', error);
    }
  };

  useEffect(() => {
    fetchSignal();
    fetchHistory();
    fetchPerformance();
    // Auto-refresh every 5 minutes
    const interval = setInterval(() => {
      fetchSignal();
      fetchHistory();
      fetchPerformance();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [balance]);

  const formatTime = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  if (loading && !signal) {
    return (
      <div className="App">
        <div className="loading">
          <div className="spinner"></div>
          <p>Fetching market data...</p>
        </div>
      </div>
    );
  }

  const isGreen = signal?.signal === 'GREEN';
  const rec = signal?.recommendation || {};

  return (
    <div className="App">
      {/* Header */}
      <header className="header">
        <h1>⚡ GOLD TRADER</h1>
        <div className="header-actions">
          <button onClick={() => setShowHistory(!showHistory)} className="history-btn">
            {showHistory ? '📊 Dashboard' : '📜 History'}
          </button>
          <button onClick={() => fetchSignal(true)} className="refresh-btn" disabled={loading}>
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </header>

      <div className="container">
        {showHistory ? (
          /* Signal History View */
          <div className="history-view">
            <h2>📜 Signal History</h2>
            <p className="history-subtitle">Last 50 signals generated</p>
            
            <div className="history-list">
              {history.map((sig, idx) => {
                const isGreen = sig.signal === 'GREEN';
                const sigTime = new Date(sig.timestamp);
                
                return (
                  <div key={idx} className={`history-item ${isGreen ? 'green' : 'red'}`}>
                    <div className="history-header">
                      <div className="history-signal">
                        <span className={`history-badge ${isGreen ? 'green' : 'red'}`}>
                          {isGreen ? '🟢' : '🔴'}
                        </span>
                        <span className="history-type">
                          {isGreen ? `${sig.direction} SETUP` : 'NO TRADE'}
                        </span>
                      </div>
                      <div className="history-time">
                        {sigTime.toLocaleString()}
                      </div>
                    </div>
                    
                    {isGreen ? (
                      <div className="history-details">
                        <div className="history-row">
                          <span>Entry: <strong>{sig.entry_price?.toFixed(2)}</strong></span>
                          <span>Stop: <strong>{sig.stop_loss?.toFixed(2)}</strong></span>
                          <span>Target: <strong>{sig.target?.toFixed(2)}</strong></span>
                        </div>
                        <div className="history-row">
                          <span>Size: <strong>{sig.position_size} lot</strong></span>
                          <span>Risk: <strong>${sig.risk_amount?.toFixed(2)}</strong></span>
                          <span>R:R: <strong>{(sig.potential_profit / sig.risk_amount).toFixed(2)}:1</strong></span>
                        </div>
                        <div className="history-confidence">
                          {sig.confidence} CONFIDENCE
                        </div>
                      </div>
                    ) : (
                      <div className="history-reason">
                        {sig.reasoning}
                      </div>
                    )}
                    
                    <div className="history-indicators">
                      <span>H4: RSI {sig.h4_rsi?.toFixed(1)} | MACD {sig.h4_macd?.toFixed(2)}</span>
                      <span>H1: RSI {sig.h1_rsi?.toFixed(1)} | MACD {sig.h1_macd?.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })}
              
              {history.length === 0 && (
                <div className="no-history">
                  No signals yet. Wait for the first signal to be generated.
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Dashboard View */
          <>
        {/* Signal Card */}
        <div className="signal-card">
          <div className="signal-status">
            <div className={`signal-light ${isGreen ? 'green' : 'red'}`}>
              {isGreen ? '🟢' : '🔴'}
            </div>
            <h2 className="signal-title">
              {isGreen ? 'GREEN LIGHT' : 'RED LIGHT'}
            </h2>
            <p className="signal-subtitle">
              {isGreen ? `${rec.direction} Setup Available` : 'No Trade Zone'}
            </p>
            {isGreen && (
              <div className="confidence-badge">
                {rec.confidence} CONFIDENCE ⭐⭐⭐
              </div>
            )}
          </div>

          {isGreen ? (
            <>
              <div className="trade-details">
                <div className="detail-item">
                  <div className="detail-label">Entry Price</div>
                  <div className="detail-value">{rec.entry?.toFixed(2)}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Stop Loss</div>
                  <div className="detail-value">{rec.stop?.toFixed(2)}</div>
                  <div className="detail-subvalue">
                    {Math.abs(rec.entry - rec.stop).toFixed(1)} points
                  </div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Target</div>
                  <div className="detail-value">{rec.target?.toFixed(2)}</div>
                  <div className="detail-subvalue">
                    +{Math.abs(rec.target - rec.entry).toFixed(1)} points
                  </div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">R:R Ratio</div>
                  <div className="detail-value">{rec.riskReward?.toFixed(2)}:1</div>
                </div>
              </div>

              <div className="position-box">
                <h3>RECOMMENDED POSITION SIZE</h3>
                <div className="position-size">{rec.positionSize} lot</div>
                <div className="position-details">
                  <span>Risk: ${rec.riskAmount?.toFixed(2)} ({rec.riskPercent?.toFixed(2)}%)</span>
                  <span>Potential: +${rec.potentialProfit?.toFixed(2)}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="red-reason">
              <h3>Why No Trade:</h3>
              <p>{signal?.reason}</p>
            </div>
          )}

          <div className="last-update">
            Current Price: {signal?.currentPrice?.toFixed(2)} | 
            Last updated: {lastUpdate ? formatTime(lastUpdate) : '...'}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Account Balance</div>
            <div className="stat-value">${balance.toFixed(2)}</div>
            <input 
              type="number" 
              value={balance} 
              onChange={(e) => setBalance(parseFloat(e.target.value) || 0)}
              className="balance-input"
            />
          </div>
          <div className="stat-card">
            <div className="stat-label">API Calls Used</div>
            <div className="stat-value">{signal?.marketData?.h4 ? '4' : '0'} / 8</div>
            <div className="stat-subtext">Per minute limit</div>
          </div>
          {performance && (
            <>
              <div className="stat-card">
                <div className="stat-label">GREEN Win Rate (7d)</div>
                <div className={`stat-value ${parseFloat(performance.green.winRate) >= 70 ? 'positive' : ''}`}>
                  {performance.green.winRate || '0'}%
                </div>
                <div className="stat-subtext">
                  {performance.green.wins}W / {performance.green.losses}L / {performance.green.noEntry}NE
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Missed Opportunities (7d)</div>
                <div className={`stat-value ${parseFloat(performance.red.missedRate) >= 20 ? 'negative' : ''}`}>
                  {performance.red.missedRate || '0'}%
                </div>
                <div className="stat-subtext">
                  {performance.red.missed} of {performance.red.total} RED signals
                </div>
              </div>
            </>
          )}
        </div>

        {/* Timeframes */}
        <div className="timeframes-card">
          <h3>📈 TIMEFRAME STATUS</h3>
          {signal?.timeframes && Object.entries(signal.timeframes).map(([key, tf]) => (
            <div className="timeframe-row" key={key}>
              <div className="timeframe-label">{key.toUpperCase()}</div>
              <div className="timeframe-indicators">
                <div className="indicator">
                  <span className={`indicator-dot ${tf.trend}`}></span>
                  <span>MACD: {tf.macd?.toFixed(2)}</span>
                </div>
                <div className="indicator">
                  <span className={`indicator-dot ${tf.trend}`}></span>
                  <span>RSI: {tf.rsi?.toFixed(1)}</span>
                </div>
                <div className="indicator">
                  <span className={`indicator-dot ${tf.trend}`}></span>
                  <span>MFI: {tf.mfi?.toFixed(1)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        </>
        )}
      </div>
    </div>
  );
}

export default App;
