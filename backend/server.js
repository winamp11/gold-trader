import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import twelveData from './twelveData.js';
import signalEngine from './signalEngine.js';
import database from './database.js';
import outcomeTracker from './outcomeTracker.js';
import { isTradingHours, getNextTradingTime } from './tradingHours.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Store current signal in memory
let currentSignal = null;
let lastUpdate = null;

// Lightweight price poller: 1 API call every 2 minutes during trading hours.
// Decoupled from signal generation so outcome checks run continuously.
function startPricePoller() {
  console.log('📡 Starting price poller (every 2 minutes during trading hours)...');

  setInterval(async () => {
    if (!isTradingHours()) return;
    if (outcomeTracker.activeTracking.size === 0) return;

    try {
      const price = await twelveData.fetchPrice('XAU/USD');
      console.log(`📡 [POLLER] XAU/USD: $${price.toFixed(2)} | Active: ${outcomeTracker.activeTracking.size}`);
      outcomeTracker.checkOutcomesWithPrice(price);
    } catch (error) {
      console.error('❌ [POLLER] Price check failed:', error.message);
    }
  }, 2 * 60 * 1000);
}

// Background job to generate signals every 8 minutes during trading hours
function startBackgroundSignalGeneration() {
  console.log('🤖 Starting background signal generation...');
  
  // Run immediately on startup if within trading hours
  generateSignalIfTradingHours();
  
  // Then run every 8 minutes
  setInterval(() => {
    generateSignalIfTradingHours();
  }, 8 * 60 * 1000); // 8 minutes
}

async function generateSignalIfTradingHours() {
  if (!isTradingHours()) {
    console.log('⏸️  Outside trading hours - skipping signal generation');
    return;
  }
  
  try {
    console.log('\n🔄 [BACKGROUND] Generating fresh signal...');
    
    // Stagger API calls to stay under 8 calls/minute limit
    // First batch: 8 calls (time_series + RSI for all timeframes)
    console.log('📞 Making first batch of API calls (8 calls)...');
    const marketData = await twelveData.getMarketDataStaggered();

    const portfolio = database.getMechanicalPortfolio();
    const accountBalance = portfolio?.current_balance ?? 100000;
    const signal = signalEngine.generateSignal(marketData, accountBalance);
    
    // Save to database
    const signalId = database.saveSignal(signal);
    
    // Start outcome tracking
    outcomeTracker.startTracking(signalId, signal);
    
    // Check outcomes using current price
    const currentPrice = signal.currentPrice || marketData.m15?.price;
    if (currentPrice) {
      outcomeTracker.checkOutcomesWithPrice(currentPrice);
    }
    
    // Cache it
    currentSignal = signal;
    lastUpdate = Date.now();
    
    console.log(`✅ [BACKGROUND] Signal cached: ${signal.signal}`);
  } catch (error) {
    console.error('❌ [BACKGROUND] Error generating signal:', error.message);
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current signal (returns cached data - NO API calls)
app.get('/api/signal', async (req, res) => {
  try {
    // Check if within trading hours
    if (!isTradingHours()) {
      return res.json({
        signal: 'CLOSED',
        message: 'Outside trading hours (11:00-15:00 & 17:00-21:00 UAE time)',
        nextTradingTime: getNextTradingTime(),
        timestamp: new Date().toISOString()
      });
    }

    // Return cached signal (no fresh API calls)
    if (currentSignal && lastUpdate) {
      const age = Math.floor((Date.now() - lastUpdate) / 1000);
      return res.json({
        ...currentSignal,
        cached: true,
        age
      });
    }

    // No signal yet (shouldn't happen after background job starts)
    return res.json({
      signal: 'PENDING',
      message: 'Waiting for first signal generation...',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching signal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force refresh endpoint removed - background job handles signal generation

// Get signal history
app.get('/api/signals/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const signals = database.getRecentSignals(limit);
    res.json({ signals });
  } catch (error) {
    console.error('Error fetching signal history:', error);
    res.status(500).json({ 
      error: 'Failed to fetch history', 
      message: error.message 
    });
  }
});

// Save a trade
app.post('/api/trades', (req, res) => {
  try {
    const tradeId = database.saveTrade({
      signal_id: req.body.signal_id,
      timestamp: req.body.timestamp || new Date().toISOString(),
      direction: req.body.direction,
      entry_price: req.body.entry_price,
      lot_size: req.body.lot_size,
      stop_loss: req.body.stop_loss,
      take_profit: req.body.take_profit,
      notes: req.body.notes
    });
    
    res.json({ success: true, tradeId });
  } catch (error) {
    console.error('Error saving trade:', error);
    res.status(500).json({ 
      error: 'Failed to save trade', 
      message: error.message 
    });
  }
});

// Update trade exit
app.put('/api/trades/:id/exit', (req, res) => {
  try {
    database.updateTradeExit(req.params.id, {
      exit_price: req.body.exit_price,
      exit_timestamp: req.body.exit_timestamp || new Date().toISOString(),
      exit_reason: req.body.exit_reason,
      pnl: req.body.pnl
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating trade:', error);
    res.status(500).json({ 
      error: 'Failed to update trade', 
      message: error.message 
    });
  }
});

// Get trades
app.get('/api/trades', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const trades = database.getRecentTrades(limit);
    res.json({ trades });
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ 
      error: 'Failed to fetch trades', 
      message: error.message 
    });
  }
});

// Get today's stats
app.get('/api/stats/today', (req, res) => {
  try {
    const stats = database.getTodayStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch stats', 
      message: error.message 
    });
  }
});

// Get signal performance stats
app.get('/api/stats/performance', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const performance = database.getSignalPerformance(days);
    res.json(performance);
  } catch (error) {
    console.error('Error fetching performance:', error);
    res.status(500).json({ 
      error: 'Failed to fetch performance', 
      message: error.message 
    });
  }
});

