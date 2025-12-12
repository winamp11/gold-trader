import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'https://gold-trader-production.up.railway.app';

function App() {
  const [signal, setSignal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(395);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [performance, setPerformance] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);
  const [notificationPermission, setNotificationPermission] = useState('default');
  const prevSignalRef = useRef(null);

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
          setNotificationPermission(permission);
        });
      } else {
        setNotificationPermission(Notification.permission);
      }
    }
  }, []);

  // Send push notification when signal changes to GREEN
  const sendNotification = (newSignal) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = `🟢 GREEN SIGNAL - ${newSignal.direction}`;
      const body = `Entry: ${newSignal.recommendation?.entry.toFixed(2)} | Target: ${newSignal.recommendation?.target.toFixed(2)}`;
      
      new Notification(title, {
        body: body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        requireInteraction: true
      });
    }
  };

  const fetchSignal = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/signal?balance=${balance}`);
      const data = await response.json();
      
      // Check if signal changed from RED/null to GREEN
      if (data.signal === 'GREEN' && prevSignalRef.current?.signal !== 'GREEN') {
        sendNotification(data);
      }
      
      prevSignalRef.current = data;
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
      const response = await fetch(`${API_URL}/api/signals/history?limit=100`);
      const data = await response.json();
      setHistory(data.signals || []);
    } catch (error) {
      console.error('Error fetching history:', error);
    }
  };

  const fetchPerformance = async () => {
    try {
      const response = await fetch(`${API_URL}/api/stats/performance?days=7`);
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
    
    // Auto-refresh every 10 minutes
    const interval = setInterval(() => {
      fetchSignal();
      fetchHistory();
      fetchPerformance();
    }, 10 * 60 * 1000); // 10 minutes
    
    return () => clearInterval(interval);
  }, []); // Empty dependency array - only runs once on mount

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', { 
      month: '2-digit', 
      day: '2-digit', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const formatOutcome = (outcome) => {
    if (!outcome) return { text: 'PENDING', className: 'outcome-pending' };
    
    const outcomeMap = {
      'TARGET_HIT': { text: 'TARGET HIT', className: 'outcome-win' },
      'STOP_HIT': { text: 'STOP HIT', className: 'outcome-loss' },
      'NO_ENTRY': { text: 'NO ENTRY', className: 'outcome-pending' },
      'MISSED_OPPORTUNITY': { text: 'MISSED OPP', className: 'outcome-missed' },
      'CORRECT_RED': { text: 'CORRECT', className: 'outcome-pending' },
      'EXPIRED': { text: 'EXPIRED', className: 'outcome-pending' }
    };
    
    return outcomeMap[outcome] || { text: outcome, className: 'outcome-pending' };
  };

  if (loading && !signal) {
    return (
      <div className="App">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading signal data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      {/* Header */}
      <header className="header">
        <h1>⚡ GOLD TRADER</h1>
        <div className="header-actions">
          <button onClick={() => setShowHistory(!showHistory)} className="history-btn">
            {showHistory ? '📊 Dashboard' : '📜 History'}
          </button>
        </div>
      </header>

      <div className="container">
        {showHistory ? (
          /* History Table View */
          <div className="history-view">
            <h2>📊 Signal History</h2>
            <p className="history-subtitle">Last 100 signals</p>
            
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Signal</th>
                    <th>Direction</th>
                    <th>Entry</th>
                    <th>Stop</th>
                    <th>Target</th>
                    <th>Size</th>
                    <th>Outcome</th>
                    <th>P&L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((sig) => {
                    const isGreen = sig.signal === 'GREEN';
                    const outcome = formatOutcome(sig.outcome);
                    const isExpanded = expandedRow === sig.id;
                    
                    return (
                      <React.Fragment key={sig.id}>
                        <tr className="history-row" onClick={() => setExpandedRow(isExpanded ? null : sig.id)}>
                          <td>{formatTime(sig.timestamp)}</td>
                          <td className={isGreen ? 'signal-green' : 'signal-red'}>
                            {isGreen ? '🟢 GREEN' : '🔴 RED'}
                          </td>
                          <td>{sig.direction || '—'}</td>
                          <td>{sig.entry_price?.toFixed(2) || '—'}</td>
                          <td>{sig.stop_loss?.toFixed(2) || '—'}</td>
                          <td>{sig.target?.toFixed(2) || '—'}</td>
                          <td>{sig.position_size?.toFixed(2) || '—'}</td>
                          <td>
                            <span className={`outcome-badge ${outcome.className}`}>
                              {outcome.text}
                            </span>
                          </td>
                          <td className={sig.outcome_pnl > 0 ? 'pnl-positive' : sig.outcome_pnl < 0 ? 'pnl-negative' : ''}>
                            {sig.outcome_pnl ? `$${sig.outcome_pnl.toFixed(2)}` : '—'}
                          </td>
                          <td className="expand-icon">{isExpanded ? '▼' : '▶'}</td>
                        </tr>
                        
                        {isExpanded && (
                          <tr className="expanded-row">
                            <td colSpan="10">
                              <div className="expanded-content">
                                <div className="expanded-section">
                                  <h4>📊 Timeframe Indicators</h4>
                                  <div className="indicator-grid">
                                    <div className="indicator-box">
                                      <div className="indicator-label">H4 (4-Hour)</div>
                                      <div className="indicator-values">
                                        <span>MACD: {sig.h4_macd?.toFixed(2)}</span>
                                        <span>RSI: {sig.h4_rsi?.toFixed(1)}</span>
                                        <span>MFI: {sig.h4_mfi?.toFixed(1)}</span>
                                      </div>
                                    </div>
                                    <div className="indicator-box">
                                      <div className="indicator-label">H1 (1-Hour)</div>
                                      <div className="indicator-values">
                                        <span>MACD: {sig.h1_macd?.toFixed(2)}</span>
                                        <span>RSI: {sig.h1_rsi?.toFixed(1)}</span>
                                        <span>MFI: {sig.h1_mfi?.toFixed(1)}</span>
                                      </div>
                                    </div>
                                    <div className="indicator-box">
                                      <div className="indicator-label">M30 (30-Min)</div>
                                      <div className="indicator-values">
                                        <span>MACD: {sig.m30_macd?.toFixed(2)}</span>
                                        <span>RSI: {sig.m30_rsi?.toFixed(1)}</span>
                                        <span>MFI: {sig.m30_mfi?.toFixed(1)}</span>
                                      </div>
                                    </div>
                                    <div className="indicator-box">
                                      <div className="indicator-label">M15 (15-Min)</div>
                                      <div className="indicator-values">
                                        <span>MACD: {sig.m15_macd?.toFixed(2)}</span>
                                        <span>RSI: {sig.m15_rsi?.toFixed(1)}</span>
                                        <span>MFI: {sig.m15_mfi?.toFixed(1)}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                
                                {sig.reasoning && (
                                  <div className="expanded-section">
                                    <h4>📝 Reasoning</h4>
                                    <p className="reasoning-text">{sig.reasoning}</p>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  
                  {history.length === 0 && (
                    <tr>
                      <td colSpan="10" className="no-data">
                        No signals yet. System will generate signals during trading hours (12:00-22:00 Dubai time).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* Dashboard View */
          <>
            {/* Rest of dashboard stays the same... */}
            {signal && signal.signal === 'CLOSED' ? (
              <div className="closed-message">
                <h2>⏸️ Market Closed</h2>
                <p>{signal.message}</p>
                <p className="next-session">{signal.nextTradingTime}</p>
              </div>
            ) : (
              <>
                {/* Signal Card */}
                <div className="signal-card">
                  <div className={`signal-light ${signal?.signal === 'GREEN' ? 'green' : 'red'}`}>
                    {signal?.signal === 'GREEN' ? '🟢' : '🔴'}
                  </div>
                  <div className="signal-status">
                    <h2>{signal?.signal} LIGHT</h2>
                    {signal?.signal === 'GREEN' && signal?.recommendation && (
                      <div className="signal-type">{signal.recommendation.direction} SETUP</div>
                    )}
                    {signal?.signal === 'RED' && (
                      <div className="signal-reason">NO TRADE</div>
                    )}
                    <div className="last-update">
                      Last update: {lastUpdate ? formatTime(lastUpdate) : 'Loading...'}
                    </div>
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

                {/* Trade Details - Only show if GREEN */}
                {signal?.signal === 'GREEN' && signal?.recommendation && (
                  <div className="trade-details">
                    <div className="detail-grid">
                      <div className="detail-item">
                        <div className="detail-label">Entry Price</div>
                        <div className="detail-value">{signal.recommendation.entry.toFixed(2)}</div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Stop Loss</div>
                        <div className="detail-value">{signal.recommendation.stop.toFixed(2)}</div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Target</div>
                        <div className="detail-value">{signal.recommendation.target.toFixed(2)}</div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">R:R Ratio</div>
                        <div className="detail-value">
                          {signal.recommendation.rewardRiskRatio?.toFixed(2)}:1
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Position Sizing - Only show if GREEN */}
                {signal?.signal === 'GREEN' && signal?.recommendation && (
                  <div className="position-sizing">
                    <h3>Position Sizing</h3>
                    <div className="sizing-grid">
                      <div className="sizing-item">
                        <div className="sizing-label">Lot Size</div>
                        <div className="sizing-value">{signal.recommendation.positionSize.toFixed(2)}</div>
                      </div>
                      <div className="sizing-item">
                        <div className="sizing-label">Risk Amount</div>
                        <div className="sizing-value">${signal.recommendation.riskAmount.toFixed(2)}</div>
                        <div className="sizing-subtext">
                          ({((signal.recommendation.riskAmount / balance) * 100).toFixed(1)}% of account)
                        </div>
                      </div>
                      <div className="sizing-item">
                        <div className="sizing-label">Potential Profit</div>
                        <div className="sizing-value positive">
                          ${signal.recommendation.potentialProfit.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Reasoning - Only show if RED */}
                {signal?.signal === 'RED' && signal?.reasoning && (
                  <div className="reasoning-box">
                    <h3>Why No Trade?</h3>
                    <p>{signal.reasoning}</p>
                  </div>
                )}

                {/* Timeframes Table */}
                {signal?.marketData && (
                  <div className="timeframes">
                    <h3>Timeframe Analysis</h3>
                    <div className="timeframes-grid">
                      {Object.entries(signal.marketData).map(([key, tf]) => (
                        <div key={key} className="timeframe-card">
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
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
