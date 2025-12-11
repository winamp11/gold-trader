import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import twelveData from './twelveData.js';
import signalEngine from './signalEngine.js';
import database from './database.js';
import outcomeTracker from './outcomeTracker.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Store current signal in memory
let currentSignal = null;
let lastUpdate = null;

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current signal
app.get('/api/signal', async (req, res) => {
  try {
    if (currentSignal && lastUpdate && (Date.now() - lastUpdate < 5 * 60 * 1000)) {
      // Return cached signal if less than 5 minutes old
      return res.json({
        ...currentSignal,
        cached: true,
        age: Math.floor((Date.now() - lastUpdate) / 1000)
      });
    }

    // Fetch fresh signal
    const accountBalance = parseFloat(req.query.balance) || 400;
    
    console.log('\n🔄 Generating fresh signal...');
    const marketData = await twelveData.getMarketData();
    const signal = signalEngine.generateSignal(marketData, accountBalance);
    
    // Save to database
    const signalId = database.saveSignal(signal);
    
    // Start outcome tracking
    outcomeTracker.startTracking(signalId, signal);
    
    // Cache it
    currentSignal = signal;
    lastUpdate = Date.now();
    
    res.json({
      ...signal,
      cached: false,
      age: 0
    });
    
  } catch (error) {
    console.error('Error generating signal:', error);
    res.status(500).json({ 
      error: 'Failed to generate signal', 
      message: error.message 
    });
  }
});

// Force refresh signal
app.post('/api/signal/refresh', async (req, res) => {
  try {
    const accountBalance = req.body.balance || 400;
    
    console.log('\n🔄 Force refresh requested...');
    const marketData = await twelveData.getMarketData();
    const signal = signalEngine.generateSignal(marketData, accountBalance);
    
    const signalId = database.saveSignal(signal);
    outcomeTracker.startTracking(signalId, signal);
    
    currentSignal = signal;
    lastUpdate = Date.now();
    
    res.json({
      ...signal,
      cached: false,
      age: 0
    });
    
  } catch (error) {
    console.error('Error refreshing signal:', error);
    res.status(500).json({ 
      error: 'Failed to refresh signal', 
      message: error.message 
    });
  }
});

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

// Start server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 GOLD TRADER BACKEND STARTED');
  console.log('='.repeat(50));
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔑 API Key configured: ${process.env.TWELVE_DATA_API_KEY ? 'YES' : 'NO'}`);
  console.log('='.repeat(50) + '\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  outcomeTracker.stopMonitoring();
  database.close();
  process.exit(0);
});