// Export all signals data (for data analysis)
app.get('/api/export-all', async (req, res) => {
  try {
    const signals = database.getAllSignals(); // We'll need to add this method to database.js
    res.json({ count: signals.length, data: signals });
  } catch (error) {
    console.error('Error exporting signals:', error);
    res.status(500).json({ 
      error: 'Failed to export signals', 
      message: error.message 
    });
  }
});

// Update account balance
app.post('/api/account/update', (req, res) => {
  try {
    const { date, balance, dailyPnl, tradesCount, winRate } = req.body;
    
    database.updateAccountSnapshot(
      date || new Date().toISOString().split('T')[0],
      balance,
      dailyPnl || 0,
      tradesCount || 0,
      winRate || 0
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(500).json({ 
      error: 'Failed to update account', 
      message: error.message 
    });
  }
});

// Get account history
app.get('/api/account/history', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = database.getAccountHistory(days);
    res.json({ history });
  } catch (error) {
    console.error('Error fetching account history:', error);
    res.status(500).json({ 
      error: 'Failed to fetch history', 
      message: error.message 
    });
  }
});

// ===== AUTOCHARTIST PATTERNS ENDPOINTS =====

// Get all logged Autochartist patterns
app.get('/api/autochartist/patterns', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const patterns = database.getAutochartistPatterns(limit);
    res.json({ patterns });
  } catch (error) {
    console.error('Error fetching Autochartist patterns:', error);
    res.status(500).json({ 
      error: 'Failed to fetch patterns', 
      message: error.message 
    });
  }
});

// Log a new Autochartist pattern
app.post('/api/autochartist/patterns', async (req, res) => {
  try {
    const { patternType, timeframe, timeIdentified, entryPrice, stopLoss, target, successProbability } = req.body;

    // Get current price from latest signal
    let currentPrice = null;
    let ourSignal = null;
    
    if (currentSignal) {
      currentPrice = currentSignal.currentPrice || currentSignal.marketData?.m15?.price;
      ourSignal = currentSignal.signal;
    }

    const patternData = {
      patternType,
      timeframe,
      timeIdentified,
      entryPrice,
      stopLoss,
      target,
      successProbability,
      currentPrice,
      ourSignal
    };

    const patternId = database.saveAutochartistPattern(patternData);
    
    res.json({ 
      success: true, 
      patternId,
      message: 'Pattern logged successfully'
    });
  } catch (error) {
    console.error('Error logging Autochartist pattern:', error);
    res.status(500).json({ 
      error: 'Failed to log pattern', 
      message: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 GOLD TRADER BACKEND STARTED');
  console.log('='.repeat(50));
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔑 API Key configured: ${process.env.TWELVE_DATA_API_KEY ? 'YES' : 'NO'}`);
  console.log(`⏰ Trading window: 16:30–20:30 UAE (4 h, NY session, Mon–Fri)`);
  console.log(`🔄 Signal cron: every 8 min → ~30 cycles × 12 calls = 360 calls/day`);
  console.log(`📡 Price poller: every 2 min → ~120 checks × 1 call  = 120 calls/day`);
  console.log(`📊 Projected daily total: ~480 calls  (budget: 800, headroom: ~320)`);
  console.log('='.repeat(50) + '\n');
  
  // Start background signal generation
  startBackgroundSignalGeneration();
  startPricePoller();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  outcomeTracker.stopMonitoring();
  database.close();
  process.exit(0);
});
