import React, { useState, useEffect } from 'react';
import './AutochartistCalculator.css';

function AutochartistCalculator({ onBack }) {
  const [patternType, setPatternType] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [timeIdentified, setTimeIdentified] = useState('');
  const [elapsedTime, setElapsedTime] = useState('');
  const [showResult, setShowResult] = useState(false);
  const [result, setResult] = useState({
    finalProbability: 0,
    patternRate: 0,
    hoursRate: 0,
    timeframeRate: 0
  });

  // Pattern success rates from CSV data
  const patternRates = {
    'ascending-triangle': 72,
    'channel-down': 73,
    'channel-up': 74,
    'descending-triangle': 73,
    'double-bottom': 82,
    'double-top': 80,
    'falling-wedge': 68,
    'flag': 69,
    'head-shoulders': 82,
    'inverse-head-shoulders': 84,
    'pennant': 56,
    'rectangle': 80,
    'rising-wedge': 66,
    'triangle': 65,
    'resistance': 80,
    'support': 79
  };

  // Hours elapsed rates (emerging pattern data)
  const hoursRates = {
    0: 80, 1: 79, 2: 80, 3: 82, 4: 83, 5: 82, 6: 83, 7: 81,
    8: 80, 9: 79, 10: 81, 11: 79, 12: 79, 13: 78, 14: 79,
    15: 77, 16: 76, 17: 78, 18: 79, 19: 79, 20: 82, 21: 80,
    22: 80, 23: 79
  };

  // Timeframe rates (emerging patterns)
  const timeframeRates = {
    '15': 79,
    '30': 80,
    '60': 81,
    '240': 79,
    '1440': 74
  };

  // Update elapsed time
  useEffect(() => {
    if (!timeIdentified) return;

    const updateElapsed = () => {
      const identified = new Date(timeIdentified);
      const now = new Date();
      const hoursElapsed = Math.floor((now - identified) / (1000 * 60 * 60));
      const minutesElapsed = Math.floor(((now - identified) % (1000 * 60 * 60)) / (1000 * 60));
      
      setElapsedTime(`${hoursElapsed} hours, ${minutesElapsed} minutes elapsed`);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 60000); // Update every minute
    
    return () => clearInterval(interval);
  }, [timeIdentified]);

  const calculateProbability = () => {
    if (!patternType || !timeframe || !timeIdentified) {
      alert('Please fill in all fields');
      return;
    }

    // Calculate hours elapsed
    const identified = new Date(timeIdentified);
    const now = new Date();
    const hoursElapsed = Math.floor((now - identified) / (1000 * 60 * 60));

    // Get rates
    const patternRate = patternRates[patternType] || 75;
    const hoursRate = hoursRates[Math.min(hoursElapsed, 23)] || 80;
    const timeframeRate = timeframeRates[timeframe] || 80;

    // Calculate weighted average (40% pattern, 30% hours, 30% timeframe)
    const finalProbability = Math.round(
      (patternRate * 0.4 + hoursRate * 0.3 + timeframeRate * 0.3)
    );

    setResult({
      finalProbability,
      patternRate,
      hoursRate,
      timeframeRate
    });

    setShowResult(true);
  };

  return (
    <div className="autochartist-page">
      {/* Header */}
      <div className="ac-header">
        <h1>📊 Autochartist Probability Calculator</h1>
        <button onClick={onBack} className="back-btn">← Back to Dashboard</button>
      </div>

      <div className="ac-container">
        {/* Calculator Card */}
        <div className="calculator-card">
          <h2>Calculate Pattern Success Probability</h2>
          
          <div className="form-grid">
            {/* Pattern Type */}
            <div className="form-group">
              <label className="form-label">Pattern Type</label>
              <select 
                className="form-select" 
                value={patternType}
                onChange={(e) => setPatternType(e.target.value)}
              >
                <option value="">Select pattern...</option>
                <optgroup label="Breakout Patterns">
                  <option value="ascending-triangle">Ascending Triangle (72%)</option>
                  <option value="channel-down">Channel Down (73%)</option>
                  <option value="channel-up">Channel Up (74%)</option>
                  <option value="descending-triangle">Descending Triangle (73%)</option>
                  <option value="double-bottom">Double Bottom (82%)</option>
                  <option value="double-top">Double Top (80%)</option>
                  <option value="falling-wedge">Falling Wedge (68%)</option>
                  <option value="flag">Flag (69%)</option>
                  <option value="head-shoulders">Head and Shoulders (82%)</option>
                  <option value="inverse-head-shoulders">Inverse H&S (84%)</option>
                  <option value="pennant">Pennant (56%)</option>
                  <option value="rectangle">Rectangle (80%)</option>
                  <option value="rising-wedge">Rising Wedge (66%)</option>
                  <option value="triangle">Triangle (65%)</option>
                </optgroup>
                <optgroup label="Emerging/Approaching Patterns">
                  <option value="resistance">Resistance - Emerging (80%)</option>
                  <option value="support">Support - Emerging (79%)</option>
                </optgroup>
              </select>
            </div>

            {/* Timeframe */}
            <div className="form-group">
              <label className="form-label">Timeframe</label>
              <select 
                className="form-select"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                <option value="">Select timeframe...</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">1 hour (H1)</option>
                <option value="240">4 hours (H4)</option>
                <option value="1440">Daily (D1)</option>
              </select>
            </div>

            {/* Time Identified */}
            <div className="form-group">
              <label className="form-label">Time Pattern Identified (Dubai Time)</label>
              <input 
                type="datetime-local" 
                className="form-input"
                value={timeIdentified}
                onChange={(e) => setTimeIdentified(e.target.value)}
              />
              {elapsedTime && <div className="elapsed-time">{elapsedTime}</div>}
            </div>
          </div>

          <button className="calculate-btn" onClick={calculateProbability}>
            Calculate Probability
          </button>

          {/* Result Card */}
          {showResult && (
            <div className="result-card">
              <div className="result-title">ESTIMATED SUCCESS PROBABILITY</div>
              <div className="result-percentage">{result.finalProbability}%</div>
              
              <div className="result-breakdown">
                <div className="breakdown-item">
                  <div className="breakdown-label">Pattern Type</div>
                  <div className="breakdown-value">{result.patternRate}%</div>
                </div>
                <div className="breakdown-item">
                  <div className="breakdown-label">Hours Elapsed</div>
                  <div className="breakdown-value">{result.hoursRate}%</div>
                </div>
                <div className="breakdown-item">
                  <div className="breakdown-label">Timeframe</div>
                  <div className="breakdown-value">{result.timeframeRate}%</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Info Cards */}
        <div className="info-cards">
          {/* Best Patterns */}
          <div className="info-card">
            <h3>🏆 Best Performing Patterns</h3>
            <ul className="info-list">
              <li><span>Inverse H&S (Breakout)</span> <span className="percentage-tag">84%</span></li>
              <li><span>Double Bottom (Breakout)</span> <span className="percentage-tag">82%</span></li>
              <li><span>Head & Shoulders (Breakout)</span> <span className="percentage-tag">82%</span></li>
              <li><span>Resistance (Emerging)</span> <span className="percentage-tag">80%</span></li>
              <li><span>Rectangle (Breakout)</span> <span className="percentage-tag">80%</span></li>
            </ul>
          </div>

          {/* Best Hours */}
          <div className="info-card">
            <h3>⏰ Best Entry Timing (Hours After Identified)</h3>
            <ul className="info-list">
              <li><span>4 hours after</span> <span className="percentage-tag">83%</span></li>
              <li><span>5 hours after</span> <span className="percentage-tag">82%</span></li>
              <li><span>6 hours after</span> <span className="percentage-tag">83%</span></li>
              <li><span>20 hours after</span> <span className="percentage-tag">82%</span></li>
            </ul>
          </div>

          {/* Best Timeframes */}
          <div className="info-card">
            <h3>📈 Best Timeframes (Emerging Patterns)</h3>
            <ul className="info-list">
              <li><span>60 min (H1)</span> <span className="percentage-tag">81%</span></li>
              <li><span>30 min</span> <span className="percentage-tag">80%</span></li>
              <li><span>15 min</span> <span className="percentage-tag">79%</span></li>
              <li><span>240 min (H4)</span> <span className="percentage-tag">79%</span></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AutochartistCalculator;
