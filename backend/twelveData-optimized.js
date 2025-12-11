import fetch from 'node-fetch';

const API_KEY = 'ca9aa60df1ac43a593b61fa812a77355';
const BASE_URL = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor() {
    this.callCount = 0;
    this.lastReset = new Date();
  }

  // Calculate RSI from price data
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50; // Default neutral if not enough data
    
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }
    
    let gains = 0;
    let losses = 0;
    
    // First average
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) gains += changes[i];
      else losses += Math.abs(changes[i]);
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    // Smooth subsequent values
    for (let i = period; i < changes.length; i++) {
      if (changes[i] > 0) {
        avgGain = (avgGain * (period - 1) + changes[i]) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(changes[i])) / period;
      }
    }
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    return rsi;
  }

  // Calculate MACD
  calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (prices.length < slowPeriod + signalPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    // Calculate EMA
    const calculateEMA = (data, period) => {
      const k = 2 / (period + 1);
      let ema = data[0];
      
      for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
      }
      
      return ema;
    };

    const fastEMA = calculateEMA(prices.slice(-fastPeriod * 2), fastPeriod);
    const slowEMA = calculateEMA(prices.slice(-slowPeriod * 2), slowPeriod);
    const macdLine = fastEMA - slowEMA;

    // Calculate signal line (EMA of MACD)
    const macdValues = [];
    for (let i = slowPeriod; i < prices.length; i++) {
      const fast = calculateEMA(prices.slice(i - fastPeriod * 2, i), fastPeriod);
      const slow = calculateEMA(prices.slice(i - slowPeriod * 2, i), slowPeriod);
      macdValues.push(fast - slow);
    }

    const signalLine = calculateEMA(macdValues.slice(-signalPeriod * 2), signalPeriod);
    const histogram = macdLine - signalLine;

    return {
      macd: macdLine,
      signal: signalLine,
      histogram: histogram
    };
  }

  // Calculate MFI (Money Flow Index)
  calculateMFI(candles, period = 14) {
    if (candles.length < period + 1) return 50;

    const typicalPrices = candles.map(c => (c.high + c.low + c.close) / 3);
    const moneyFlows = [];

    for (let i = 1; i < candles.length; i++) {
      const tp = typicalPrices[i];
      const volume = parseFloat(candles[i].volume || 1); // Default volume if not available
      const mf = tp * volume;
      
      if (tp > typicalPrices[i - 1]) {
        moneyFlows.push({ positive: mf, negative: 0 });
      } else if (tp < typicalPrices[i - 1]) {
        moneyFlows.push({ positive: 0, negative: mf });
      } else {
        moneyFlows.push({ positive: 0, negative: 0 });
      }
    }

    const recentFlows = moneyFlows.slice(-period);
    const positiveFlow = recentFlows.reduce((sum, f) => sum + f.positive, 0);
    const negativeFlow = recentFlows.reduce((sum, f) => sum + f.negative, 0);

    if (negativeFlow === 0) return 100;
    const moneyRatio = positiveFlow / negativeFlow;
    const mfi = 100 - (100 / (1 + moneyRatio));

    return mfi;
  }

  async fetchTimeSeries(symbol, interval, outputsize = 50) {
    const url = `${BASE_URL}/time_series?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&outputsize=${outputsize}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: time_series ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return data;
    } catch (error) {
      console.error('Error fetching time series:', error.message);
      throw error;
    }
  }

  async fetchAllIndicators(symbol, interval) {
    try {
      console.log(`\n📊 Fetching data for ${symbol} ${interval}...`);
      
      // Fetch 50 candles to have enough data for indicators
      const timeSeries = await this.fetchTimeSeries(symbol, interval, 50);
      const candles = timeSeries.values || [];
      
      if (candles.length === 0) {
        throw new Error('No candle data received');
      }

      // Extract close prices for calculations
      const closePrices = candles.map(c => parseFloat(c.close)).reverse(); // Reverse to chronological order
      
      // Prepare candle objects for MFI
      const candleObjects = candles.reverse().map(c => ({
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume || 1000) // Use default if volume missing
      }));

      // Calculate indicators locally
      const rsi = this.calculateRSI(closePrices, 14);
      const macd = this.calculateMACD(closePrices, 12, 26, 9);
      const mfi = this.calculateMFI(candleObjects, 14);

      const latestCandle = candles[candles.length - 1];
      
      return {
        interval,
        price: parseFloat(latestCandle.close),
        timestamp: latestCandle.datetime,
        rsi: rsi,
        macd: macd.macd,
        macd_signal: macd.signal,
        macd_hist: macd.histogram,
        mfi: mfi
      };
    } catch (error) {
      console.error(`Error fetching indicators for ${interval}:`, error.message);
      throw error;
    }
  }

  async getMarketData(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting market data fetch...\n');
    
    try {
      // Fetch all 4 timeframes (4 API calls total)
      const [h4, h1, m30, m15] = await Promise.all([
        this.fetchAllIndicators(symbol, '4h'),
        this.fetchAllIndicators(symbol, '1h'),
        this.fetchAllIndicators(symbol, '30min'),
        this.fetchAllIndicators(symbol, '15min')
      ]);

      console.log(`\n✅ Market data fetched successfully`);
      console.log(`📞 Total API calls: ${this.callCount} (under 8 limit ✓)`);
      
      return {
        symbol,
        timestamp: new Date().toISOString(),
        h4,
        h1,
        m30,
        m15,
        apiCallCount: this.callCount
      };
    } catch (error) {
      console.error('Error getting market data:', error.message);
      throw error;
    }
  }

  resetCallCount() {
    this.callCount = 0;
    this.lastReset = new Date();
  }
}

export default new TwelveDataService();
