import fetch from 'node-fetch';

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor() {
    this.callCount = 0;
    this.lastReset = new Date();
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

  async fetchRSI(symbol, interval, timePeriod = 14) {
    const url = `${BASE_URL}/rsi?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: RSI ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return parseFloat(data.values?.[0]?.rsi || 0);
    } catch (error) {
      console.error('Error fetching RSI:', error.message);
      throw error;
    }
  }

  async fetchMACD(symbol, interval) {
    const url = `${BASE_URL}/macd?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&fast_period=12&slow_period=26&signal_period=9`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: MACD ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      const latest = data.values?.[0] || {};
      return {
        macd: parseFloat(latest.macd || 0),
        signal: parseFloat(latest.macd_signal || 0),
        histogram: parseFloat(latest.macd_hist || 0)
      };
    } catch (error) {
      console.error('Error fetching MACD:', error.message);
      throw error;
    }
  }

  async fetchMFI(symbol, interval, timePeriod = 14) {
    const url = `${BASE_URL}/mfi?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: MFI ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return parseFloat(data.values?.[0]?.mfi || 0);
    } catch (error) {
      console.error('Error fetching MFI:', error.message);
      throw error;
    }
  }

  async fetchAllIndicators(symbol, interval) {
    try {
      console.log(`\n📊 Fetching indicators for ${symbol} ${interval}...`);
      
      const [timeSeries, rsi, macd, mfi] = await Promise.all([
        this.fetchTimeSeries(symbol, interval, 2),
        this.fetchRSI(symbol, interval),
        this.fetchMACD(symbol, interval),
        this.fetchMFI(symbol, interval)
      ]);

      const latestCandle = timeSeries.values?.[0] || {};
      
      return {
        interval,
        price: parseFloat(latestCandle.close || 0),
        timestamp: latestCandle.datetime,
        rsi,
        macd: macd.macd,
        macd_signal: macd.signal,
        macd_hist: macd.histogram,
        mfi
      };
    } catch (error) {
      console.error(`Error fetching all indicators for ${interval}:`, error.message);
      throw error;
    }
  }

  async getMarketData(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting market data fetch...\n');
    
    try {
      const [h4, h1, m30, m15] = await Promise.all([
        this.fetchAllIndicators(symbol, '4h'),
        this.fetchAllIndicators(symbol, '1h'),
        this.fetchAllIndicators(symbol, '30min'),
        this.fetchAllIndicators(symbol, '15min')
      ]);

      console.log(`\n✅ Market data fetched successfully`);
      console.log(`📞 Total API calls: ${this.callCount}`);
      
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
